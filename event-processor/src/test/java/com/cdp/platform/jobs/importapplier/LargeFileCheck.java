package com.cdp.platform.jobs.importapplier;

import java.io.InputStream;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryType;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;

import com.cdp.platform.shared.models.imports.DatasetVersion;

import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Validates a generated orders CSV of the given byte size and prints its row
 * count and peak heap. {@link FileValidationTest} runs it in a JVM with a
 * capped heap for IAP-NFR-01.
 */
final class LargeFileCheck {

    private LargeFileCheck() {
    }

    static DatasetVersion orders() throws Exception {
        ObjectMapper json = new ObjectMapper();
        return DatasetVersion
            .parse("00000000-0000-0000-0000-000000000003", 1, "event",
                json
                    .readTree("[{\"name\":\"order_id\",\"type\":\"string\"},"
                        + "{\"name\":\"customer_id\",\"type\":\"string\"},"
                        + "{\"name\":\"event_time\",\"type\":\"datetime\"},{\"name\":\"amount\",\"type\":\"number\"}]"),
                json
                    .readTree(
                        "{\"customer_key\":\"customer_id\",\"record_id\":\"order_id\",\"event_time\":\"event_time\"}"),
                "incremental", "Asia/Ho_Chi_Minh", ",");
    }

    public static void main(String[] args) throws Exception {
        long size = Long.parseLong(args[0]);
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[1 << 16];
        try (InputStream in = new Generated(size)) {
            for (int n = in.read(buffer); n > 0; n = in.read(buffer)) {
                digest.update(buffer, 0, n);
            }
        }
        ValidationStats stats;
        try (InputStream in = new Generated(size)) {
            stats = FileValidationTest
                .validation()
                .validate(new FileValidation.Delivered("csv", size, HexFormat.of().formatHex(digest.digest())), in);
        }
        long peak = ManagementFactory
            .getMemoryPoolMXBeans()
            .stream()
            .filter(pool -> pool.getType() == MemoryType.HEAP)
            .mapToLong(pool -> pool.getPeakUsage().getUsed())
            .sum();
        System.out.println("rows_read=" + stats.rowsRead + " valid=" + stats.valid + " peak_heap_mib=" + (peak >> 20));
        if (stats.valid != stats.rowsRead) System.exit(2);
    }

    /** A CSV of distinct orders, padded with line ends to the exact size. */
    private static final class Generated extends InputStream {

        private final long size;
        private long position;
        private long row;
        private byte[] current = FileValidationTest.HEADER.getBytes(StandardCharsets.UTF_8);
        private int offset;

        Generated(long size) {
            this.size = size;
        }

        @Override
        public int read() {
            byte[] one = new byte[1];
            return read(one, 0, 1) < 0 ? -1 : one[0] & 0xff;
        }

        @Override
        public int read(byte[] buffer, int at, int length) {
            if (position >= size) return -1;
            int written = 0;
            while (written < length && position < size) {
                if (offset == current.length) next();
                int n = (int) Math.min(Math.min(length - written, current.length - offset), size - position);
                System.arraycopy(current, offset, buffer, at + written, n);
                offset += n;
                written += n;
                position += n;
            }
            return written;
        }

        private void next() {
            row++;
            String line = "o-%d,c-%d,2026-11-07T08:00:00Z,%d\r\n".formatted(row, row % 100_000, row);
            current = (size - position > 64 ? line : "\n").getBytes(StandardCharsets.UTF_8);
            offset = 0;
        }
    }
}
