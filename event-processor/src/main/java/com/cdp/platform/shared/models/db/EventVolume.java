package com.cdp.platform.shared.models.db;

/**
 * A row of {@code event_volume}: how many events of one name had one outcome
 * in one hour, and the latest of them. One event is a row with count 1.
 *
 * @param eventName
 *            the event's name
 * @param bucketStart
 *            the start of the hour, in epoch milliseconds
 * @param outcome
 *            {@link #ACCEPTED} or a drop reason, such as {@code no_timestamp}
 * @param count
 *            how many events, at least 1
 * @param lastSeenAt
 *            the latest event's time, in epoch milliseconds
 */
public record EventVolume(String eventName, long bucketStart, String outcome, long count, long lastSeenAt) {

    public static final String ACCEPTED = "accepted";
    static final long BUCKET_MILLIS = 3_600_000L;

    /** One event of {@code eventName} with {@code outcome}, seen at {@code at}. */
    public static EventVolume of(String eventName, String outcome, long at) {
        return new EventVolume(eventName, Math.floorDiv(at, BUCKET_MILLIS) * BUCKET_MILLIS, outcome, 1, at);
    }

    /**
     * The row of this row's events and then {@code later}'s, which has the same
     * key.
     */
    public EventVolume plus(EventVolume later) {
        return new EventVolume(eventName, bucketStart, outcome, count + later.count,
            Math.max(lastSeenAt, later.lastSeenAt));
    }

    /**
     * The primary key as one string. A NUL cannot occur in a Postgres text value.
     */
    public String key() {
        return eventName + '\0' + bucketStart + '\0' + outcome;
    }
}
