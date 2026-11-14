package com.cdp.platform.jobs.profilewriter.transforms;

import org.apache.flink.api.common.functions.FlatMapFunction;
import org.apache.flink.util.Collector;

import com.cdp.platform.shared.models.SegmentMembershipChange;
import com.cdp.platform.shared.utils.JacksonMapper;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Decodes a message from {@code segment-membership-changes}. A message that
 * does not decode, lacks {@code canon_id} or {@code segment_id}, has a change
 * other than {@code entered} or {@code exited}, or is an {@code entered}
 * change without {@code event_time}, is logged and dropped.
 */
public final class SegmentMembershipChangeMapper implements FlatMapFunction<String, SegmentMembershipChange> {

    private static final Logger LOG = LoggerFactory.getLogger(SegmentMembershipChangeMapper.class);

    @Override
    public void flatMap(String json, Collector<SegmentMembershipChange> output) {
        try {
            output.collect(decode(json));
        } catch (IllegalArgumentException exception) {
            Throwable reason = exception.getCause() == null ? exception : exception.getCause();
            LOG.warn("Skipping segment membership change that does not decode: {}", reason.getMessage());
        }
    }

    static SegmentMembershipChange decode(String json) {
        SegmentMembershipChange change = JacksonMapper.readValue(json, SegmentMembershipChange.class);
        if (change == null) throw new IllegalArgumentException("Message is JSON null");
        if (isBlank(change.canonId())) throw new IllegalArgumentException("canon_id is required");
        if (isBlank(change.segmentId())) throw new IllegalArgumentException("segment_id is required");
        if (change.change() == null) throw new IllegalArgumentException("change is required");
        if (change.entered() && change.eventTime() == null) {
            throw new IllegalArgumentException("event_time is required for an entered change");
        }
        return change;
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
