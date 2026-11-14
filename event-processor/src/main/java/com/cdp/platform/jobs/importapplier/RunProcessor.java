package com.cdp.platform.jobs.importapplier;

import java.io.IOException;
import java.io.InputStream;
import java.sql.SQLException;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;

import com.cdp.platform.shared.batch.LockGuard;
import com.cdp.platform.shared.batch.Tombstones;
import com.cdp.platform.shared.models.imports.DatasetVersion;
import com.cdp.platform.shared.models.imports.DatasetVersion.DeliveryMode;
import com.cdp.platform.shared.utils.JacksonMapper;

import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Takes one run through Read the file, Validate each row, Decide whether to
 * apply, Apply, and Report, or one re-derive through Re-derive. Validation
 * reads the file and writes nothing. A run that passes moves to
 * {@code applying}, and a second pass over the file writes its rows and its
 * commit marker in one import store transaction (IAP-FR-15). Logs carry run
 * ids, counts, and reasons, never a row value or a customer key (IAP-NFR-04).
 */
final class RunProcessor {

    private static final Logger LOG = LoggerFactory.getLogger(RunProcessor.class);

    // The apply pass counts nothing for the report, so it looks nothing up.
    private static final Lookups NO_LOOKUPS = new Lookups() {
        @Override
        public int matchedUserIds(List<String> customerKeys) {
            return 0;
        }

        @Override
        public int storedRecordIds(String recordTypeId, List<String> recordIds) {
            return 0;
        }

        @Override
        public Shared sharedContacts(List<Contact> contacts) {
            return new Shared(0, 0);
        }

        @Override
        public long storedRecords() {
            return 0;
        }
    };

    enum Outcome {
        /**
         * Held for review. The type's next run may follow when the type is not ordered.
         */
        QUARANTINED,
        /**
         * Its records and commit marker are in the store, and the run is
         * {@code applied}.
         */
        APPLIED,
        /** Apply failed and rolled back. The run is {@code failed}. */
        FAILED,
        /** Not taken: another actor changed the run, or validation broke off. */
        LEFT
    }

    private final RunStore runs;
    private final Lookups lookups;
    private final ImportStore store;
    private final DropZone dropZone;
    private final ApplierConfig config;
    private final Tombstones tombstones;
    private final Contacts contacts;
    private final LockGuard lock;

    RunProcessor(RunStore runs, Lookups lookups, ImportStore store, DropZone dropZone, ApplierConfig config,
        Tombstones tombstones, LockGuard lock) {
        this.runs = runs;
        this.lookups = lookups;
        this.store = store;
        this.dropZone = dropZone;
        this.config = config;
        this.tombstones = tombstones;
        this.contacts = new Contacts(config.phoneCountry());
        this.lock = lock;
    }

    Outcome process(OpenRun run, DatasetVersion version) throws SQLException, IOException {
        return run.source().equals("rederive") ? rederive(run, version) : deliver(run, version);
    }

