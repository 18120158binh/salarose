package com.cdp.platform.jobs.importmetricpass;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Predicate;

import com.cdp.platform.jobs.importmetricpass.ImportSnapshot.Commit;
import com.cdp.platform.jobs.importmetricpass.ImportSnapshot.ProfileRow;
import com.cdp.platform.jobs.importmetricpass.PassLedger.Attempt;
import com.cdp.platform.jobs.importmetricpass.PassLedger.Dataset;
import com.cdp.platform.jobs.importmetricpass.PassLedger.Outcome;
import com.cdp.platform.jobs.importmetricpass.PassLedger.RowKey;
import com.cdp.platform.jobs.importmetricpass.PassLedger.Staged;
import com.cdp.platform.jobs.importmetricpass.PassLedger.Stored;
import com.cdp.platform.jobs.importmetricpass.PassLedger.Written;
import com.cdp.platform.shared.batch.LockGuard;
import com.cdp.platform.shared.batch.Tombstones;
import com.cdp.platform.shared.batch.WalGovernor;
import com.cdp.platform.shared.models.imports.DatasetColumn;
import com.cdp.platform.shared.models.imports.DatasetVersion;
import com.cdp.platform.shared.utils.JacksonMapper;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * One start of the import metric pass
 * (docs/internal/architecture/components/import-metric-pass.md): decide
 * whether a pass runs, compute every row in one import store snapshot, stage
 * the rows whose hash changed, end the snapshot, and publish them under the
 * WAL governor. Logs carry pass ids, counts, and pauses, never a customer key
 * or a value (IMP-NFR-05).
 */
final class MetricPass {

    private static final Logger LOG = LoggerFactory.getLogger(MetricPass.class);

    /** What a start did. */
    enum Result {
        NOTHING_TO_DO, DONE, FAILED
    }

    /** Sleeps to hold the own WAL rate, so tests can count instead of wait. */
    interface Sleeper {
        void sleep(Duration duration) throws InterruptedException;
    }

    private final PassLedger ledger;
    private final ImportSnapshot.Opener snapshots;
    private final WalGovernor governor;
    private final MetricPassSettings settings;
    private final LockGuard lock;
    private final Clock clock;
    private final Sleeper sleeper;

    MetricPass(PassLedger ledger, ImportSnapshot.Opener snapshots, WalGovernor governor, MetricPassSettings settings,
        LockGuard lock, Clock clock, Sleeper sleeper) {
        this.ledger = ledger;
        this.snapshots = snapshots;
        this.governor = governor;
        this.settings = settings;
        this.lock = lock;
        this.clock = clock;
        this.sleeper = sleeper;
    }

    /** Runs once the caller holds the pass lock (IMP-FR-02). */
    Result run() throws Exception {
        Instant now = clock.instant();
        int crashed = ledger.failRunning();
        if (crashed > 0) LOG.info("moved {} passes left at running to failed (crashed)", crashed);
        Optional<Attempt> attempt = start(settings.scheduledTime(now));
        if (attempt.isEmpty()) {
            LOG.info("no pass to run");
            return Result.NOTHING_TO_DO;
        }
        return attempt(attempt.get(), settings.deadline(now));
    }

    /** Tonight's new pass, else a requested retry that IMP-FR-18 allows. */
    private Optional<Attempt> start(Instant asOf) throws Exception {
        lock.check();
        Optional<UUID> inserted = ledger.insert(asOf);
        if (inserted.isPresent()) {
            LOG.info("pass {} started for as_of {}", inserted.get(), asOf);
            return Optional.of(new Attempt(inserted.get(), asOf));
        }
        for (Attempt retry : ledger.retryRequests()) {
            if (ledger.laterDone(retry.asOf())) {
                ledger.refuseRetry(retry.id());
                LOG.info("refused the retry of pass {}: a later pass is done", retry.id());
            } else if (ledger.startRetry(retry.id())) {
                LOG.info("pass {} retried for as_of {}", retry.id(), retry.asOf());
                return Optional.of(retry);
            }
        }
        return Optional.empty();
    }

