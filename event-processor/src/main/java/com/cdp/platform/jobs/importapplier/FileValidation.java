package com.cdp.platform.jobs.importapplier;

import java.io.EOFException;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.PushbackInputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.zip.GZIPInputStream;
import java.util.zip.ZipException;

import com.cdp.platform.shared.models.imports.DatasetVersion;
import com.cdp.platform.shared.models.imports.DatasetVersion.Kind;

/**
 * Reads one delivered file, validates every row, and counts what the report
 * needs, in one streaming pass (IAP-NFR-01). The file's size and SHA-256 are
 * taken from the bytes as read, so a mismatch wins over any other failure:
 * a file that is not the one delivered tells nothing about the shop's export.
 */
final class FileValidation {

    static final int LOOKUP_BATCH = 1000;

    /** What a run's file was delivered as, from its {@code import_runs} row. */
    record Delivered(String format, long byteSize, String sha256) {
    }

    private final DatasetVersion version;
    private final RowValidator validator;
    private final Lookups lookups;
    private final RejectsSink rejects;
    private final RowSink validRows;
    private final LockGuard lock;

    /**
     * @param validRows
     *            receives each valid row, and the key of each rejected row, in
     *            file order
     */
    FileValidation(DatasetVersion version, RowValidator validator, Lookups lookups, RejectsSink rejects,
        RowSink validRows, LockGuard lock) {
        this.version = version;
        this.validator = validator;
        this.lookups = lookups;
        this.rejects = rejects;
        this.validRows = validRows;
        this.lock = lock;
    }

    /**
     * Validates the file. The input is closed by the caller.
     *
     * @throws FileFailure
     *             on a file-level failure, after the file has been read to its end
     */
    ValidationStats validate(Delivered delivered, InputStream file) throws IOException, FileFailure {
        Hashing hashing = new Hashing(file);
        ValidationStats stats = new ValidationStats();
        FileFailure failure = null;
        try {
            read(delivered, hashing, stats);
        } catch (FileFailure e) {
            failure = e;
        }
        hashing.drain();
        if (hashing.count != delivered.byteSize() || !hashing.hex().equals(delivered.sha256())) {
            throw new FileFailure(FileFailure.CHECKSUM_MISMATCH);
        }
        if (failure != null) throw failure;
        return stats;
    }

    private void read(Delivered delivered, InputStream file, ValidationStats stats) throws IOException, FileFailure {
        PushbackInputStream peek = new PushbackInputStream(file, 2);
        byte[] magic = peek.readNBytes(2);
        peek.unread(magic);
        InputStream text = peek;
        try {
            if (magic.length == 2 && (magic[0] & 0xff) == 0x1f && (magic[1] & 0xff) == 0x8b) {
                text = new GZIPInputStream(peek, 1 << 16);
            }
            String format = delivered.format().endsWith(".gz")
                ? delivered.format().substring(0, delivered.format().length() - 3)
                : delivered.format();
            FileRows rows = FileRows.open(version, format, text);
            Batches batches = new Batches(stats);
            for (RawRow row = rows.next(); row != null; row = rows.next()) {
                stats.rowsRead++;
                if (stats.rowsRead % 10_000 == 0) lock.check();
                switch (validator.validate(row)) {
                    case RowValidator.Rejected rejected -> {
                        stats.reject(row.line(), rejected.reason());
                        rejects.write(row.line(), rejected.reason(), row.raw());
                        validRows.rejected(validator.key(row));
                    }
                    case RowValidator.Valid valid -> {
                        stats.valid++;
                        stats.emailsDropped += valid.emailsDropped();
                        stats.phonesDropped += valid.phonesDropped();
                        batches.add(valid);
                        validRows.valid(valid);
                    }
                }
            }
            if (!format.equals("csv")) {
                List<String> missing = rows.missingRoles();
                if (!missing.isEmpty()) throw new FileFailure(missing);
            }
            batches.flush();
        } catch (ZipException | EOFException e) {
            throw new FileFailure(FileFailure.FORMAT_INVALID);
        }
    }

    /**
     * Groups the lookups the report needs, so each costs one query per batch of
     * rows.
     */
    private final class Batches {

        private final ValidationStats stats;
        private final SeenKeys distinctKeys = new SeenKeys();
        private final List<String> newKeys = new ArrayList<>();
        private final List<String> recordIds = new ArrayList<>();
        private final List<Lookups.Contact> contacts = new ArrayList<>();

        Batches(ValidationStats stats) {
            this.stats = stats;
        }

        void add(RowValidator.Valid row) {
            if (distinctKeys.add(row.customerKey())) {
                stats.distinctKeys++;
                newKeys.add(row.customerKey());
            }
            if (version.kind() == Kind.EVENT) {
                recordIds.add(row.recordId());
            } else {
                row.emails().forEach(email -> contacts.add(new Lookups.Contact(row.customerKey(), "email", email)));
                row.phones().forEach(phone -> contacts.add(new Lookups.Contact(row.customerKey(), "phone", phone)));
            }
            if (newKeys.size() >= LOOKUP_BATCH || recordIds.size() >= LOOKUP_BATCH
                || contacts.size() >= LOOKUP_BATCH) {
                flush();
            }
        }

        void flush() {
            if (!newKeys.isEmpty()) stats.matchedKeys += lookups.matchedUserIds(newKeys);
            if (!recordIds.isEmpty()) {
                stats.newRecords += recordIds.size() - lookups.storedRecordIds(version.recordTypeId(), recordIds);
            }
            if (!contacts.isEmpty()) {
                Lookups.Shared shared = lookups.sharedContacts(contacts);
                stats.emailsShared += shared.emails();
                stats.phonesShared += shared.phones();
            }
            newKeys.clear();
            recordIds.clear();
            contacts.clear();
        }
    }

    /** Counts and hashes the bytes as delivered, before any decompression. */
    private static final class Hashing extends FilterInputStream {

        private final MessageDigest digest;
        private long count;

        Hashing(InputStream in) {
            super(in);
            try {
                digest = MessageDigest.getInstance("SHA-256");
            } catch (NoSuchAlgorithmException e) {
                throw new IllegalStateException(e);
            }
        }

        @Override
        public int read() throws IOException {
            int b = in.read();
            if (b >= 0) {
                digest.update((byte) b);
                count++;
            }
            return b;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            int n = in.read(buffer, offset, length);
            if (n > 0) {
                digest.update(buffer, offset, n);
                count += n;
            }
            return n;
        }

        @Override
        public long skip(long n) throws IOException {
            byte[] buffer = new byte[8192];
            long skipped = 0;
            while (skipped < n) {
                int read = read(buffer, 0, (int) Math.min(buffer.length, n - skipped));
                if (read < 0) break;
                skipped += read;
            }
            return skipped;
        }

        @Override
        public boolean markSupported() {
            return false;
        }

        void drain() throws IOException {
            byte[] buffer = new byte[1 << 16];
            while (read(buffer, 0, buffer.length) >= 0) {
                // Hash the rest of the file.
            }
        }

        String hex() {
            return HexFormat.of().formatHex(digest.digest());
        }
    }
}