    private Outcome deliver(OpenRun run, DatasetVersion version) throws SQLException, IOException {
        Optional<Instant> started = runs.startValidating(run, version.version());
        if (started.isEmpty()) {
            LOG.info("run {} left {} before the applier took it", run.id(), run.state());
            return Outcome.LEFT;
        }
        File file = new File(run.format(), run.byteSize(), run.fileKey(), run.storedSha256());
        ObjectNode counts;
        List<String> conditions;
        ValidationStats stats;
        try (RejectsFile rejects = new RejectsFile()) {
            try {
                stats = read(file, version, started.get(), rejects, lookups, row -> {
                });
            } catch (FileFailure failure) {
                ObjectNode failed = RunReport.failedCounts();
                writeReport(run.id(), version, failed, List.of(), failure.reasons(), null);
                boolean moved = runs.quarantine(run.id(), String.join(", ", failure.reasons()), failed);
                LOG
                    .info("run {} quarantined by a file-level failure: {} (moved: {})", run.id(),
                        failure.reasonCodes(), moved);
                return Outcome.QUARANTINED;
            }
            counts = RunReport.counts(stats);
            conditions = run.state().equals(OpenRun.APPROVED)
                ? List.of()
                : Decision
                    .conditions(stats, version, run.fromSourceKey(), runs.lastSnapshotValid(run.recordTypeId()),
                        lookups.storedRecords(), config.limits());
            dropZone.put(rejectsKey(run.id()), rejects.finish(), "application/gzip");
            if (!conditions.isEmpty()) {
                writeReport(run.id(), version, counts, conditions, List.of(), stats);
                boolean moved = runs.quarantine(run.id(), String.join(", ", conditions), counts);
                LOG.info("run {} quarantined: {}; counts {} (moved: {})", run.id(), conditions, counts, moved);
                return Outcome.QUARANTINED;
            }
        } catch (IOException | SQLException | RuntimeException e) {
            if (e instanceof LockGuard.LockLost) throw e;
            LOG.warn("run {} broke off with {}; it waits for the next start", run.id(), e.getClass().getName());
            runs.abandon(run.id(), run.state());
            return Outcome.LEFT;
        }
        if (!runs.startApplying(run.id())) {
            LOG.info("run {} left validating before apply", run.id());
            return Outcome.LEFT;
        }
        try {
            store.begin();
            RunApply apply = new RunApply(store, version, run.writer(), run.id(),
                snapshot(version, run.source()));
            read(file, version, started.get(), (line, reason, raw) -> {
            }, NO_LOOKUPS, apply);
            apply.finish().addTo(counts);
            writeReport(run.id(), version, counts, List.of(), List.of(), stats);
            store.commit(run.id(), run.recordTypeId(), counts);
        } catch (IOException | SQLException | RuntimeException | FileFailure e) {
            return failApply(run.id(), e);
        }
        boolean moved = runs.markApplied(run.id(), counts);
        LOG.info("run {} applied; counts {} (moved: {})", run.id(), counts, moved);
        return Outcome.APPLIED;
    }

    /**
     * Re-derive (IAP-FR-20): in one transaction, removes every row of the type
     * and applies each applied run of the type again, in order, with the new
     * version and each run's writer. A file-level failure or a cap breach rolls
     * it back and quarantines the re-derive run.
     */
    private Outcome rederive(OpenRun run, DatasetVersion version) throws SQLException, IOException {
        Optional<Instant> started = runs.startValidating(run, version.version());
        if (started.isEmpty()) {
            LOG.info("run {} left {} before the applier took it", run.id(), run.state());
            return Outcome.LEFT;
        }
        long rowsRead = 0;
        long valid = 0;
        Map<String, Long> byReason = new TreeMap<>();
        RunApply.Applied applied = RunApply.Applied.NONE;
        try {
            store.begin();
            store.clear(run.recordTypeId());
            for (RunStore.AppliedRun past : runs.appliedRuns(run.recordTypeId())) {
                File file = new File(past.format(), past.byteSize(), past.fileKey(), past.storedSha256());
                RunApply apply = new RunApply(store, version, past.writer(), past.id(),
                    snapshot(version, past.source()));
                ValidationStats stats;
                try {
                    stats = read(file, version, past.startedAt(), (line, reason, raw) -> {
                    }, NO_LOOKUPS, apply);
                } catch (FileFailure failure) {
                    store.rollback();
                    return quarantineRederive(run.id(), version,
                        failure.reasons().stream().map(reason -> past.id() + ": " + reason).toList());
                }
                applied = applied.plus(apply.finish());
                rowsRead += stats.rowsRead;
                valid += stats.valid;
                stats.rejectedByReason.forEach((reason, count) -> byReason.merge(reason, count, Long::sum));
            }
            if (store.records() > config.limits().recordCap()) {
                store.rollback();
                return quarantineRederive(run.id(), version, List.of(Decision.RECORD_CAP));
            }
        } catch (IOException | SQLException | RuntimeException e) {
            store.rollback();
            if (e instanceof LockGuard.LockLost) throw e;
            LOG.warn("run {} broke off with {}; it waits for the next start", run.id(), e.getClass().getName());
            runs.abandon(run.id(), run.state());
            return Outcome.LEFT;
        }
        ObjectNode counts = JsonNodeFactory.instance.objectNode();
        counts.put("rows_read", rowsRead);
        counts.put("valid", valid);
        counts.put("rejected", rowsRead - valid);
        ObjectNode reasons = counts.putObject("rejected_by_reason");
        byReason.forEach(reasons::put);
        applied.addTo(counts);
        if (!runs.startApplying(run.id())) {
            store.rollback();
            LOG.info("run {} left validating before apply", run.id());
            return Outcome.LEFT;
        }
        try {
            writeReport(run.id(), version, counts, List.of(), List.of(), null);
            store.commit(run.id(), run.recordTypeId(), counts);
        } catch (IOException | SQLException | RuntimeException e) {
            return failApply(run.id(), e);
        }
        boolean moved = runs.markApplied(run.id(), counts);
        LOG.info("re-derive {} applied; counts {} (moved: {})", run.id(), counts, moved);
        return Outcome.APPLIED;
    }

