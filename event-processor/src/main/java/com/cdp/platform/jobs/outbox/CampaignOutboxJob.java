package com.cdp.platform.jobs.outbox;

import org.apache.flink.configuration.Configuration;
import org.apache.flink.streaming.api.datastream.CustomSinkOperatorUidHashes;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.streaming.api.environment.StreamExecutionEnvironment;
import org.apache.flink.table.api.bridge.java.StreamTableEnvironment;

import com.cdp.platform.jobs.outbox.flows.CampaignOutboxFlow;
import com.cdp.platform.jobs.outbox.flows.CampaignTimerFlow;
import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.db.repositories.UserCampaignStateTransitionRepository;
import com.cdp.platform.shared.models.db.UserCampaignState;
import com.cdp.platform.shared.utils.TableSources;

public class CampaignOutboxJob {

    private static final String JOB_NAME = "campaign-outbox-job";

    public static void main(String[] args) throws Exception {
        boolean enableOutbox = booleanEnv("ENABLE_OUTBOX", true);
        boolean enableTimer = booleanEnv("ENABLE_TIMER", true);

        if (enableOutbox || enableTimer) {
            buildPipeline(DatabaseConfig.fromEnvironment(), new Configuration(), enableOutbox, enableTimer)
                .execute(JOB_NAME);
        } else {
            System.out.println("Both Outbox and Timer flows are disabled. Nothing to run.");
        }
    }

    /**
     * Builds the job graph without connecting to Kafka or Postgres. The settings
     * apply to the job on top of the cluster's configuration.
     */
    static StreamExecutionEnvironment buildPipeline(DatabaseConfig databaseConfig, Configuration settings,
        boolean enableOutbox, boolean enableTimer) {
        String checkpointInterval = System.getenv().getOrDefault("CHECKPOINT_INTERVAL", "60s");

        StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment(settings);
        StreamTableEnvironment tEnv = StreamTableEnvironment.create(env);

        tEnv.getConfig().getConfiguration().setString("execution.checkpointing.interval", checkpointInterval);

        DataStream<UserCampaignState> stateTransitions = UserCampaignStateTransitionRepository
            .changelog(tEnv, databaseConfig, "flink_outbox_transitions_slot");
        // The source keeps its log position in its state. Without a fixed id, a graph
        // change drops that state, and the next start reads every transition again.
        // The hash repeats the id Flink generated before the uid. No savepoint from
        // before the incremental snapshot source holds a position this source can
        // restore, so the hash keeps nothing and can go with the other hashes.
        TableSources.identify(stateTransitions, "transitions-source", "cbc357ccb763df2852fee8c4fc7d55f2");

        // Each id below repeats the id Flink generated for an operator before it had a
        // uid, at parallelism 2 or more, so a savepoint taken before then still
        // restores. The ids depend on which flows run.
        // outbox-operator-ids-before-uids.tsv in the test resources lists them. Delete
        // them once no such savepoint is kept.
        if (enableOutbox) {
            CampaignOutboxFlow
                .build(stateTransitions, databaseConfig, enableTimer
                    ? sinkIds("b452bede3a67ce652dad430f5f5f152e", "b1d246a0057704f317d4dbc194e104a8")
                    : sinkIds("9f9437bfffaf748efc279144b0759dc0", "e05b0ff6ef3fe1f6da54caa55d81566a"));
        }

        if (enableTimer) {
            CampaignTimerFlow
                .build(stateTransitions, enableOutbox
                    ? new CampaignTimerFlow.IdsBeforeUids("945d513d7d3b2f13d402980b4600c3e7",
                        sinkIds("931e79eafc3caa2beea8a5506180cee0", "11126bb2c0349e3d20006f076d6ebfc0"))
                    : new CampaignTimerFlow.IdsBeforeUids("57c004f5ada35552ab46620344b00093",
                        sinkIds("c1a5c8c84c3737892b6a748865b3fc4e", "be6af0815ca7a2f10d192f69884737e4")));
        }
        return env;
    }

    private static CustomSinkOperatorUidHashes sinkIds(String writer, String committer) {
        return CustomSinkOperatorUidHashes.builder().setWriterUidHash(writer).setCommitterUidHash(committer).build();
    }

    private static boolean booleanEnv(String name, boolean fallback) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) return fallback;
        return Boolean.parseBoolean(value.trim());
    }
}
