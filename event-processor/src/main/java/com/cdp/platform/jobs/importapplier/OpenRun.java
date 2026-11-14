package com.cdp.platform.jobs.importapplier;

import java.time.Instant;

/**
 * A run at {@code queued}, {@code approved}, {@code quarantined}, or
 * {@code failed}: the states the queue reads.
 *
 * @param writer
 *            the source key id, or {@code studio}
 * @param fileKey
 *            null for a re-derive, which has no file
 */
record OpenRun(String id, String recordTypeId, String state, String source, String writer, String format,
    Long byteSize, String fileKey, String storedSha256, Instant confirmedAt) {

    static final String QUEUED = "queued";
    static final String APPROVED = "approved";
    static final String QUARANTINED = "quarantined";
    static final String FAILED = "failed";

    boolean waiting() {
        return state.equals(QUEUED) || state.equals(APPROVED);
    }

    boolean held() {
        return state.equals(QUARANTINED) || state.equals(FAILED);
    }

    boolean fromSourceKey() {
        return source.equals("api") || source.equals("drop");
    }
}
