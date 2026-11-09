package com.cdp.platform.jobs.statemachine.transforms;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import org.apache.flink.api.common.state.MapStateDescriptor;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.streaming.api.operators.co.CoBroadcastWithKeyedOperator;
import org.apache.flink.streaming.util.KeyedBroadcastOperatorTestHarness;
import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;

import com.cdp.platform.jobs.statemachine.model.CampaignGraph;
import com.cdp.platform.shared.models.JourneyTriggerEvent;
import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.models.db.UserCampaignState;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * A campaign's graph rows find the campaign's buffered journeys by walking
 * every journey on the subtask that has buffered triggers, in any campaign. The
 * walk must stay cheap on the heap state backend, which the state machine uses
 * unless the cluster sets one, so that a save does not hold up the triggers of
 * every other campaign on the subtask.
 */
class GraphSaveCostTest {

    private static final long T_10_01 = 1_760_346_060_000L;
    private static final int BUFFERED_JOURNEYS = 20_000;
    private static final long SAVE_BUDGET_NANOS = 100_000_000L;
    private static final MapStateDescriptor<String, CampaignGraph> GRAPHS = new MapStateDescriptor<>(
        "campaign-journey-graphs", Types.STRING, TypeInformation.of(CampaignGraph.class));

    private KeyedBroadcastOperatorTestHarness<String, VersionedTrigger, Row, UserCampaignState> harness;

    @AfterEach
    void close() throws Exception {
        harness.close();
    }

    /**
     * A save walks the journeys twice: at its first delete row and when it goes
     * live. The walk costs about 0.1 µs per journey without TTL cleanup on each
     * selected key, and about 20 to 30 µs with it, so 20,000 journeys take about
     * 4 ms or about a second. The budget sits between the two, far enough from
     * each that a slow or busy machine does not change the result.
     */
    @Test
    void aSaveDoesNotPayForTheJourneysBufferedForOtherCampaigns() throws Exception {
        harness = new KeyedBroadcastOperatorTestHarness<>(
            new CoBroadcastWithKeyedOperator<>(
                new JourneyStateMachineFunction(GRAPHS, 1000, 4_194_304L, 7_776_000_000L, 300_000L),
                List.of(GRAPHS, JourneyStateMachineFunction.GRAPH_LOADS)),
            VersionedTrigger::journeyKey, Types.STRING, 128, 1, 0);
        harness.open();
        save("campaign-1", 1L);
        for (int i = 0; i < BUFFERED_JOURNEYS; i++) {
            harness.processElement(new VersionedTrigger(trigger("canon-" + i, "campaign-2"), null), T_10_01);
        }

        List<Long> saveNanos = new ArrayList<>();
        for (long version = 2L; version <= 6L; version++) {
            long start = System.nanoTime();
            save("campaign-1", version);
            saveNanos.add(System.nanoTime() - start);
        }
        Collections.sort(saveNanos);
        save("campaign-2", 1L);

        assertTrue(saveNanos.get(2) < SAVE_BUDGET_NANOS,
            "median save took " + saveNanos.get(2) / 1_000_000 + " ms with " + BUFFERED_JOURNEYS
                + " journeys buffered for another campaign");
        assertEquals(2 * BUFFERED_JOURNEYS, harness.extractOutputValues().size(),
            "each buffered journey completes n1_view and n5_sms once campaign-2 goes live");
    }

    /**
     * Takes down the campaign's previous graph, if any, and saves n1_view ->
     * n5_sms.
     */
    private void save(String campaignId, long version) throws Exception {
        if (version > 1L) {
            harness.processBroadcastElement(node(campaignId, "n1_view", null, RowKind.DELETE, version - 1), 0L);
            harness.processBroadcastElement(node(campaignId, "n5_sms", "n1_view", RowKind.DELETE, version - 1), 0L);
        }
        harness.processBroadcastElement(node(campaignId, "n1_view", null, RowKind.INSERT, version), 0L);
        harness.processBroadcastElement(node(campaignId, "n5_sms", "n1_view", RowKind.INSERT, version), 0L);
    }

    private static JourneyTriggerEvent trigger(String canonId, String campaignId) {
        return new JourneyTriggerEvent(canonId, "domain-1", null, "user-1", campaignId, "n1_view", "next", "event",
            T_10_01, "{}");
    }

    private static Row node(String campaignId, String nodeId, String parentNodeId, RowKind kind, long version) {
        Row row = Row.withNames(kind);
        row.setField("campaign_id", campaignId);
        row.setField("node_id", nodeId);
        row.setField("node_type", parentNodeId == null ? "setup" : "engagement");
        row.setField("parent_node_id", parentNodeId);
        row.setField("parent_branch", parentNodeId == null ? null : "next");
        row.setField("trigger_json", null);
        row.setField("conditions_json", null);
        row.setField("paths_json", null);
        row.setField("action_json", parentNodeId == null ? null : "{\"channel\":\"sms\"}");
        row.setField("goal_id", null);
        row.setField("campaign_node_count", 2);
        row.setField("graph_version", version);
        return row;
    }
}
