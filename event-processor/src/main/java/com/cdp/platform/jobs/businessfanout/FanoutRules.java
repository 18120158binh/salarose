package com.cdp.platform.jobs.businessfanout;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.cdp.platform.jobs.businessfanout.BusinessTrigger.Interest;
import com.cdp.platform.jobs.businessfanout.IndexInput.Kind;
import com.cdp.platform.jobs.businessfanout.IndexInput.Observation;
import com.cdp.platform.jobs.businessfanout.IndexInput.Probe;
import com.cdp.platform.shared.models.Event;

/**
 * Routes events to the index keys they touch, given the business triggers of
 * the
 * active campaigns.
 */
final class FanoutRules {

    /**
     * How many keys one segment's member index spreads over. A canon id always
     * lands on the same shard, so an exit reaches the shard its entry did.
     */
    static final int SEGMENT_SHARDS = 32;

    private final List<BusinessTrigger> triggers;

    FanoutRules(Iterable<BusinessTrigger> triggers, Set<String> activeCampaignIds) {
        List<BusinessTrigger> active = new ArrayList<>();
        for (BusinessTrigger trigger : triggers) {
            if (activeCampaignIds.contains(trigger.campaignId())) active.add(trigger);
        }
        this.triggers = List.copyOf(active);
    }

    /**
     * One probe per index key that a business event reaches: one per interest
     * campaign whose trigger takes it, and one per shard per segment campaign.
     */
    List<IndexInput> probes(BusinessEvent event) {
        List<IndexInput> probes = new ArrayList<>();
        for (BusinessTrigger trigger : triggers) {
            if (!trigger.eventName().equals(event.eventName()) || !event.passes(trigger.filters())) continue;
            Interest interest = trigger.interest();
            if (interest != null) {
                Probe probe = new Probe(event, trigger.campaignId(), trigger.nodeId(), interest.minCount(),
                    interest.windowMs());
                probes.add(IndexInput.of(IndexInput.interestKey(interest.indexId(), event.itemKey()), probe));
            } else {
                Probe probe = new Probe(event, trigger.campaignId(), trigger.nodeId(), 0, 0);
                for (int shard = 0; shard < SEGMENT_SHARDS; shard++) {
                    probes.add(IndexInput.of(IndexInput.segmentKey(trigger.segmentId(), shard), probe));
                }
            }
        }
        return probes;
    }

    /**
     * One observation per interest index that a person event counts in, as an
     * interest event or an exclusion. Campaigns that share an interest share one
     * observation, which lives as long as their longest window.
     */
    List<IndexInput> observations(Event event) {
        if (event.canonId() == null || event.eventName() == null || event.collectorTimestamp() == null) {
            return List.of();
        }
        Map<String, IndexInput> byKey = new LinkedHashMap<>();
        for (Map.Entry<Interest, Long> entry : retentionByInterest().entrySet()) {
            Interest interest = entry.getKey();
            long retention = entry.getValue();
            observe(byKey, event, interest, interest.event(), interest.match(), Kind.INTEREST, retention);
            observe(byKey, event, interest, interest.excludeEvent(), interest.excludeMatch(), Kind.EXCLUSION,
                retention);
        }
        return List.copyOf(byKey.values());
    }

    private void observe(Map<String, IndexInput> byKey, Event event, Interest interest, String eventName,
        String match, Kind kind, long retention) {
        if (!event.eventName().equals(eventName)) return;
        String itemKey = event.propertyValue(match);
        if (itemKey == null || itemKey.isBlank()) return;
        String key = IndexInput.interestKey(interest.indexId(), itemKey) + BusinessEvent.KEY_SEPARATOR + kind;
        byKey
            .putIfAbsent(key, IndexInput
                .of(IndexInput.interestKey(interest.indexId(), itemKey),
                    new Observation(event.canonId(), event.collectorTimestamp(), kind, retention)));
    }

    /**
     * Each interest the active triggers use, by its index, with the longest window
     * among them.
     */
    private Map<Interest, Long> retentionByInterest() {
        Map<String, Interest> byIndex = new LinkedHashMap<>();
        Map<Interest, Long> retention = new LinkedHashMap<>();
        for (BusinessTrigger trigger : triggers) {
            Interest interest = trigger.interest();
            if (interest == null) continue;
            Interest shared = byIndex.computeIfAbsent(interest.indexId(), id -> interest);
            retention.merge(shared, interest.windowMs(), Math::max);
        }
        return retention;
    }

    static IndexInput segmentChange(String canonId, String segmentId, boolean entered, long time) {
        return IndexInput
            .of(IndexInput.segmentKey(segmentId, Math.floorMod(canonId.hashCode(), SEGMENT_SHARDS)),
                new Observation(canonId, time, entered ? Kind.ENTERED : Kind.EXITED, 0));
    }
}