    private Result attempt(Attempt attempt, Instant deadline) throws Exception {
        Progress progress = new Progress();
        try {
            Staging staging = compute(attempt.asOf(), progress);
            publish(attempt.id(), staging, deadline, progress);
            Outcome outcome = progress.outcome(governor.pauses());
            lock.check();
            ledger.finish(attempt.id(), outcome, staging.runIds);
            LOG.info("pass {} done: {}", attempt.id(), outcome.counts());
            return Result.DONE;
        } catch (LockGuard.LockLost lost) {
            throw lost;
        } catch (WalGovernor.DeadlineReached reached) {
            return fail(attempt.id(), "timed_out:" + reached.lastReason(), progress);
        } catch (Exception failure) {
            LOG.error("pass {} failed", attempt.id(), failure);
            return fail(attempt.id(), failure.getClass().getSimpleName(), progress);
        }
    }

    private Result fail(UUID passId, String reason, Progress progress) throws Exception {
        Outcome outcome = progress.outcome(governor.pauses());
        ledger.fail(passId, reason, outcome);
        LOG.info("pass {} failed with {}: {}", passId, reason, outcome.counts());
        return Result.FAILED;
    }

    /** The rows to write, and the runs the snapshot held. */
    record Staging(List<Staged> upserts, Map<RowKey, Stored> leftover, Set<String> customerKeys,
        List<String> runIds) {
    }

    /** Build each row, in one snapshot that ends before publishing (IMP-FR-03). */
    Staging compute(Instant asOf, Progress progress) throws Exception {
        Set<String> unreadable = new HashSet<>();
        List<Dataset> datasets = ledger.datasets(unreadable);
        Map<String, List<MetricDefinition>> byType = new HashMap<>();
        for (MetricDefinition definition : ledger.definitions()) {
            byType.computeIfAbsent(definition.recordTypeId(), type -> new ArrayList<>()).add(definition);
        }
        Map<String, Set<String>> archivedBySource = new HashMap<>();
        for (Dataset dataset : datasets) {
            Set<String> archived = new HashSet<>();
            for (MetricDefinition definition : byType.getOrDefault(dataset.id(), List.of())) {
                if (definition.archived()) archived.add(definition.name());
            }
            if (!archived.isEmpty()) archivedBySource.put(dataset.name(), archived);
        }
        Map<RowKey, Stored> stored = ledger.storedRows(archivedBySource);
        Set<String> customerKeys = new HashSet<>();
        stored.keySet().forEach(key -> customerKeys.add(key.customerKey()));
        progress.count("stored_rows", stored.size());
        List<Staged> upserts = new ArrayList<>();
        Stager stager = new Stager(stored, upserts, customerKeys, progress);
        List<String> runIds = new ArrayList<>();
        try (ImportSnapshot snapshot = snapshots.open()) {
            List<Commit> commits = snapshot.commits();
            commits.forEach(commit -> runIds.add(commit.runId()));
            progress.lastRunFinishedAt = commits
                .stream()
                .map(Commit::committedAt)
                .max(Comparator.naturalOrder());
            progress.count("runs", commits.size());
            Set<String> shared = snapshot.sharedIdentifiers();
            Set<String> sharedHeld = new HashSet<>();
            for (Dataset dataset : datasets) {
                List<MetricDefinition> definitions = byType.getOrDefault(dataset.id(), List.of());
                if (dataset.version().kind() == DatasetVersion.Kind.EVENT) {
                    events(snapshot, dataset, definitions, asOf, stored, stager, progress);
                } else {
                    snapshot
                        .profiles(dataset.id(),
                            row -> stager
                                .stage(new RowKey(row.customerKey(), dataset.name()),
                                    profileObject(row, dataset.version(), shared, sharedHeld)));
                }
            }
            progress.count("shared_values", sharedHeld.size());
        }
        progress.count("staged_rows", upserts.size());
        progress.count("unreadable_datasets", unreadable.size());
        stored.keySet().removeIf(key -> unreadable.contains(key.sourceId()));
        return new Staging(upserts, stored, customerKeys, runIds);
    }

