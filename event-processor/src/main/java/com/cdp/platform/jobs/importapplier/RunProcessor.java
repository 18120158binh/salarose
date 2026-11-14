package com.cdp.platform.jobs.importapplier;

import java.io.IOException;
import java.io.InputStream;
import java.sql.SQLException;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

import com.cdp.platform.shared.models.imports.DatasetVersion;
import com.cdp.platform.shared.utils.JacksonMapper;

import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Takes one run through Read the file, Validate each row, Decide whether to
 * apply, and Report. Apply is DI-04: a run that would apply goes back to the
 * state it waited in, with its report and counts. Logs carry run ids, counts,
 * and reasons, never a row value or a customer key (IAP-NFR-04).
 */
final class RunProcessor {

    private static final Logger LOG = LoggerFactory.getLogger(RunProcessor.class);

    enum Outcome {
        /**
         * Held for review. The type's next run may follow when the type is not ordered.
         */
        QUARANTINED,
        /** Validated and returned to the queue. The type waits for apply. */
        VALIDATED,
        /** Not taken: another actor changed the run, or validation broke off. */
        LEFT
    }

    private final RunStore runs;
    private final Lookups lookups;
    private final DropZone dropZone;
    private final ApplierConfig config;
    private final Tombstones tombstones;
    private final Contacts contacts;
    private final LockGuard lock;

    RunProcessor(RunStore runs, Lookups lookups, DropZone dropZone, ApplierConfig config, Tombstones tombstones,
        LockGuard lock) {
        this.runs = runs;
        this.lookups = lookups;
        this.dropZone = dropZone;
        this.config = config;
        this.tombstones = tombstones;
        this.contacts = new Contacts(config.phoneCountry());
        this.lock = lock;
    }

    Outcome process(OpenRun run, DatasetVersion version) throws SQLException, IOException {
        Optional<Instant> started = runs.startValidating(run, version.version());
        if (started.isEmpty()) {
            LOG.info("run {} left {} before the applier took it", run.id(), run.state());
            return Outcome.LEFT;
        }
        try (RejectsFile rejects = new RejectsFile()) {
            ValidationStats stats;
            try {
                stats = validate(run, version, started.get(), rejects);
            } catch (FileFailure failure) {
                ObjectNode counts = RunReport.failedCounts();
                writeReport(run, version, counts, List.of(), failure.reasons(), null);
                boolean moved = runs.quarantine(run.id(), String.join(", ", failure.reasons()), counts);
                LOG
                    .info("run {} quarantined by a file-level failure: {} (moved: {})", run.id(),
                        failure.getMessage(), moved);
                return Outcome.QUARANTINED;
            }
            ObjectNode counts = RunReport.counts(stats);
            List<String> conditions = run.state().equals(OpenRun.APPROVED)
                ? List.of()
                : Decision
                    .conditions(stats, version, run.fromSourceKey(), runs.lastSnapshotValid(run.recordTypeId()),
                        lookups.storedRecords(), config.limits());
            dropZone.put(rejectsKey(run.id()), rejects.finish(), "application/gzip");
            writeReport(run, version, counts, conditions, List.of(), stats);
            if (!conditions.isEmpty()) {
                boolean moved = runs.quarantine(run.id(), String.join(", ", conditions), counts);
                LOG.info("run {} quarantined: {}; counts {} (moved: {})", run.id(), conditions, counts, moved);
                return Outcome.QUARANTINED;
            }
            runs.returnToQueue(run.id(), run.state(), counts);
            LOG.info("run {} validated and back at {} until apply exists; counts {}", run.id(), run.state(), counts);
            return Outcome.VALIDATED;
        } catch (IOException | SQLException | RuntimeException e) {
            if (e instanceof LockGuard.LockLost) throw e;
            LOG.warn("run {} broke off with {}; it waits for the next start", run.id(), e.getClass().getName());
            runs.abandon(run.id(), run.state());
            return Outcome.LEFT;
        }
    }

    private ValidationStats validate(OpenRun run, DatasetVersion version, Instant started, RejectsFile rejects)
        throws IOException, FileFailure {
        if (run.fileKey() == null || run.byteSize() == null || run.storedSha256() == null || run.format() == null) {
            throw new FileFailure(FileFailure.CHECKSUM_MISMATCH);
        }
        Optional<InputStream> file = dropZone.open(run.fileKey());
        if (file.isEmpty()) throw new FileFailure(FileFailure.CHECKSUM_MISMATCH);
        RowValidator validator = new RowValidator(version, contacts, config.placeholders(), tombstones, started,
            config.limits().historyLimit(), config.limits().futureLimit());
        try (InputStream input = file.get()) {
            return new FileValidation(version, validator, lookups, rejects, valid -> {
            }, lock)
                .validate(new FileValidation.Delivered(run.format(), run.byteSize(), run.storedSha256()), input);
        }
    }

    private void writeReport(OpenRun run, DatasetVersion version, ObjectNode counts, List<String> conditions,
        List<String> failures, ValidationStats stats) throws IOException {
        ObjectNode report = RunReport
            .report(run.id(), run.recordTypeId(), version.version(), counts, conditions,
                failures, stats);
        dropZone.put(reportKey(run.id()), JacksonMapper.writeValueAsBytes(report), "application/json");
    }

    static String reportKey(String runId) {
        return "imports/reports/" + runId + ".json";
    }

    static String rejectsKey(String runId) {
        return "imports/rejects/" + runId + ".ndjson.gz";
    }
}
