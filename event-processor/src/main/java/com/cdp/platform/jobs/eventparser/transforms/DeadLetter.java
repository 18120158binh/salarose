package com.cdp.platform.jobs.eventparser.transforms;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;

import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.util.OutputTag;

import com.cdp.platform.jobs.eventparser.transforms.DroppedEvents.Reason;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonRawValue;

/**
 * A payload or an event that ingestion dropped, as written to the dead-letter
 * topic. Unlike a log line, it keeps the content, so it can be inspected and
 * replayed. A collector payload is written once, in a {@code payload} record.
 * Each dropped event of it is an {@code event} record that refers to it by
 * {@code payload_id}.
 *
 * @param record
 *            {@code payload} or {@code event}
 * @param reason
 *            the drop reason, such as {@code no_timestamp}. Null for the
 *            payload record of a payload whose events were dropped one by one.
 * @param detail
 *            the exception class, the field names, or the failed attribute.
 *            Never content.
 * @param droppedAt
 *            when the job dropped it, in epoch milliseconds
 * @param payloadId
 *            the SHA-256 of the collector payload's bytes, in hex
 * @param payload
 *            the collector payload's Thrift bytes in standard Base64, cut to
 *            the size limit
 * @param payloadSize
 *            the collector payload's size in bytes before any cut
 * @param payloadTruncated
 *            whether {@code payload} holds only the first bytes
 * @param event
 *            the event as a JSON object: the raw tracker event for a drop by
 *            the parser, or the parsed event for {@code schema_invalid}
 * @param eventName
 *            the dropped event's name, or null for a payload record and for an
 *            event whose name could not be read
 * @param collectorTimestamp
 *            when the collector received the payload, in epoch milliseconds, or
 *            null when the payload does not say
 */
public record DeadLetter(
    @JsonProperty("record") String record,
    @JsonProperty("reason") String reason,
    @JsonProperty("detail") String detail,
    @JsonProperty("dropped_at") long droppedAt,
    @JsonProperty("payload_id") String payloadId,
    @JsonProperty("payload") String payload,
    @JsonProperty("payload_size") Integer payloadSize,
    @JsonProperty("payload_truncated") Boolean payloadTruncated,
    @JsonProperty("event") @JsonRawValue String event,
    @JsonProperty("event_name") String eventName,
    @JsonProperty("collector_timestamp") Long collectorTimestamp) {

    /** The side output that the parser and the schema gate drop into. */
    public static final OutputTag<DeadLetter> OUTPUT = new OutputTag<>("dead-letters",
        TypeInformation.of(DeadLetter.class));

    public static final String PAYLOAD_LIMIT_VARIABLE = "EVENT_PARSE_DEAD_LETTER_PAYLOAD_LIMIT";
    /**
     * 512 KiB. In Base64 it is about 683 KiB, below the Kafka producer's default
     * {@code max.request.size} of 1 MiB.
     */
    static final int DEFAULT_PAYLOAD_LIMIT = 512 * 1024;

    /**
     * Parses the payload size limit in bytes. Unset or blank gives the default.
     * Any other value must be a positive integer.
     */
    public static int payloadLimit(String value) {
        if (value == null || value.isBlank()) return DEFAULT_PAYLOAD_LIMIT;
        try {
            int limit = Integer.parseInt(value.trim());
            if (limit > 0) return limit;
        } catch (NumberFormatException ignored) {
            // Reported below with the value.
        }
        throw new IllegalArgumentException(PAYLOAD_LIMIT_VARIABLE + " must be a positive integer: \"" + value + "\"");
    }

    /**
     * The record of a collector payload, with its first {@code limit} bytes.
     *
     * @param reason
     *            the reason the whole payload was dropped, or null when only
     *            some of its events were
     */
    static DeadLetter payload(Reason reason, String detail, long droppedAt, byte[] payload, int limit) {
        if (payload == null)
            return new DeadLetter("payload", reason.label(), detail, droppedAt, null, null, null, null, null, null,
                null);
        boolean truncated = payload.length > limit;
        byte[] kept = truncated ? Arrays.copyOf(payload, limit) : payload;
        return new DeadLetter("payload", reason == null ? null : reason.label(), detail, droppedAt, payloadId(payload),
            Base64.getEncoder().encodeToString(kept), payload.length, truncated, null, null, null);
    }

    /**
     * The record of one dropped event.
     *
     * @param payloadId
     *            the id of its payload's record, or null when there is none
     * @param eventName
     *            the event's name, or null when it could not be read
     */
    static DeadLetter event(Reason reason, String detail, long droppedAt, String payloadId, String event,
        String eventName, Long collectorTimestamp) {
        return new DeadLetter("event", reason.label(), detail, droppedAt, payloadId, null, null, null, event,
            eventName, collectorTimestamp);
    }

    static String payloadId(byte[] payload) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(payload));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("Every Java runtime has SHA-256", e);
        }
    }
}
