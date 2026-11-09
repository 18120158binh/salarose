package com.cdp.platform.jobs.eventparser.volume;

import java.time.Duration;

import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.api.common.state.StateTtlConfig;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.util.Collector;

import com.cdp.platform.jobs.eventparser.transforms.DeadLetter;
import com.cdp.platform.shared.models.ParsedEvent;
import com.cdp.platform.shared.models.db.EventVolume;

/**
 * Keeps the running total of each {@code event_volume} row and emits it on
 * every event. The total is checkpointed state, so after a restore the replayed
 * events count again from the checkpoint's total and the row converges on the
 * same value. A total is kept two days after its last event, which covers its
 * hour and the job's lag.
 */
public final class EventVolumeCounter extends KeyedProcessFunction<String, EventVolume, EventVolume> {

    static final Duration RETENTION = Duration.ofDays(2);

    private transient ValueState<EventVolume> total;

    /** The running totals of each accepted event and each named, dropped event. */
    public static DataStream<EventVolume> totals(DataStream<ParsedEvent> accepted, DataStream<DeadLetter> dropped) {
        TypeInformation<EventVolume> type = TypeInformation.of(EventVolume.class);
        DataStream<EventVolume> acceptedCounts = accepted
            .flatMap(EventVolumeCounter::accepted)
            .returns(type)
            .name("Accepted Event Counts")
            .uid("accepted-event-counts");
        DataStream<EventVolume> droppedCounts = dropped
            .flatMap(EventVolumeCounter::dropped)
            .returns(type)
            .name("Dropped Event Counts")
            .uid("dropped-event-counts");
        return acceptedCounts
            .union(droppedCounts)
            .keyBy(EventVolume::key, Types.STRING)
            .process(new EventVolumeCounter())
            .returns(type)
            .name("Event Volume Totals")
            .uid("event-volume-totals");
    }

    /**
     * An accepted event at its collector time, else its event time. An event
     * with no name is not counted.
     */
    static void accepted(ParsedEvent event, Collector<EventVolume> out) {
        String name = event.eventName();
        if (name == null || name.isBlank()) return;
        Long at = event.collectorTimestamp() != null ? event.collectorTimestamp() : event.eventTimestamp();
        if (at != null) out.collect(EventVolume.of(name, EventVolume.ACCEPTED, at));
    }

    /**
     * A dropped event with a name, at its collector time, else its drop time. A
     * payload record, or an event with no name, is not counted per event.
     */
    static void dropped(DeadLetter letter, Collector<EventVolume> out) {
        String name = letter.eventName();
        if (!"event".equals(letter.record()) || name == null || name.isBlank() || letter.reason() == null) return;
        long at = letter.collectorTimestamp() != null ? letter.collectorTimestamp() : letter.droppedAt();
        out.collect(EventVolume.of(name, letter.reason(), at));
    }

    @Override
    public void open(OpenContext openContext) {
        StateTtlConfig ttl = StateTtlConfig
            .newBuilder(RETENTION)
            .setUpdateType(StateTtlConfig.UpdateType.OnCreateAndWrite)
            .setStateVisibility(StateTtlConfig.StateVisibility.NeverReturnExpired)
            .cleanupInRocksdbCompactFilter(1000)
            .build();
        ValueStateDescriptor<EventVolume> descriptor = new ValueStateDescriptor<>("event-volume-total",
            EventVolume.class);
        descriptor.enableTimeToLive(ttl);
        total = getRuntimeContext().getState(descriptor);
    }

    @Override
    public void processElement(EventVolume event, Context context, Collector<EventVolume> out) throws Exception {
        EventVolume previous = total.value();
        EventVolume next = previous == null ? event : previous.plus(event);
        total.update(next);
        out.collect(next);
    }
}
