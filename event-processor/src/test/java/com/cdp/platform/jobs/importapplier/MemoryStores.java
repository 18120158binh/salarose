package com.cdp.platform.jobs.importapplier;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeMap;

import com.cdp.platform.shared.models.imports.DatasetVersion;
import com.cdp.platform.shared.models.imports.DatasetVersion.Kind;
import com.cdp.platform.shared.utils.JacksonMapper;

import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * In-memory stand-ins for the run store, the import store, and the drop zone,
 * which keep their state across a simulated crash the way Postgres and S3 do.
 * The import store keeps uncommitted writes apart, so a crash drops them.
 */
final class MemoryStores {

    /**
     * Every validation starts at this instant, so two harnesses read files alike.
     */
    static final Instant CLOCK = Instant.parse("2026-11-14T02:00:00Z");

    /** A process death: an Error, so no catch block in the applier handles it. */
    static final class Crash extends Error {
        Crash() {
            super("simulated crash");
        }
    }

    private MemoryStores() {
    }

    static final class Run {
        final String id;
        final String recordTypeId;
        final String source;
        final String writer;
        final String format;
        final Long byteSize;
        final String fileKey;
        final String sha256;
        final Instant confirmedAt;
        String state;
        String reason;
        ObjectNode counts;
        Instant startedAt;
        boolean approved;

        Run(String id, String recordTypeId, String source, String writer, String format, Long byteSize,
            String fileKey, String sha256, Instant confirmedAt) {
            this.id = id;
            this.recordTypeId = recordTypeId;
            this.source = source;
            this.writer = writer;
            this.format = format;
            this.byteSize = byteSize;
            this.fileKey = fileKey;
            this.sha256 = sha256;
            this.confirmedAt = confirmedAt;
            this.state = OpenRun.QUEUED;
        }
    }

    static final class Runs implements RunStore {
        final Map<String, Run> runs = new LinkedHashMap<>();
        final Map<String, DatasetVersion> versions = new HashMap<>();
        boolean crashOnMarkApplied;

        private boolean move(String id, String from, String to) {
            Run run = runs.get(id);
            if (run == null || !run.state.equals(from)) return false;
            run.state = to;
            return true;
        }

        @Override
        public List<Stranded> stranded() {
            return runs
                .values()
                .stream()
                .filter(run -> run.state.equals("validating") || run.state.equals("applying"))
                .map(run -> new Stranded(run.id, run.state, run.approved))
                .toList();
        }

        @Override
        public boolean reset(Stranded run) {
            return move(run.id(), run.state(), run.approved() ? OpenRun.APPROVED : OpenRun.QUEUED);
        }

        @Override
        public boolean markApplied(String runId, ObjectNode counts) {
            if (crashOnMarkApplied) {
                crashOnMarkApplied = false;
                throw new Crash();
            }
            boolean moved = move(runId, "applying", "applied");
            if (moved) runs.get(runId).counts = counts;
            return moved;
        }

        @Override
        public int expireUploads() {
            return 0;
        }

        @Override
        public List<OpenRun> openRuns() {
            return runs
                .values()
                .stream()
                .filter(run -> List
                    .of(OpenRun.QUEUED, OpenRun.APPROVED, OpenRun.QUARANTINED, OpenRun.FAILED)
                    .contains(run.state))
                .map(run -> new OpenRun(run.id, run.recordTypeId, run.state, run.source, run.writer, run.format,
                    run.byteSize, run.fileKey, run.sha256, run.confirmedAt))
                .toList();
        }

        @Override
        public DatasetVersion currentVersion(String recordTypeId) {
            return versions.get(recordTypeId);
        }

        @Override
        public Optional<Instant> startValidating(OpenRun open, int version) {
            if (!move(open.id(), open.state(), "validating")) return Optional.empty();
            runs.get(open.id()).startedAt = CLOCK;
            runs.get(open.id()).reason = null;
            return Optional.of(CLOCK);
        }

