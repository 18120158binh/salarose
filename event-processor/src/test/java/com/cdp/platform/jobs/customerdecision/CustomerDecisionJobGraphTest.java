package com.cdp.platform.jobs.customerdecision;

import java.util.List;

import org.apache.flink.api.common.functions.MapFunction;
import org.apache.flink.api.common.serialization.SerializerConfigImpl;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.api.common.typeinfo.Types;
import org.apache.flink.api.java.functions.KeySelector;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.configuration.StateBackendOptions;
import org.apache.flink.runtime.jobgraph.JobGraph;
import org.apache.flink.runtime.state.StateBackend;
import org.apache.flink.runtime.state.StateBackendLoader;
import org.apache.flink.state.rocksdb.EmbeddedRocksDBStateBackend;
import org.apache.flink.streaming.api.graph.StreamGraph;
import org.apache.flink.streaming.api.graph.StreamNode;
import org.apache.flink.streaming.api.operators.OneInputStreamOperatorFactory;
import org.apache.flink.streaming.api.operators.SimpleOperatorFactory;
import org.apache.flink.streaming.api.operators.SimpleUdfStreamOperatorFactory;
import org.apache.flink.streaming.api.operators.StreamOperatorFactory;
import org.apache.flink.streaming.api.operators.async.AsyncWaitOperatorFactory;
import org.apache.flink.streaming.api.operators.co.CoBroadcastWithKeyedOperator;
import org.apache.flink.streaming.runtime.operators.sink.CommitterOperatorFactory;
import org.apache.flink.streaming.runtime.operators.sink.SinkWriterOperatorFactory;
import org.apache.flink.streaming.runtime.partitioner.BroadcastPartitioner;
import org.apache.flink.streaming.runtime.partitioner.KeyGroupStreamPartitioner;
import org.apache.flink.streaming.util.KeyedBroadcastOperatorTestHarness;
import org.apache.flink.streaming.util.OneInputStreamOperatorTestHarness;
import org.apache.flink.types.Either;
import org.apache.flink.types.Row;
import org.apache.flink.util.InstantiationUtil;

import com.cdp.platform.jobs.customerdecision.transforms.CustomerBehaviorProcessFunction;
import com.cdp.platform.jobs.customerdecision.transforms.Decision;
import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.db.repositories.CdcStreamOrder;
import com.cdp.platform.shared.models.Event;
import com.cdp.platform.shared.models.SegmentCheck;
import com.cdp.platform.shared.models.db.MetricConfig;
import com.cdp.platform.shared.models.db.UserProfile;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;

import org.junit.jupiter.api.Test;

