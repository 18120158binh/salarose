package com.cdp.platform.jobs.importapplier;

import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import com.cdp.platform.shared.models.imports.DatasetVersion;

import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The import applier: a batch process with no Flink, run by a Kubernetes
 * CronJob every 10 minutes. It takes the applier lock, recovers runs a crash
 * left behind, expires abandoned uploads, drains the queue, and exits
 * (docs/internal/architecture/components/import-applier.md, Take a run).
 */
public final class ImportApplierMain {

    private static final Logger LOG = LoggerFactory.getLogger(ImportApplierMain.class);

    private ImportApplierMain() {
    }

    public static void main(String[] args) throws Exception {
        ApplierConfig config = ApplierConfig.fromEnvironment();
        LOG.info("import applier starting with {}", config);
        try (Connection main = DriverManager
            .getConnection(config.main().jdbcUrl(), config.main().user(),
                config.main().password())) {
            LockGuard lock = LockGuard.tryAcquire(main);
            if (lock == null) {
                LOG.info("another applier holds the lock; exiting");
                return;
            }
            try (Connection importStore = DriverManager
                .getConnection(config.importStoreUrl(),
                    config.importStoreUser(), config.importStorePassword())) {
                run(config, main, importStore, lock);
            }
        }
    }

    private static void run(ApplierConfig config, Connection main, Connection importStore, LockGuard lock)
        throws Exception {
        RunStore runs = new PostgresRunStore(main, lock);
        ImportStore store = new PostgresImportStore(importStore);
        recover(runs, store);
        int expired = runs.expireUploads();
        if (expired > 0) LOG.info("expired {} runs whose upload never arrived", expired);
        RunProcessor processor = new RunProcessor(runs, new PostgresLookups(main, importStore), store,
            new S3DropZone(config.bucket()), config, new Tombstones(config.tombstoneKey(), runs.tombstones()), lock);
        drain(runs, processor);
    }

    /**
     * IAP-FR-24, and IAP-FR-15's recovery: the lock proves no other instance works
     * on these runs.
     */
    static void recover(RunStore runs, ImportStore store) throws SQLException {
        for (RunStore.Stranded run : runs.stranded()) {
            Optional<ObjectNode> marker = run.state().equals("applying")
                ? store.commitMarker(run.id())
                : Optional.empty();
            boolean moved = marker.isPresent() ? runs.markApplied(run.id(), marker.get()) : runs.reset(run);
            LOG
                .info("recovered run {} from {} to {} (moved: {})", run.id(), run.state(),
                    marker.isPresent() ? "applied" : run.approved() ? "approved" : "queued", moved);
        }
    }

    /**
     * Takes runs until no type has one to take, one run of a type at a time
     * (IAP-FR-01). A type whose run was left where it waited, or whose version
     * could not be read, is done for this start, so each start ends.
     */
    static void drain(RunStore runs, RunProcessor processor) throws Exception {
        Set<String> doneTypes = new HashSet<>();
        Map<String, DatasetVersion> versions = new HashMap<>();
        while (true) {
            List<OpenRun> open = runs
                .openRuns()
                .stream()
                .filter(run -> !doneTypes.contains(run.recordTypeId()))
                .toList();
            for (OpenRun run : open) {
                if (versions.containsKey(run.recordTypeId()) || doneTypes.contains(run.recordTypeId())) continue;
                try {
                    versions.put(run.recordTypeId(), runs.currentVersion(run.recordTypeId()));
                } catch (IllegalArgumentException e) {
                    LOG.warn("dataset {} has an unreadable current version: {}", run.recordTypeId(), e.getMessage());
                    doneTypes.add(run.recordTypeId());
                }
            }
            List<OpenRun> next = RunQueue
                .next(
                    open.stream().filter(run -> !doneTypes.contains(run.recordTypeId())).toList(),
                    type -> versions.get(type).ordered());
            if (next.isEmpty()) return;
            for (OpenRun run : next) {
                RunProcessor.Outcome outcome = processor.process(run, versions.get(run.recordTypeId()));
                if (outcome == RunProcessor.Outcome.LEFT) doneTypes.add(run.recordTypeId());
            }
        }
    }
}
