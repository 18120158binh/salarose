package com.cdp.platform.jobs.importapplier;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** What one file's validation counted. It holds no row value (IAP-FR-17). */
final class ValidationStats {

    static final int SAMPLE_LIMIT = 100;

    /**
     * A rejected row by its line number and reason. Its values stay in the rejects
     * file.
     */
    record Sample(long line, String reason) {
    }

    long rowsRead;
    long valid;
    long emailsDropped;
    long phonesDropped;
    long emailsShared;
    long phonesShared;
    long distinctKeys;
    long matchedKeys;
    /** Valid event rows whose record id the import store does not hold yet. */
    long newRecords;
    final Map<String, Long> rejectedByReason = new TreeMap<>();
    final List<Sample> samples = new ArrayList<>();

    void reject(long line, String reason) {
        rejectedByReason.merge(reason, 1L, Long::sum);
        if (samples.size() < SAMPLE_LIMIT) samples.add(new Sample(line, reason));
    }

    long rejected() {
        return rowsRead - valid;
    }

    /**
     * The share of the file's distinct customer keys that {@code identity_graph}
     * holds, or null with none.
     */
    Double matchRate() {
        return distinctKeys == 0 ? null : (double) matchedKeys / distinctKeys;
    }
}
