package com.cdp.platform.jobs.businessfanout;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import org.apache.flink.api.common.state.BroadcastState;
import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.state.ReadOnlyBroadcastState;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.streaming.api.functions.co.BroadcastProcessFunction;
import org.apache.flink.types.Either;
import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;
import org.apache.flink.util.Collector;

import com.cdp.platform.shared.db.repositories.CampaignNodesTable;
import com.cdp.platform.shared.db.repositories.CampaignsTable;
import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.db.CampaignNode;

/**
 * Keeps the business triggers of the campaigns from CDC, and routes business
 * events and person events to the index keys they reach. A campaign row's
 * status decides whether its triggers apply, so a trigger stops on pause and
 * starts counting interest only once its campaign is active (BEF-FR-08).
 */
final class FanoutRouter extends BroadcastProcessFunction<Either<BusinessEvent, Event>, Either<Row, Row>, IndexInput> {

    static final MapStateDescriptor<String, String> CAMPAIGN_STATUS = new MapStateDescriptor<>(
        "fanout-campaign-status", Types.STRING, Types.STRING);
    static final MapStateDescriptor<String, BusinessTrigger> TRIGGERS = new MapStateDescriptor<>(
        "fanout-business-triggers", Types.STRING, TypeInformation.of(BusinessTrigger.class));

    private static final String ACTIVE = "active";

    @Override
    public void processElement(Either<BusinessEvent, Event> input, ReadOnlyContext context,
        Collector<IndexInput> out) throws Exception {
        FanoutRules rules = rules(context.getBroadcastState(CAMPAIGN_STATUS), context.getBroadcastState(TRIGGERS));
        if (input.isLeft()) {
            rules.probes(input.left()).forEach(out::collect);
        } else {
            rules.observations(input.right()).forEach(out::collect);
        }
    }

    @Override
    public void processBroadcastElement(Either<Row, Row> update, Context context, Collector<IndexInput> out)
        throws Exception {
        Row row = update.isLeft() ? update.left() : update.right();
        // An update's before image is skipped: the key never changes in an update.
        if (row.getKind() == RowKind.UPDATE_BEFORE) return;
        boolean deleted = row.getKind() == RowKind.DELETE;
        if (update.isLeft()) {
            BroadcastState<String, String> statuses = context.getBroadcastState(CAMPAIGN_STATUS);
            String campaignId = row.getFieldAs(CampaignsTable.ID);
            String status = deleted ? null : row.getFieldAs(CampaignsTable.STATUS);
            if (campaignId == null) return;
            if (status == null) {
                statuses.remove(campaignId);
            } else {
                statuses.put(campaignId, status);
            }
            return;
        }
        BroadcastState<String, BusinessTrigger> triggers = context.getBroadcastState(TRIGGERS);
        String key = CampaignNode
            .stateKey((String) row.getField(CampaignNodesTable.CAMPAIGN_ID),
                (String) row.getField(CampaignNodesTable.NODE_ID));
        var trigger = deleted ? Optional.<BusinessTrigger>empty() : BusinessTrigger.fromRow(row);
        if (trigger.isPresent()) {
            triggers.put(key, trigger.get());
        } else {
            triggers.remove(key);
        }
    }

    static FanoutRules rules(ReadOnlyBroadcastState<String, String> statuses,
        ReadOnlyBroadcastState<String, BusinessTrigger> triggers) throws Exception {
        Set<String> active = new HashSet<>();
        for (Map.Entry<String, String> status : statuses.immutableEntries()) {
            if (ACTIVE.equals(status.getValue())) active.add(status.getKey());
        }
        List<BusinessTrigger> all = new ArrayList<>();
        for (Map.Entry<String, BusinessTrigger> trigger : triggers.immutableEntries()) {
            all.add(trigger.getValue());
        }
        return new FanoutRules(all, active);
    }
}