    private void events(ImportSnapshot snapshot, Dataset dataset, List<MetricDefinition> definitions,
        Instant asOf, Map<RowKey, Stored> stored, Stager stager, Progress progress) throws Exception {
        List<MetricDefinition> active = definitions.stream().filter(definition -> !definition.archived()).toList();
        boolean carries = definitions.stream().anyMatch(MetricDefinition::archived);
        List<MetricDefinition> unusable = new ArrayList<>();
        snapshot.events(dataset.version(), active, asOf, unusable, row -> {
            RowKey key = new RowKey(row.customerKey(), dataset.name());
            ObjectNode object = JacksonMapper.instance().createObjectNode();
            row.values().forEach(object::set);
            Stored before = stored.get(key);
            if (before != null && before.archived() != null) object.setAll(before.archived());
            stager.stage(key, object);
        });
        for (MetricDefinition definition : unusable) {
            LOG
                .warn("metric {} names a column its dataset's current version lacks, so it has no value",
                    definition.id());
        }
        progress.add("unusable_metrics", unusable.size());
        if (!carries) return;
        // IMP-FR-21: a stored row that holds an archived metric's value stays, even
        // with no record left.
        List<RowKey> kept = stored
            .entrySet()
            .stream()
            .filter(entry -> entry.getKey().sourceId().equals(dataset.name()))
            .filter(entry -> entry.getValue().archived() != null && !entry.getValue().archived().isEmpty())
            .map(Map.Entry::getKey)
            .toList();
        for (RowKey key : kept) {
            stager.stage(key, stored.get(key).archived().deepCopy());
        }
    }

    /**
     * The current version's columns, then {@code emails} and {@code phones}
     * (IMP-FR-07).
     */
    ObjectNode profileObject(ProfileRow row, DatasetVersion version, Set<String> shared, Set<String> sharedHeld) {
        ObjectNode object = JacksonMapper.instance().createObjectNode();
        for (DatasetColumn column : version.columns()) {
            AttributeValues
                .ofColumn(row.data().get(column.name()), column.type(), settings.zone())
                .ifPresent(value -> object.set(column.name(), value));
        }
        identifiers("email", row.emails(), shared, sharedHeld).ifPresent(value -> object.set("emails", value));
        identifiers("phone", row.phones(), shared, sharedHeld).ifPresent(value -> object.set("phones", value));
        return object;
    }

    private Optional<JsonNode> identifiers(String type, List<String> values, Set<String> shared,
        Set<String> sharedHeld) {
        for (String value : values) {
            String key = type + ":" + value;
            if (shared.contains(key) || AttributeValues.sharedAlone(value, settings.placeholders())) {
                sharedHeld.add(key);
            }
        }
        return AttributeValues.identifiers(values);
    }

    /**
     * Compares each built row with the stored hash, and keeps the ones that
     * differ (IMP-FR-09). A built row leaves the stored map, so what remains
     * there at the end has no backing row (IMP-FR-10).
     */
    private static final class Stager {
        private final Map<RowKey, Stored> stored;
        private final List<Staged> upserts;
        private final Set<String> customerKeys;
        private final Progress progress;

        Stager(Map<RowKey, Stored> stored, List<Staged> upserts, Set<String> customerKeys, Progress progress) {
            this.stored = stored;
            this.upserts = upserts;
            this.customerKeys = customerKeys;
            this.progress = progress;
        }

        void stage(RowKey key, ObjectNode object) {
            String canonical = CanonicalJson.write(object);
            String hash = CanonicalJson.hash(canonical);
            Stored before = stored.remove(key);
            progress.add("built_rows", 1);
            customerKeys.add(key.customerKey());
            if (before != null && before.hash().equals(hash)) return;
            upserts.add(new Staged(key, canonical, hash));
        }
    }