        @Override
        public boolean quarantine(String runId, String reason, ObjectNode counts) {
            boolean moved = move(runId, "validating", OpenRun.QUARANTINED);
            if (moved) {
                runs.get(runId).reason = reason;
                runs.get(runId).counts = counts;
            }
            return moved;
        }

        @Override
        public boolean startApplying(String runId) {
            return move(runId, "validating", "applying");
        }

        @Override
        public boolean fail(String runId, String reason) {
            boolean moved = move(runId, "applying", OpenRun.FAILED);
            if (moved) runs.get(runId).reason = reason;
            return moved;
        }

        @Override
        public boolean abandon(String runId, String waitedAt) {
            return move(runId, "validating", waitedAt);
        }

        @Override
        public List<AppliedRun> appliedRuns(String recordTypeId) {
            return runs
                .values()
                .stream()
                .filter(run -> run.recordTypeId.equals(recordTypeId) && run.state.equals("applied")
                    && !run.source.equals("rederive"))
                .sorted((a, b) -> a.confirmedAt.compareTo(b.confirmedAt))
                .map(run -> new AppliedRun(run.id, run.source, run.writer, run.format, run.byteSize, run.fileKey,
                    run.sha256, run.startedAt))
                .toList();
        }

        @Override
        public Long lastSnapshotValid(String recordTypeId) {
            return runs
                .values()
                .stream()
                .filter(run -> run.recordTypeId.equals(recordTypeId) && run.state.equals("applied")
                    && (run.source.equals("api") || run.source.equals("drop"))
                    && versions.get(recordTypeId).deliveryMode() == DatasetVersion.DeliveryMode.SNAPSHOT)
                .reduce((a, b) -> b)
                .map(run -> run.counts.get("valid").asLong())
                .orElse(null);
        }

        @Override
        public Set<String> tombstones() {
            return Set.of();
        }

        /** Studio's approve action. */
        void approve(String runId) {
            if (move(runId, OpenRun.QUARANTINED, OpenRun.APPROVED)) runs.get(runId).approved = true;
        }
    }

    /** A stored row with the writer and run that last wrote it. */
    record Kept(String customerKey, Instant eventTime, Instant updatedAt, String data, String writer,
        String runId) {
    }

    /** The import store's tables, keyed by type and key. */
    record Tables(Map<String, Kept> records, Map<String, Kept> profiles, Map<String, List<String>> identifiers,
        Map<String, String> markers) {

        static Tables empty() {
            return new Tables(new TreeMap<>(), new TreeMap<>(), new TreeMap<>(), new TreeMap<>());
        }

        Tables copy() {
            Map<String, List<String>> ids = new TreeMap<>();
            identifiers.forEach((key, values) -> ids.put(key, new ArrayList<>(values)));
            return new Tables(new TreeMap<>(records), new TreeMap<>(profiles), ids, new TreeMap<>(markers));
        }

        /** The rows, without the commit markers, for comparing two stores. */
        String rows() {
            return "records=" + records + "\nprofiles=" + profiles + "\nidentifiers=" + identifiers;
        }
    }

    static final class Store implements ImportStore {
        Tables committed = Tables.empty();
        private Tables open;
        private final Set<String> kept = new HashSet<>();
        /** Writes that reached the store, committed or not. */
        int writes;
        /**
         * Throws {@link Crash} on the write after this many, or never when negative.
         */
        int crashAfterWrites = -1;

        private Tables tables() {
            return open != null ? open : committed;
        }

        private Map<String, Kept> table(Kind kind) {
            return kind == Kind.EVENT ? tables().records() : tables().profiles();
        }

        @Override
        public void begin() {
            open = committed.copy();
            kept.clear();
        }

        @Override
        public Map<String, Stored> stored(Kind kind, String recordTypeId, Collection<String> keys) {
            Map<String, Stored> found = new HashMap<>();
            for (String key : keys) {
                Kept row = table(kind).get(recordTypeId + "/" + key);
                if (row != null) {
                    found.put(key, new Stored((ObjectNode) JacksonMapper.readTree(row.data()), row.writer()));
                }
            }
            return found;
        }

