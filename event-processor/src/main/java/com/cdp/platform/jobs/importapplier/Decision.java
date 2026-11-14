package com.cdp.platform.jobs.importapplier;

import java.util.ArrayList;
import java.util.List;

import com.cdp.platform.shared.models.imports.DatasetVersion;
import com.cdp.platform.shared.models.imports.DatasetVersion.DeliveryMode;

/**
 * Decide whether to apply: the conditions that quarantine a validated run
 * (IAP-FR-09, IAP-FR-10).
 */
final class Decision {

    static final String REJECT_THRESHOLD = "reject_threshold";
    static final String SNAPSHOT_SHRINK = "snapshot_shrink";
    static final String RECORD_CAP = "record_cap";

    private Decision() {
    }

    /**
     * Every condition that holds, in the contract's order. Empty means apply.
     *
     * @param fromSourceKey
     *            the run's writer is a source key, not {@code studio}
     * @param lastSnapshotValid
     *            the valid rows of the type's last applied snapshot from any
     *            source key, or null when it has none
     * @param storedRecords
     *            the rows {@code import_records} holds now
     */
    static List<String> conditions(ValidationStats stats, DatasetVersion version, boolean fromSourceKey,
        Long lastSnapshotValid, long storedRecords, Limits limits) {
        List<String> held = new ArrayList<>();
        if (stats.rowsRead > 0 && stats.rejected() > limits.rejectThreshold() * stats.rowsRead) {
            held.add(REJECT_THRESHOLD);
        }
        if (version.deliveryMode() == DeliveryMode.SNAPSHOT && fromSourceKey && lastSnapshotValid != null
            && stats.valid < limits.shrinkRatio() * lastSnapshotValid) {
            held.add(SNAPSHOT_SHRINK);
        }
        if (storedRecords + stats.newRecords > limits.recordCap()) held.add(RECORD_CAP);
        return held;
    }
}
