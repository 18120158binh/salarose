package com.cdp.platform.jobs.outbox;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

import org.apache.flink.api.common.serialization.SerializerConfigImpl;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.configuration.Configuration;
import org.apache.flink.configuration.CoreOptions;
import org.apache.flink.runtime.OperatorIDPair;
import org.apache.flink.runtime.jobgraph.JobGraph;
import org.apache.flink.runtime.jobgraph.JobVertex;
import org.apache.flink.streaming.api.graph.StreamGraph;
import org.apache.flink.streaming.api.graph.StreamNode;
import org.apache.flink.streaming.api.operators.OneInputStreamOperatorFactory;
import org.apache.flink.streaming.api.operators.async.AsyncWaitOperatorFactory;
import org.apache.flink.streaming.runtime.operators.sink.CommitterOperatorFactory;
import org.apache.flink.streaming.runtime.operators.sink.SinkWriterOperatorFactory;
import org.apache.flink.streaming.util.OneInputStreamOperatorTestHarness;
import org.apache.flink.util.InstantiationUtil;

import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.db.repositories.CdcStreamOrder;
import com.cdp.platform.shared.models.NotificationEvent;
import com.cdp.platform.shared.models.db.UserCampaignState;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class CampaignOutboxJobGraphTest {

    private static final DatabaseConfig DATABASE = new DatabaseConfig("postgres", "5432", "cdp", "unused", "cdp",
        "jdbc:postgresql://postgres:5432/cdp", "jdbc:postgresql://postgres-replica:5432/cdp", 10);

    /**
     * For each shape of the job and each uid, the operator id that Flink generated
     * for the outbox job at 0681d821, read from that commit's graph, and whether it
     * names a job vertex. A test derived them again from the current graph until
     * the CDC source became the incremental snapshot source, which changed the
     * graph's shape.
     */
    private static final String IDS_BEFORE_UIDS = "/outbox-operator-ids-before-uids.tsv";

    /** The uid the job already had at 0681d821. Its operator id never changed. */
    private static final String UID_BEFORE = "outbox-profile-lookup";

    /** The flows a job runs, as ENABLE_OUTBOX and ENABLE_TIMER set them. */
    private enum Shape {
        BOTH("both", true, true), OUTBOX_ONLY("outbox-only", true, false), TIMER_ONLY("timer-only", false, true);

        final String name;
        final boolean outbox;
        final boolean timer;

        Shape(String name, boolean outbox, boolean timer) {
            this.name = name;
            this.outbox = outbox;
            this.timer = timer;
        }
    }

    /**
     * Each CDC source runs on one subtask, and its changes reach every broadcast
     * through forward channels on one subtask, so no change overtakes an earlier
     * one.
     */
    @Test
    void everyCdcStreamKeepsItsLogOrder() {
        assertEquals(List.of(),
            CdcStreamOrder.breaks(CampaignOutboxJob.buildPipeline(DATABASE, CdcStreamOrder.settings(), true, true)));
    }

    /**
     * A savepoint restores an operator's state only under the same id, so each
     * operator that keeps state must keep its id: its uid from before, or the id
     * listed for it.
     */
    @Test
    void everyOperatorThatKeepsStateKeepsItsIdFromBefore() throws IOException {
        for (Shape shape : Shape.values()) {
            Set<String> keptIds = new HashSet<>(listedIdsBeforeUids(shape).keySet());
            keptIds.add(UID_BEFORE);
            StreamGraph graph = CampaignOutboxJob
                .buildPipeline(DATABASE, new Configuration(), shape.outbox, shape.timer)
                .getStreamGraph();

            List<String> withoutKeptId = graph
                .getStreamNodes()
                .stream()
                .filter(node -> keepsState(graph, node))
                .filter(node -> !keptIds.contains(node.getTransformationUID()))
                .map(node -> node.getOperatorName() + " uid=" + node.getTransformationUID())
                .sorted()
                .toList();

            assertEquals(List.of(), withoutKeptId, shape.name);
        }
    }

    @Test
    void theJobCarriesEachListedIdBeforeUids() throws IOException {
        for (Shape shape : Shape.values()) {
            Map<String, String> listedIdByUid = new TreeMap<>();
            listedIdsBeforeUids(shape).forEach((uid, entry) -> listedIdByUid.put(uid, entry.split("\t")[0]));

            for (int parallelism : List.of(1, 2, 8)) {
                assertEquals(listedIdByUid, carriedIdByUid(shape, parallelism),
                    shape.name + " at parallelism " + parallelism);
            }
        }
    }

    /**
     * The profile lookup reaches the task manager as Flink ships it, and opens its
     * pool there from the job's database settings. The test sets no {@code DB_}
     * variables, like a task manager that has none.
     */
    @Test
    @SuppressWarnings("unchecked")
    void theProfileLookupOpensItsPoolFromTheJobsDatabaseSettings() throws Exception {
        StreamGraph graph = CampaignOutboxJob.buildPipeline(DATABASE, new Configuration(), true, true).getStreamGraph();
        OneInputStreamOperatorFactory<UserCampaignState, NotificationEvent> factory = (OneInputStreamOperatorFactory<UserCampaignState, NotificationEvent>) InstantiationUtil
            .clone(graph
                .getStreamNodes()
                .stream()
                .filter(node -> UID_BEFORE.equals(node.getTransformationUID()))
                .findFirst()
                .orElseThrow()
                .getOperatorFactory());

        try (var harness = new OneInputStreamOperatorTestHarness<UserCampaignState, NotificationEvent>(factory,
            TypeInformation.of(UserCampaignState.class).createSerializer(new SerializerConfigImpl()))) {
            assertDoesNotThrow(harness::open);
        }
    }

    private static Map<String, String> carriedIdByUid(Shape shape, int parallelism) {
        Configuration settings = new Configuration();
        settings.set(CoreOptions.DEFAULT_PARALLELISM, parallelism);
        JobGraph job = CampaignOutboxJob
            .buildPipeline(DATABASE, settings, shape.outbox, shape.timer)
            .getStreamGraph()
            .getJobGraph();

        Map<String, String> carried = new TreeMap<>();
        for (JobVertex vertex : job.getVertices()) {
            for (OperatorIDPair operator : vertex.getOperatorIDs()) {
                operator
                    .getUserDefinedOperatorID()
                    .ifPresent(id -> carried.put(operator.getUserDefinedOperatorUid(), id.toHexString()));
            }
        }
        return carried;
    }

    /**
     * Reads the ids listed for the shape as uid to "id, tab, vertex or chained".
     */
    private static Map<String, String> listedIdsBeforeUids(Shape shape) throws IOException {
        try (InputStream input = CampaignOutboxJobGraphTest.class.getResourceAsStream(IDS_BEFORE_UIDS)) {
            Map<String, String> listed = new TreeMap<>();
            new String(input.readAllBytes(), StandardCharsets.UTF_8)
                .lines()
                .filter(line -> !line.isBlank() && !line.startsWith("#"))
                .map(line -> line.split("\t", 3))
                .filter(columns -> columns[0].equals(shape.name))
                .forEach(columns -> listed.put(columns[1], columns[2]));
            return listed;
        }
    }

    private static boolean keepsState(StreamGraph graph, StreamNode node) {
        return graph.getSourceIDs().contains(node.getId())
            || node.getStateKeySerializer() != null
            || node.getOperatorFactory() instanceof AsyncWaitOperatorFactory
            || node.getOperatorFactory() instanceof SinkWriterOperatorFactory
            || node.getOperatorFactory() instanceof CommitterOperatorFactory;
    }
}