        @Override
        public void write(Kind kind, String recordTypeId, List<Row> rows, String writer, String runId) {
            if (crashAfterWrites >= 0 && writes >= crashAfterWrites) throw new Crash();
            writes++;
            for (Row row : rows) {
                String id = recordTypeId + "/" + row.key();
                table(kind)
                    .put(id, new Kept(row.customerKey(), row.eventTime(), row.updatedAt(),
                        JacksonMapper.writeValueAsString(row.data()), writer, runId));
                if (kind == Kind.PROFILE) {
                    List<String> ids = new ArrayList<>();
                    row.emails().forEach(email -> ids.add("email:" + email + "@" + writer));
                    row.phones().forEach(phone -> ids.add("phone:" + phone + "@" + writer));
                    tables().identifiers().put(id, ids);
                }
            }
        }

        @Override
        public void remove(Kind kind, String recordTypeId, Collection<String> keys) {
            for (String key : keys) {
                table(kind).remove(recordTypeId + "/" + key);
                tables().identifiers().remove(recordTypeId + "/" + key);
            }
        }

        @Override
        public void keep(Collection<String> keys) {
            kept.addAll(keys);
        }

        @Override
        public long removeUnkept(Kind kind, String recordTypeId, String spared) {
            List<String> gone = table(kind)
                .entrySet()
                .stream()
                .filter(entry -> entry.getKey().startsWith(recordTypeId + "/"))
                .filter(entry -> !entry.getValue().writer().equals(spared))
                .map(Map.Entry::getKey)
                .filter(id -> !kept.contains(id.substring(recordTypeId.length() + 1)))
                .toList();
            gone.forEach(id -> {
                table(kind).remove(id);
                tables().identifiers().remove(id);
            });
            kept.clear();
            return gone.size();
        }

        @Override
        public void clear(String recordTypeId) {
            tables().records().keySet().removeIf(id -> id.startsWith(recordTypeId + "/"));
            tables().profiles().keySet().removeIf(id -> id.startsWith(recordTypeId + "/"));
            tables().identifiers().keySet().removeIf(id -> id.startsWith(recordTypeId + "/"));
        }

        @Override
        public long records() {
            return tables().records().size();
        }

        @Override
        public void commit(String runId, String recordTypeId, ObjectNode counts) throws SQLException {
            if (open.markers().containsKey(runId)) throw new SQLException("duplicate commit marker");
            open.markers().put(runId, JacksonMapper.writeValueAsString(counts));
            committed = open;
            open = null;
        }

        @Override
        public void rollback() {
            open = null;
        }

        @Override
        public Optional<ObjectNode> commitMarker(String runId) {
            String counts = committed.markers().get(runId);
            return counts == null ? Optional.empty() : Optional.of((ObjectNode) JacksonMapper.readTree(counts));
        }

        /** A crash drops the open transaction, as a dropped connection does. */
        void crashed() {
            open = null;
        }
    }

    static final class Drops implements DropZone {
        final Map<String, byte[]> objects = new HashMap<>();

        @Override
        public Optional<InputStream> open(String key) {
            byte[] bytes = objects.get(key);
            return bytes == null ? Optional.empty() : Optional.of(new ByteArrayInputStream(bytes));
        }

        @Override
        public void put(String key, byte[] body, String contentType) {
            objects.put(key, body);
        }

        @Override
        public void put(String key, Path file, String contentType) throws IOException {
            objects.put(key, Files.readAllBytes(file));
        }
    }

    /** Lookups over the committed import store, for the record cap. */
    static Lookups lookups(Store store) {
        return new Lookups() {
            @Override
            public int matchedUserIds(List<String> customerKeys) {
                return 0;
            }

            @Override
            public int storedRecordIds(String recordTypeId, List<String> recordIds) {
                return (int) recordIds
                    .stream()
                    .filter(id -> store.committed.records().containsKey(recordTypeId + "/" + id))
                    .count();
            }

            @Override
            public Shared sharedContacts(List<Contact> contacts) {
                return new Shared(0, 0);
            }

            @Override
            public long storedRecords() {
                return store.committed.records().size();
            }
        };
    }

    static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
