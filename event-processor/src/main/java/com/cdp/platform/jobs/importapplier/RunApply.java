package com.cdp.platform.jobs.importapplier;

import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

import com.cdp.platform.shared.models.imports.DatasetVersion;
import com.cdp.platform.shared.models.imports.DatasetVersion.Role;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * Apply: writes one run's rows to the import store inside the store's open
 * transaction, by the upsert, deleted flag, and snapshot rules (IAP-FR-12 to
 * IAP-FR-14, IAP-FR-16, IAP-FR-25). Rows arrive in file order from the
 * validator and are written in batches. A file holds each key once, because
 * validation rejects a repeat, so a batch never names a key twice.
 */
final class RunApply implements RowSink {

    static final int BATCH = 1000;
    static final String STUDIO = "studio";

    /**
     * The writes of one batch failed. The run fails and its transaction rolls back.
     */
    static final class StoreFailure extends RuntimeException {
        StoreFailure(SQLException cause) {
            super("an import store write failed", cause);
        }
    }

    /** What apply did, for the run's counts. */
    record Applied(long newRows, long updated, long unchanged, long removed) {

        static final Applied NONE = new Applied(0, 0, 0, 0);

        Applied plus(Applied other) {
            return new Applied(newRows + other.newRows, updated + other.updated, unchanged + other.unchanged,
                removed + other.removed);
        }

        void addTo(ObjectNode counts) {
            counts.put("rows_new", newRows);
            counts.put("rows_updated", updated);
            counts.put("rows_unchanged", unchanged);
            counts.put("rows_removed", removed);
        }
    }

    // Values equal as JSON, with numbers equal by value, so 5 and 5.0 match a
    // number the store read back in another form.
    private static final Comparator<JsonNode> SAME_VALUE = (a, b) -> {
        if (a.isNumber() && b.isNumber()) return a.decimalValue().compareTo(b.decimalValue());
        return a.equals(b) ? 0 : 1;
    };

    private final ImportStore store;
    private final DatasetVersion version;
    private final String writer;
    private final String runId;
    private final boolean snapshot;
    private final List<RowValidator.Valid> pending = new ArrayList<>();
    private final List<String> kept = new ArrayList<>();
    private long newRows;
    private long updated;
    private long unchanged;
    private long removed;

    /**
     * @param snapshot
     *            remove stored rows the file lacks: a snapshot type, delivered by
     *            a source key. A studio upload to a snapshot type applies as
     *            incremental (IAP-FR-13).
     */
    RunApply(ImportStore store, DatasetVersion version, String writer, String runId, boolean snapshot) {
        this.store = store;
        this.version = version;
        this.writer = writer;
        this.runId = runId;
        this.snapshot = snapshot;
    }

    @Override
    public void valid(RowValidator.Valid row) {
        pending.add(row);
        if (snapshot) keep(row.key());
        if (pending.size() >= BATCH) flush();
    }

    @Override
    public void rejected(String key) {
        if (snapshot && key != null) keep(key);
    }

    /**
     * Writes what is left and, for a snapshot, removes the stored rows the file
     * lacks.
     */
    Applied finish() {
        flush();
        try {
            if (snapshot) {
                if (!kept.isEmpty()) store.keep(kept);
                kept.clear();
                removed += store.removeUnkept(version.kind(), version.recordTypeId(), STUDIO);
            }
        } catch (SQLException e) {
            throw new StoreFailure(e);
        }
        return new Applied(newRows, updated, unchanged, removed);
    }

    private void keep(String key) {
        kept.add(key);
        if (kept.size() < BATCH) return;
        try {
            store.keep(kept);
        } catch (SQLException e) {
            throw new StoreFailure(e);
        }
        kept.clear();
    }

    private void flush() {
        if (pending.isEmpty()) return;
        try {
            Map<String, ImportStore.Stored> stored = store
                .stored(version.kind(), version.recordTypeId(), pending.stream().map(RowValidator.Valid::key).toList());
            List<ImportStore.Row> writes = new ArrayList<>();
            List<String> removals = new ArrayList<>();
            for (RowValidator.Valid row : pending) {
                ImportStore.Stored current = stored.get(row.key());
                Instant rowUpdated = updatedAt(row.data());
                if (current != null && later(updatedAt(current.data()), rowUpdated)) {
                    unchanged++;
                } else if (!snapshot && deleted(row.data())) {
                    if (current == null) {
                        unchanged++;
                    } else {
                        removals.add(row.key());
                        removed++;
                    }
                } else if (current == null) {
                    newRows++;
                    writes.add(toRow(row, rowUpdated));
                } else if (current.data().equals(SAME_VALUE, row.data())) {
                    unchanged++;
                    if (!current.writer().equals(writer)) writes.add(toRow(row, rowUpdated));
                } else {
                    updated++;
                    writes.add(toRow(row, rowUpdated));
                }
            }
            if (!writes.isEmpty()) store.write(version.kind(), version.recordTypeId(), writes, writer, runId);
            if (!removals.isEmpty()) store.remove(version.kind(), version.recordTypeId(), removals);
        } catch (SQLException e) {
            throw new StoreFailure(e);
        }
        pending.clear();
    }

    private static ImportStore.Row toRow(RowValidator.Valid row, Instant updatedAt) {
        return new ImportStore.Row(row.key(), row.customerKey(), row.eventTime(), updatedAt, row.data(), row.emails(),
            row.phones());
    }

    /**
     * True when the stored row's {@code updated_at} is later than the row's.
     * With either one missing, the newer delivery wins.
     */
    private static boolean later(Instant stored, Instant row) {
        return stored != null && row != null && stored.isAfter(row);
    }

    private Instant updatedAt(ObjectNode data) {
        Optional<String> column = version.column(Role.UPDATED_AT);
        if (column.isEmpty()) return null;
        JsonNode value = data.get(column.get());
        if (value == null || !value.isTextual()) return null;
        return Values.instant(value.asText(), version.timeZone()).map(time -> time.toInstant()).orElse(null);
    }

    private boolean deleted(ObjectNode data) {
        Optional<String> column = version.column(Role.DELETED_FLAG);
        if (column.isEmpty()) return false;
        JsonNode value = data.get(column.get());
        if (value == null) return false;
        return value.isBoolean() ? value.booleanValue() : value.asText().toLowerCase(Locale.ROOT).equals("true");
    }
}
