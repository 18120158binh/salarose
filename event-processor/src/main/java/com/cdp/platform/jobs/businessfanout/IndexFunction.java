package com.cdp.platform.jobs.businessfanout;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.api.common.state.MapState;
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.state.ValueState;
import org.apache.flink.api.common.state.ValueStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.metrics.Counter;
import org.apache.flink.streaming.api.functions.KeyedProcessFunction;
import org.apache.flink.util.Collector;
import org.apache.flink.util.OutputTag;

import com.cdp.platform.jobs.businessfanout.IndexInput.Observation;
import com.cdp.platform.jobs.businessfanout.IndexInput.Probe;
import com.cdp.platform.shared.models.MetricBucket.Size;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Keeps one key of the index, an interest's people for one item or one shard of
 * a segment's members, and turns each probe into matches.
 *
 * <p>
 * An interest key holds at most {@link #CAP} people. A new person over the cap
 * pushes out the one whose newest interest event is oldest. A probe emits at
 * most {@link #CAP} matches, to the most recently interested first. Both report
 * what they leave out on {@link #LEFT_OUT} and in a counter.
 */
final class IndexFunction extends KeyedProcessFunction<String, IndexInput, Match> {

    private static final Logger LOG = LoggerFactory.getLogger(IndexFunction.class);

    /**
     * People per item and interest, and matches per business event and campaign.
     */
    static final int CAP = 10_000;

    /** What a cap left out: people pushed out of an index, or matches not sent. */
    record LeftOut(String indexKey, String businessEventId, String campaignId, long count) {
    }

    static final OutputTag<LeftOut> LEFT_OUT = new OutputTag<>("left-out", TypeInformation.of(LeftOut.class));

    private transient MapState<String, InterestEntry> interested;
    private transient MapState<String, Boolean> members;
    private transient ValueState<Integer> interestedCount;
    private transient ValueState<Long> retention;
    private transient Counter peopleDropped;
    private transient Counter matchesLeftOut;

    @Override
    public void open(OpenContext openContext) {
        interested = getRuntimeContext()
            .getMapState(new MapStateDescriptor<>("interested", Types.STRING, TypeInformation.of(InterestEntry.class)));
        members = getRuntimeContext().getMapState(new MapStateDescriptor<>("members", Types.STRING, Types.BOOLEAN));
        interestedCount = getRuntimeContext().getState(new ValueStateDescriptor<>("interested-count", Types.INT));
        retention = getRuntimeContext().getState(new ValueStateDescriptor<>("retention", Types.LONG));
        peopleDropped = getRuntimeContext().getMetricGroup().counter("interestPeopleDroppedOverCap");
        matchesLeftOut = getRuntimeContext().getMetricGroup().counter("matchesLeftOutOverCap");
    }

    @Override
    public void processElement(IndexInput input, Context context, Collector<Match> out) throws Exception {
        if (input.probe() != null) {
            if (IndexInput.isSegmentKey(input.indexKey())) {
                for (String canonId : members.keys()) {
                    out.collect(Match.of(canonId, input.probe()));
                }
            } else {
                probeInterest(input.indexKey(), input.probe(), context, out);
            }
            return;
        }
        Observation observation = input.observation();
        switch (observation.kind()) {
            case ENTERED -> members.put(observation.canonId(), true);
            case EXITED -> members.remove(observation.canonId());
            case INTEREST, EXCLUSION -> observeInterest(input.indexKey(), observation, context);
            default -> throw new IllegalStateException("Unknown kind " + observation.kind());
        }
    }

    private void observeInterest(String indexKey, Observation observation, Context context) throws Exception {
        long retentionMs = Math.max(observation.retentionMs(), retention.value() == null ? 0 : retention.value());
        retention.update(retentionMs);
        InterestEntry entry = interested.get(observation.canonId());
        if (entry == null) {
            entry = InterestEntry.EMPTY;
            int count = interestedCount.value() == null ? 0 : interestedCount.value();
            if (count >= CAP) {
                dropLeastRecent();
                peopleDropped.inc();
                context.output(LEFT_OUT, new LeftOut(indexKey, null, null, 1));
            } else {
                interestedCount.update(count + 1);
            }
        }
        interested
            .put(observation.canonId(), observation.kind() == IndexInput.Kind.INTEREST
                ? entry.withInterest(observation.time(), retentionMs)
                : entry.withExclusion(observation.time()));
        // One expiry check per hour per key, at most.
        long now = context.timerService().currentProcessingTime();
        context.timerService().registerProcessingTimeTimer(Size.HOUR.startOf(now + retentionMs) + Size.HOUR.millis());
    }

    private void dropLeastRecent() throws Exception {
        String oldest = null;
        long oldestTime = Long.MAX_VALUE;
        for (Map.Entry<String, InterestEntry> person : interested.entries()) {
            if (oldest == null || person.getValue().newestInterest() < oldestTime) {
                oldest = person.getKey();
                oldestTime = person.getValue().newestInterest();
            }
        }
        if (oldest != null) interested.remove(oldest);
    }

    private void probeInterest(String indexKey, Probe probe, Context context, Collector<Match> out)
        throws Exception {
        long time = probe.event().eventTime();
        List<Map.Entry<String, InterestEntry>> selected = new ArrayList<>();
        for (Map.Entry<String, InterestEntry> person : interested.entries()) {
            InterestEntry entry = person.getValue();
            if (entry.countIn(time, probe.windowMs()) >= probe.minCount()
                && !entry.excludedIn(time, probe.windowMs())) {
                selected.add(Map.entry(person.getKey(), entry));
            }
        }
        selected
            .sort(Comparator
                .comparingLong((Map.Entry<String, InterestEntry> person) -> person.getValue().newestInterest())
                .reversed()
                .thenComparing(Map.Entry::getKey));
        for (int index = 0; index < Math.min(CAP, selected.size()); index++) {
            out.collect(Match.of(selected.get(index).getKey(), probe));
        }
        if (selected.size() > CAP) {
            long leftOut = selected.size() - CAP;
            matchesLeftOut.inc(leftOut);
            context.output(LEFT_OUT, new LeftOut(indexKey, probe.event().eventId(), probe.campaignId(), leftOut));
            LOG
                .warn("Business event {} reached {} more people than the cap for campaign {}",
                    probe.event().eventId(), leftOut, probe.campaignId());
        }
    }

    @Override
    public void onTimer(long timestamp, OnTimerContext context, Collector<Match> out) throws Exception {
        Long retentionMs = retention.value();
        if (retentionMs == null) return;
        long cutoff = timestamp - retentionMs;
        List<String> expired = new ArrayList<>();
        for (Map.Entry<String, InterestEntry> person : interested.entries()) {
            if (person.getValue().newestActivity() <= cutoff) expired.add(person.getKey());
        }
        for (String canonId : expired) {
            interested.remove(canonId);
        }
        int count = (interestedCount.value() == null ? 0 : interestedCount.value()) - expired.size();
        if (count <= 0) {
            interested.clear();
            interestedCount.clear();
            retention.clear();
        } else {
            interestedCount.update(count);
        }
    }
}
