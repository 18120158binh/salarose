package com.cdp.platform.jobs.businessfanout;

/**
 * What reaches one key of the index: an observation that changes it, or a probe
 * that reads it for one business event and campaign. Exactly one is set.
 */
public record IndexInput(String indexKey, Observation observation, Probe probe) {

    /** Kinds of change to an index entry. */
    public enum Kind {
        INTEREST, EXCLUSION, ENTERED, EXITED
    }

    /**
     * A person's event on an item, or a segment membership change.
     * {@code retentionMs} is how long an interest entry lives: the longest window
     * of the active campaigns that use the interest.
     */
    public record Observation(String canonId, long time, Kind kind, long retentionMs) {
    }

    /**
     * A business event that one campaign's trigger takes, sent to the index of its
     * audience. An interest probe carries the campaign's count and window.
     */
    public record Probe(BusinessEvent event, String campaignId, String nodeId, int minCount, long windowMs) {
    }

    static IndexInput of(String indexKey, Observation observation) {
        return new IndexInput(indexKey, observation, null);
    }

    static IndexInput of(String indexKey, Probe probe) {
        return new IndexInput(indexKey, null, probe);
    }

    /** The key of an interest's index for one item. */
    static String interestKey(String interestIndexId, String itemKey) {
        return "interest" + BusinessEvent.KEY_SEPARATOR + interestIndexId + BusinessEvent.KEY_SEPARATOR + itemKey;
    }

    /** The key of one shard of a segment's member index. */
    static String segmentKey(String segmentId, int shard) {
        return "segment" + BusinessEvent.KEY_SEPARATOR + segmentId + BusinessEvent.KEY_SEPARATOR + shard;
    }

    static boolean isSegmentKey(String indexKey) {
        return indexKey.startsWith("segment" + BusinessEvent.KEY_SEPARATOR);
    }
}