    /**
     * Publish under the WAL governor: tombstones first, then upserts and deletes
     * in batches, each after the governor clears it and the own rate allows it.
     */
    void publish(UUID passId, Staging staging, Instant deadline, Progress progress) throws Exception {
        Set<String> hashes = ledger.tombstoneHashes();
        Predicate<String> tombstoned = hashes.isEmpty()
            ? key -> false
            : new Tombstones(settings.tombstoneKey(), hashes);
        List<String> deadKeys = staging.customerKeys.stream().filter(tombstoned).toList();
        Set<String> dead = new HashSet<>(deadKeys);
        List<Staged> upserts = staging.upserts.stream().filter(row -> !dead.contains(row.key().customerKey())).toList();
        List<RowKey> deletes = staging.leftover
            .keySet()
            .stream()
            .filter(key -> !dead.contains(key.customerKey()))
            .toList();
        progress.count("tombstoned_keys", deadKeys.size());
        Instant publishStart = clock.instant();
        int size = settings.batchSize();
        for (int from = 0; from < deadKeys.size(); from += size) {
            List<String> batch = deadKeys.subList(from, Math.min(deadKeys.size(), from + size));
            progress.deleted(write(deadline, publishStart, progress, () -> ledger.deleteCustomers(batch)));
        }
        for (int from = 0; from < deletes.size(); from += size) {
            List<RowKey> batch = deletes.subList(from, Math.min(deletes.size(), from + size));
            progress.deleted(write(deadline, publishStart, progress, () -> ledger.delete(batch)));
        }
        for (int from = 0; from < upserts.size(); from += size) {
            List<Staged> batch = upserts.subList(from, Math.min(upserts.size(), from + size));
            progress.upserted(write(deadline, publishStart, progress, () -> ledger.upsert(passId, batch)));
        }
    }

    private interface Statement {
        Written run() throws Exception;
    }

    private Written write(Instant deadline, Instant publishStart, Progress progress, Statement statement)
        throws Exception {
        governor.awaitClear(deadline, lock::check);
        Written written = statement.run();
        progress.walBytes += written.walBytes();
        holdOwnRate(publishStart, progress.walBytes, deadline);
        return written;
    }

    /**
     * Sleeps until the own WAL so far is within the own rate over the time spent
     * writing since publishing began (IMP-NFR-02). Governor pauses do not count,
     * so a long pause earns no burst. The sleep ends at the deadline, and the
     * lock is checked after it.
     */
    private void holdOwnRate(Instant publishStart, long walBytes, Instant deadline) throws InterruptedException {
        Duration due = Duration.ofMillis((long) Math.ceil(walBytes / settings.ownWalBytesPerSecond() * 1000));
        Instant now = clock.instant();
        Duration paused = Duration.ofMillis((long) (governor.pausedSeconds() * 1000));
        Duration writing = Duration.between(publishStart, now).minus(paused);
        Duration sleep = due.minus(writing);
        Duration untilDeadline = Duration.between(now, deadline);
        if (sleep.compareTo(untilDeadline) > 0) sleep = untilDeadline;
        if (sleep.isNegative() || sleep.isZero()) return;
        sleeper.sleep(sleep);
        lock.check();
    }

    /** What the pass has done so far, recorded when it ends either way. */
    static final class Progress {
        private final ObjectNode counts = JacksonMapper.instance().createObjectNode();
        private long changedRows;
        private long walBytes;
        private Optional<Instant> lastRunFinishedAt = Optional.empty();

        void count(String name, long value) {
            counts.put(name, value);
        }

        void add(String name, long value) {
            counts.put(name, counts.path(name).asLong(0) + value);
        }

        void upserted(Written written) {
            changedRows += written.rows();
            add("upserted_rows", written.rows());
        }

        void deleted(Written written) {
            changedRows += written.rows();
            add("deleted_rows", written.rows());
        }

        Outcome outcome(List<WalGovernor.Pause> pauses) {
            return new Outcome(changedRows, walBytes, counts.deepCopy(), pauses, lastRunFinishedAt);
        }
    }
}