class CustomerDecisionJobGraphTest {

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
            CdcStreamOrder.breaks(CustomerDecisionJob.buildPipeline(DATABASE, CdcStreamOrder.settings())));
    }

    @Test
    void everyOperatorThatKeepsStateHasAnExplicitUid() {
        StreamGraph graph = CustomerDecisionJob.buildPipeline(DATABASE, new Configuration()).getStreamGraph();

        List<String> withoutUid = graph
            .getStreamNodes()
            .stream()
            .filter(node -> keepsState(graph, node))
            .filter(node -> node.getTransformationUID() == null)
            .map(StreamNode::getOperatorName)
            .sorted()
            .toList();

        assertEquals(List.of(), withoutUid);
    }

    @Test
    void stateIsKeptInRocksDbEvenWhenTheClusterDefaultsToHeap() throws Exception {
        JobGraph job = CustomerDecisionJob.buildPipeline(DATABASE, new Configuration()).getStreamGraph().getJobGraph();
        Configuration cluster = new Configuration();
        cluster.set(StateBackendOptions.STATE_BACKEND, "hashmap");

        StateBackend backend = StateBackendLoader
            .fromApplicationOrConfigOrDefault(null, job.getJobConfiguration(), cluster,
                getClass().getClassLoader(), null);

        assertInstanceOf(EmbeddedRocksDBStateBackend.class, backend);
    }

    /**
     * The behavior state reaches the task manager as Flink ships it, and opens its
     * {@code user_metrics} pool there from the job's database settings. The test
     * sets no {@code DB_} variables, like a task manager that has none.
     */
    @Test
    @SuppressWarnings("unchecked")
    void theBehaviorStateOpensItsPoolFromTheJobsDatabaseSettings() throws Exception {
        StreamGraph graph = CustomerDecisionJob.buildPipeline(DATABASE, new Configuration()).getStreamGraph();
        SimpleOperatorFactory<Decision> factory = (SimpleOperatorFactory<Decision>) InstantiationUtil
            .clone(operatorFactory(graph, "apply-behavior-state"));

        try (var harness = new KeyedBroadcastOperatorTestHarness<>(
            (CoBroadcastWithKeyedOperator<String, Either<Event, SegmentCheck>, Either<Either<MetricConfig, Row>, Either<Row, Row>>, Decision>) factory
                .getOperator(),
            CustomerBehaviorProcessFunction::canonIdOf, Types.STRING, 128, 1, 0)) {
            assertDoesNotThrow(harness::open);
        }
    }

    /**
     * The lookup reaches the task manager as Flink ships it, and opens its profile
     * pool there from the job's database settings.
     */
    @Test
    @SuppressWarnings("unchecked")
    void theLookupOpensItsPoolFromTheJobsDatabaseSettings() throws Exception {
        StreamGraph graph = CustomerDecisionJob.buildPipeline(DATABASE, new Configuration()).getStreamGraph();
        OneInputStreamOperatorFactory<Decision, Decision> factory = (OneInputStreamOperatorFactory<Decision, Decision>) InstantiationUtil
            .clone(operatorFactory(graph, "profile-field-lookup"));

        try (var harness = new OneInputStreamOperatorTestHarness<Decision, Decision>(factory,
            TypeInformation.of(Decision.class).createSerializer(new SerializerConfigImpl()))) {
            assertDoesNotThrow(harness::open);
        }
    }

    /**
     * The decisions that need no profile and the ones that come back from the
     * lookup reach the operator that releases triggers keyed by person, so one
     * subtask puts each person's decisions in order.
     */
    @Test
    @SuppressWarnings("unchecked")
    void everyDecisionOfAPersonReachesTheSubtaskThatReleasesTheirTriggers() throws Exception {
        StreamGraph graph = CustomerDecisionJob.buildPipeline(DATABASE, new Configuration()).getStreamGraph();
        StreamNode release = node(graph, "release-triggers-in-order");
        KeySelector<Decision, ?> key = (KeySelector<Decision, ?>) release.getStatePartitioners()[0];
        Decision decision = new Decision(new Event("customer-42", "d1", null, null, "view_page", 1_785_800_000_000L,
            null, null, null, null, "web", "{}", "view-1"), 1, true, List.of(), UserProfile.empty());

        assertEquals(List.of("apply-behavior-state", "profile-field-lookup"), release
            .getInEdges()
            .stream()
            .map(edge -> graph.getStreamNode(edge.getSourceId()).getTransformationUID())
            .sorted()
            .toList());
        assertEquals(List.of(true, true), release
            .getInEdges()
            .stream()
            .map(edge -> edge.getPartitioner() instanceof KeyGroupStreamPartitioner)
            .toList());
        assertEquals("customer-42", key.getKey(decision));
    }

    /**
     * A metric definition change reaches the behavior state on the left side of
     * its update, holding the definition on the left, after Flink ships each map
     * to the task manager.
     */
    @Test
    void aShippedMetricDefinitionChangeReachesTheBehaviorState() throws Exception {
        StreamGraph graph = CustomerDecisionJob.buildPipeline(DATABASE, new Configuration()).getStreamGraph();
        MetricConfig definition = new MetricConfig("m_cart_value", "cart value", "", "add_to_cart", null, null, "SUM",
            "value", "NUMBER", 86_400_000L, true);

        assertEquals(Either.Left(Either.Left(definition)),
            shippedMap(graph, "metric-definition-updates").map(definition));
    }

    /**
     * A segment change reaches the behavior state on the left side of its update,
     * holding the segment row on the right.
     */
    @Test
    void aShippedSegmentChangeReachesTheBehaviorState() throws Exception {
        StreamGraph graph = CustomerDecisionJob.buildPipeline(DATABASE, new Configuration()).getStreamGraph();
        Row segment = Row.of("SEG-3f9a0c1d7e2b4a65", "{\"groups\":[]}");

        assertEquals(Either.Left(Either.Right(segment)), shippedMap(graph, "segment-updates").map(segment));
    }

    /**
     * A campaign change reaches the behavior state as the right side of its
     * update, holding the campaign row on the left.
     */
    @Test
    void aShippedCampaignChangeReachesTheBehaviorState() throws Exception {
        StreamGraph graph = CustomerDecisionJob.buildPipeline(DATABASE, new Configuration()).getStreamGraph();
        Row campaign = Row.of("campaign-7", "active");

        Object update = shippedMap(graph, "campaign-updates").map(campaign);

        assertEquals(Either.Left(campaign), update);
        assertEquals(Either.Right(update), shippedMap(graph, "behavior-rule-updates").map(update));
    }

    /**
     * A campaign node change reaches the behavior state as the right side of its
     * update, holding the node row on the right.
     */
    @Test
    void aShippedCampaignNodeChangeReachesTheBehaviorState() throws Exception {
        StreamGraph graph = CustomerDecisionJob.buildPipeline(DATABASE, new Configuration()).getStreamGraph();
        Row node = Row.of("node-3", "campaign-7");

        Object update = shippedMap(graph, "campaign-node-updates").map(node);

        assertEquals(Either.Right(node), update);
        assertEquals(Either.Right(update), shippedMap(graph, "behavior-rule-updates").map(update));
    }

    /**
     * Events and segment checks reach the behavior state as the two sides of its
     * input.
     */
    @Test
    void shippedEventsAndSegmentChecksReachTheBehaviorState() throws Exception {
        StreamGraph graph = CustomerDecisionJob.buildPipeline(DATABASE, new Configuration()).getStreamGraph();
        Event event = new Event("customer-42", "d1", null, null, "view_page", 1_785_800_000_000L, null, null, null,
            null, "web", "{}", "view-1");
        SegmentCheck check = new SegmentCheck(1, "event-1", "customer-42", "d-1", "n-1", "u-1", "campaign-7",
            "node-3", "add_to_cart", 1_785_800_000_000L);

        assertEquals(Either.Left(event), shippedMap(graph, "event-inputs").map(event));
        assertEquals(Either.Right(check), shippedMap(graph, "segment-check-inputs").map(check));
    }

    /** The map of a node as Flink ships it: through Java serialization. */
    @SuppressWarnings("unchecked")
    private static MapFunction<Object, Object> shippedMap(StreamGraph graph, String uid) throws Exception {
        SimpleUdfStreamOperatorFactory<?> factory = (SimpleUdfStreamOperatorFactory<?>) InstantiationUtil
            .clone(operatorFactory(graph, uid));
        return (MapFunction<Object, Object>) factory.getUserFunction();
    }

    private static StreamOperatorFactory<?> operatorFactory(StreamGraph graph, String uid) {
        return node(graph, uid).getOperatorFactory();
    }

    private static StreamNode node(StreamGraph graph, String uid) {
        return graph
            .getStreamNodes()
            .stream()
            .filter(node -> uid.equals(node.getTransformationUID()))
            .findFirst()
            .orElseThrow();
    }

    private static boolean keepsState(StreamGraph graph, StreamNode node) {
        return graph.getSourceIDs().contains(node.getId())
            || node.getStateKeySerializer() != null
            || node.getInEdges().stream().anyMatch(edge -> edge.getPartitioner() instanceof BroadcastPartitioner)
            || node.getOperatorFactory() instanceof AsyncWaitOperatorFactory
            || node.getOperatorFactory() instanceof SinkWriterOperatorFactory
            || node.getOperatorFactory() instanceof CommitterOperatorFactory;
    }
}