    private Outcome quarantineRederive(String runId, DatasetVersion version, List<String> reasons)
        throws SQLException, IOException {
        ObjectNode counts = RunReport.failedCounts();
        writeReport(runId, version, counts, List.of(), reasons, null);
        boolean moved = runs.quarantine(runId, String.join(", ", reasons), counts);
        LOG.info("re-derive {} rolled back and quarantined: {} (moved: {})", runId, reasons, moved);
        return Outcome.QUARANTINED;
    }

    private Outcome failApply(String runId, Exception e) throws SQLException {
        store.rollback();
        if (e instanceof LockGuard.LockLost lost) throw lost;
        String reason = rootCause(e).getClass().getName();
        boolean moved = runs.fail(runId, reason);
        LOG.warn("run {} failed to apply with {} and rolled back (moved: {})", runId, reason, moved);
        return Outcome.FAILED;
    }

    private static Throwable rootCause(Throwable e) {
        Throwable cause = e;
        while (cause.getCause() != null && cause.getCause() != cause) {
            cause = cause.getCause();
        }
        return cause;
    }

    /**
     * A snapshot type removes what its file lacks, unless studio delivered the
     * file (IAP-FR-13).
     */
    private static boolean snapshot(DatasetVersion version, String source) {
        return version.deliveryMode() == DeliveryMode.SNAPSHOT && !source.equals("studio");
    }

    /** A run's file in the drop zone, as {@code import_runs} describes it. */
    private record File(String format, Long byteSize, String key, String storedSha256) {
    }

    private ValidationStats read(File file, DatasetVersion version, Instant started, RejectsSink rejects,
        Lookups lookupsUsed, RowSink rows) throws IOException, FileFailure {
        if (file.key() == null || file.byteSize() == null || file.storedSha256() == null || file.format() == null
            || started == null) {
            throw new FileFailure(FileFailure.CHECKSUM_MISMATCH);
        }
        Optional<InputStream> input = dropZone.open(file.key());
        if (input.isEmpty()) throw new FileFailure(FileFailure.CHECKSUM_MISMATCH);
        RowValidator validator = new RowValidator(version, contacts, config.placeholders(), tombstones, started,
            config.limits().historyLimit(), config.limits().futureLimit());
        try (InputStream stream = input.get()) {
            return new FileValidation(version, validator, lookupsUsed,
                rejects, rows, lock)
                .validate(new FileValidation.Delivered(file.format(), file.byteSize(), file.storedSha256()), stream);
        }
    }

    private void writeReport(String runId, DatasetVersion version, ObjectNode counts, List<String> conditions,
        List<String> failures, ValidationStats stats) throws IOException {
        ObjectNode report = RunReport
            .report(runId, version.recordTypeId(), version.version(), counts, conditions, failures, stats);
        dropZone.put(reportKey(runId), JacksonMapper.writeValueAsBytes(report), "application/json");
    }

    static String reportKey(String runId) {
        return "imports/reports/" + runId + ".json";
    }

    static String rejectsKey(String runId) {
        return "imports/rejects/" + runId + ".ndjson.gz";
    }
}
