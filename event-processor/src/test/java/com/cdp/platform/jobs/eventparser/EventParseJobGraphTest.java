package com.cdp.platform.jobs.eventparser;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;

import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.configuration.CoreOptions;
import org.apache.flink.runtime.OperatorIDPair;
import org.apache.flink.runtime.jobgraph.JobGraph;
import org.apache.flink.streaming.api.graph.StreamGraph;
import org.apache.flink.streaming.api.graph.StreamNode;
import org.apache.flink.streaming.api.operators.StreamOperatorFactory;
import org.apache.flink.streaming.runtime.operators.sink.SinkWriterOperatorFactory;
import org.apache.flink.streaming.util.KeyedOneInputStreamOperatorTestHarness;
import org.apache.flink.util.InstantiationUtil;

import com.cdp.platform.jobs.eventparser.identity.IdentityStitcherFunction;
import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.db.repositories.CdcStreamOrder;
import com.cdp.platform.shared.models.ParsedEvent;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class EventParseJobGraphTest {

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
            CdcStreamOrder.breaks(EventParseJob.buildPipeline(DATABASE, CdcStreamOrder.settings())));
    }

    /**
     * A savepoint holds an entry for every operator, stateless ones included, and
     * an operator without a uid gets an id generated from the shape of the graph,
     * so any change to the graph would strand its entry.
     */
    @Test
    void everyOperatorHasAnExplicitUid() {
        StreamGraph graph = EventParseJob.buildPipeline(DATABASE, new Configuration()).getStreamGraph();

        List<String> withoutUid = graph
            .getStreamNodes()
            .stream()
            .filter(node -> node.getTransformationUID() == null)
            .map(StreamNode::getOperatorName)
            .sorted()
            .toList();

        assertEquals(List.of(), withoutUid);
    }

    /** The id Flink generated for the source before the job had a schema gate. */
    @Test
    void theKafkaSourceKeepsTheIdItHadBeforeTheSchemaGate() {
        for (int parallelism : List.of(1, 2, 8)) {
            Configuration settings = new Configuration();
            settings.set(CoreOptions.DEFAULT_PARALLELISM, parallelism);
            JobGraph job = EventParseJob.buildPipeline(DATABASE, settings).getStreamGraph().getJobGraph();

            Optional<String> carried = job
                .getVerticesSortedTopologicallyFromSources()
                .stream()
                .flatMap(vertex -> vertex.getOperatorIDs().stream())
                .filter(operator -> "snowplow-good-source".equals(operator.getUserDefinedOperatorUid()))
                .map(OperatorIDPair::getUserDefinedOperatorID)
                .flatMap(Optional::stream)
                .map(id -> id.toHexString())
                .findFirst();

            assertEquals(Optional.of("cbc357ccb763df2852fee8c4fc7d55f2"), carried, "parallelism " + parallelism);
        }
    }

    /**
     * The ids that the stateful operators had before the parser became a
     * DataStream function, so a savepoint from then restores their state. The
     * values were read from the job graph of both versions at parallelism 2.
     */
    @Test
    void theStatefulOperatorsKeepTheirIdsAcrossTheTypedParser() {
        Map<String, String> expected = new TreeMap<>(Map
            .of("snowplow-good-source", "cbc357ccb763df2852fee8c4fc7d55f2", "catalog-events-source",
                "3eb22acf4dcb1565771c82c6c474f37c", "catalog-attributes-source", "8d4adc0f5c5f12c9da46d733d6bce264",
                "catalog-schema-gate", "2660f294e5ff6612d136e35a8fffb3fc", "identity-stitcher",
                "2a4497189d7cd2d44885f4f3a3636485", "postgres-identity-graph-sink",
                "e27ff1663b1c135df20a7acaa188e3a6"));
        Configuration settings = new Configuration();
        settings.set(CoreOptions.DEFAULT_PARALLELISM, 2);
        JobGraph job = EventParseJob.buildPipeline(DATABASE, settings).getStreamGraph().getJobGraph();

        Map<String, String> actual = new TreeMap<>();
        job
            .getVerticesSortedTopologicallyFromSources()
            .stream()
            .flatMap(vertex -> vertex.getOperatorIDs().stream())
            .filter(operator -> operator.getUserDefinedOperatorUid() != null)
            .filter(operator -> expected.containsKey(operator.getUserDefinedOperatorUid()))
            .forEach(operator -> actual
                .put(operator.getUserDefinedOperatorUid(), operator
                    .getUserDefinedOperatorID()
                    .orElse(operator.getGeneratedOperatorID())
                    .toHexString()));

        assertEquals(expected, actual);
    }

    @Test
    void droppedPayloadsAndEventsGoToTheDeadLetterSink() {
        StreamGraph graph = EventParseJob.buildPipeline(DATABASE, new Configuration()).getStreamGraph();

        StreamNode writer = graph
            .getStreamNodes()
            .stream()
            .filter(node -> node.getOperatorFactory() instanceof SinkWriterOperatorFactory)
            .filter(node -> "dead-letter-sink".equals(node.getTransformationUID()))
            .findFirst()
            .orElseThrow();
        List<String> inputs = writer
            .getInEdges()
            .stream()
            .map(edge -> graph.getStreamNode(edge.getSourceId()).getTransformationUID())
            .sorted()
            .toList();

        assertEquals(List.of("catalog-schema-gate", "parse-api-events", "parse-snowplow-events"), inputs);
    }

    /**
     * The stitcher reaches the task manager as Flink ships it, and opens its lookup
     * pool there from the job's database settings. The test sets no {@code DB_}
     * variables, like a task manager that has none.
     */
    @Test
    void theStitcherOpensItsLookupPoolFromTheJobsDatabaseSettings() throws Exception {
        StreamGraph graph = EventParseJob.buildPipeline(DATABASE, new Configuration()).getStreamGraph();
        StreamOperatorFactory<ParsedEvent> stitcher = InstantiationUtil
            .clone(operatorFactory(graph, "identity-stitcher"));

        try (var harness = new KeyedOneInputStreamOperatorTestHarness<String, ParsedEvent, ParsedEvent>(stitcher,
            IdentityStitcherFunction::keyOf, Types.STRING)) {
            assertDoesNotThrow(harness::open);
        }
    }

    @SuppressWarnings("unchecked")
    private static StreamOperatorFactory<ParsedEvent> operatorFactory(StreamGraph graph, String uid) {
        return (StreamOperatorFactory<ParsedEvent>) graph
            .getStreamNodes()
            .stream()
            .filter(node -> uid.equals(node.getTransformationUID()))
            .findFirst()
            .orElseThrow()
            .getOperatorFactory();
    }
}
