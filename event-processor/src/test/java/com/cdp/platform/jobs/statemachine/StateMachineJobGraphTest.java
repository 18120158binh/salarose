package com.cdp.platform.jobs.statemachine;

import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import org.apache.flink.configuration.Configuration;
import org.apache.flink.runtime.OperatorIDPair;
import org.apache.flink.runtime.jobgraph.JobGraph;
import org.apache.flink.runtime.jobgraph.JobVertex;
import org.apache.flink.streaming.api.graph.StreamGraph;
import org.apache.flink.streaming.api.graph.StreamGraphHasherV2;
import org.apache.flink.streaming.api.graph.StreamNode;
import org.apache.flink.streaming.runtime.operators.sink.CommitterOperatorFactory;
import org.apache.flink.streaming.runtime.operators.sink.SinkWriterOperatorFactory;
import org.apache.flink.util.StringUtils;

import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.db.repositories.CdcStreamOrder;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class StateMachineJobGraphTest {

    private static final DatabaseConfig DATABASE = new DatabaseConfig("postgres", "5432", "cdp", "unused", "cdp",
        "jdbc:postgresql://postgres:5432/cdp", "jdbc:postgresql://postgres-replica:5432/cdp", 10);

    /**
     * Each CDC source runs on one subtask, and its changes reach every broadcast
     * through forward channels on one subtask, so no change overtakes an earlier
     * one.
     */
    @Test
    void everyCdcStreamKeepsItsLogOrder() {
        assertEquals(List.of(),
            CdcStreamOrder.breaks(StateMachineJob.buildPipeline(DATABASE, CdcStreamOrder.settings())));
    }

    /**
     * The transitions sink has no uid of its own from before. Flink generated its
     * writer and committer ids from the graph, and the segment check sink moved
     * the committer's. The job carries the ids the graph had before that sink, so
     * a savepoint from then restores without {@code allowNonRestoredState}.
     */
    @Test
    void theTransitionsSinkKeepsTheIdsFromBeforeTheSegmentCheckSink() {
        JobGraph job = StateMachineJob.buildPipeline(DATABASE, new Configuration()).getStreamGraph().getJobGraph();

        Map<String, String> carriedIdByUid = new TreeMap<>();
        for (JobVertex vertex : job.getVertices()) {
            for (OperatorIDPair operator : vertex.getOperatorIDs()) {
                operator
                    .getUserDefinedOperatorID()
                    .ifPresent(id -> carriedIdByUid.put(operator.getUserDefinedOperatorUid(), id.toHexString()));
            }
        }

        assertEquals(Map
            .of("transition-sink", "99bf186e8bb5d3054d391ce0ef242107", "Sink Committer: transition-sink",
                "43afce22915d2b59ca28b835a428866d"),
            Map
                .of("transition-sink", String.valueOf(carriedIdByUid.get("transition-sink")),
                    "Sink Committer: transition-sink",
                    String.valueOf(carriedIdByUid.get("Sink Committer: transition-sink"))));
    }

    /**
     * A savepoint restores an operator's state only under the same id. The Kafka
     * and CDC sources have no uid, so Flink generates their ids from the shape of
     * the graph. These are the ids of every operator that keeps state, read from
     * the graph at cc0b9f90. A change that moves one needs an upgrade note.
     */
    @Test
    void everyOperatorThatKeepsStateKeepsItsId() {
        StreamGraph graph = StateMachineJob.buildPipeline(DATABASE, new Configuration()).getStreamGraph();
        Map<Integer, byte[]> generated = new StreamGraphHasherV2().traverseStreamGraphAndGenerateHashes(graph);

        Map<String, String> idByOperator = new TreeMap<>();
        for (StreamNode node : graph.getStreamNodes()) {
            if (keepsState(graph, node)) {
                String id = node.getUserHash() != null
                    ? node.getUserHash()
                    : StringUtils.byteToHexString(generated.get(node.getId()));
                // The name of a table source ends in a transformation number, which
                // is not part of the id.
                idByOperator.put(node.getOperatorName().replaceAll("\\[\\d+]$", ""), id);
            }
        }

        assertEquals(Map
            .of("Source: state_machine_journey_triggers", "cbc357ccb763df2852fee8c4fc7d55f2",
                "Source: state_machine_campaign_nodes_cdc", "6cdc5bb954874d922eaee11a8e7b5dd5",
                "Immediate Keyed Journey BFS", "dcce7b3d8a1eb15cbd1dc46e2f2a8a17",
                "Postgres User Campaign State Transition Sink: Writer", "99bf186e8bb5d3054d391ce0ef242107",
                "Postgres User Campaign State Transition Sink: Committer", "43afce22915d2b59ca28b835a428866d",
                "Segment Check Sink: Writer", "e2017ce4c58340245702cfc6162b7ba0",
                "Segment Check Sink: Committer", "03372bf5dfd7d3696f59a0b7c04bacd2"),
            idByOperator);
    }

    private static boolean keepsState(StreamGraph graph, StreamNode node) {
        return graph.getSourceIDs().contains(node.getId())
            || node.getStateKeySerializer() != null
            || node.getOperatorFactory() instanceof SinkWriterOperatorFactory
            || node.getOperatorFactory() instanceof CommitterOperatorFactory;
    }
}
