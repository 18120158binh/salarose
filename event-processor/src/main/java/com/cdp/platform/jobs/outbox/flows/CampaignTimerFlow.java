package com.cdp.platform.jobs.outbox.flows;

import java.util.ArrayList;
import java.util.List;
import java.util.Properties;

import org.apache.flink.api.common.functions.FlatMapFunction;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.connector.base.DeliveryGuarantee;
import org.apache.flink.connector.kafka.sink.KafkaRecordSerializationSchema;
import org.apache.flink.connector.kafka.sink.KafkaSink;
import org.apache.flink.streaming.api.datastream.CustomSinkOperatorUidHashes;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.util.Collector;

import com.cdp.platform.shared.config.EnvironmentSettings;
import com.cdp.platform.shared.config.KafkaSecurityConfig;
import com.cdp.platform.shared.models.JourneyTriggerEvent;
import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.models.db.UserCampaignState;
import com.cdp.platform.shared.models.db.WatchChild;
import com.cdp.platform.shared.utils.JsonSerializationSchema;
import com.cdp.platform.shared.utils.KeySerializationSchema;

public class CampaignTimerFlow {

    /**
     * The operators carry the ids in {@code idsBeforeUids}, so a savepoint taken
     * before they had uids keeps the pending watches.
     */
    public static void build(DataStream<UserCampaignState> stateTransitions, IdsBeforeUids idsBeforeUids) {
        DataStream<WatchTimeout> watchTimeouts = stateTransitions
            .flatMap(new WatchTimeoutExtractor())
            .returns(TypeInformation.of(WatchTimeout.class));

        DataStream<VersionedTrigger> timeoutEvents = watchTimeouts
            .keyBy(WatchTimeout::journeyKey)
            .process(new WatchTimerProcessFunction())
            .returns(TypeInformation.of(VersionedTrigger.class))
            .uid("watch-timers")
            .setUidHash(idsBeforeUids.timers());

        EnvironmentSettings env = EnvironmentSettings.system();
        timeoutEvents
            .sinkTo(createTimeoutSink(env.kafkaBrokers("CAMPAIGN_TIMER_"), env.journeyTriggerTopic(),
                KafkaSecurityConfig.fromEnvironment("CAMPAIGN_TIMER_")),
                idsBeforeUids.sink())
            .uid("watch-timeout-sink");
    }

    /**
     * The ids Flink generated for the timer operator and the timeout sink before
     * they had uids. They depend on the other flows in the job.
     */
    public record IdsBeforeUids(String timers, CustomSinkOperatorUidHashes sink) {
    }

    private static KafkaSink<VersionedTrigger> createTimeoutSink(String brokers, String topic,
        KafkaSecurityConfig security) {
        Properties properties = security.clientProperties();
        KafkaRecordSerializationSchema<VersionedTrigger> serializer = KafkaRecordSerializationSchema
            .<VersionedTrigger>builder()
            .setTopic(topic)
            .setKeySerializationSchema(
                new KeySerializationSchema<>(VersionedTrigger.class, VersionedTrigger::journeyKey))
            .setValueSerializationSchema(new JsonSerializationSchema<>(VersionedTrigger.class))
            .build();

        return KafkaSink
            .<VersionedTrigger>builder()
            .setBootstrapServers(brokers)
            .setKafkaProducerConfig(properties)
            .setRecordSerializer(serializer)
            .setDeliveryGuarantee(DeliveryGuarantee.AT_LEAST_ONCE)
            .build();
    }

    /**
     * The timeouts of the watch children that a completed node lists. Each
     * fires at its deadline, the node's event time plus the watch limit, on the
     * branch the watch listed, and carries the version of the graph that listed
     * it and the entry the node completed in.
     */
    static List<WatchTimeout> watchTimeouts(UserCampaignState state) {
        List<WatchTimeout> timeouts = new ArrayList<>();
        for (WatchChild watch : state.watchChildren()) {
            timeouts
                .add(new WatchTimeout(state.canonId(), state.domainUserId(), state.networkUserId(), state.userId(),
                    state.campaignId(), state.entryId(), state.eventId(), state.contextJson(), watch.nodeId(),
                    watch.deadlineBranch().name(), watch.deadlineAfter(state.eventTimestamp()),
                    watch.graphVersion()));
        }
        return timeouts;
    }

    private static final class WatchTimeoutExtractor implements FlatMapFunction<UserCampaignState, WatchTimeout> {
        @Override
        public void flatMap(UserCampaignState state, Collector<WatchTimeout> out) {
            watchTimeouts(state).forEach(out::collect);
        }
    }

    /**
     * The timeout trigger that a watch emits at its deadline, for the entry of
     * the transition that started the watch, with the graph version that listed
     * the watch.
     */
    public record WatchTimeout(String canonId, String domainUserId, String networkUserId, String userId,
        String campaignId, String entryId, String eventId, String contextJson, String nodeId, String branch,
        long deadline, long graphVersion) {

        String journeyKey() {
            return canonId + JourneyTriggerEvent.JOURNEY_KEY_SEPARATOR + campaignId;
        }

        /** The watch within its journey key: one per entry and watch node. */
        String watchKey() {
            return entryId + JourneyTriggerEvent.JOURNEY_KEY_SEPARATOR + nodeId;
        }

        VersionedTrigger toTrigger() {
            return new VersionedTrigger(new JourneyTriggerEvent(JourneyTriggerEvent.SCHEMA_VERSION, eventId, canonId,
                domainUserId, networkUserId, userId, campaignId, nodeId, branch, branch, deadline, contextJson),
                graphVersion, entryId);
        }
    }

}
