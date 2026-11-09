package com.cdp.platform.shared.db.repositories;

import java.sql.PreparedStatement;
import java.sql.SQLException;

import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.connector.jdbc.core.datastream.sink.JdbcSink;
import org.apache.flink.streaming.api.datastream.CustomSinkOperatorUidHashes;
import org.apache.flink.streaming.api.datastream.DataStream;
import org.apache.flink.table.api.TableDescriptor;
import org.apache.flink.table.api.bridge.java.StreamTableEnvironment;
import org.apache.flink.types.Row;
import org.apache.flink.types.RowKind;
import org.apache.flink.util.Collector;

import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.db.sinks.JdbcSinkOptions;
import com.cdp.platform.shared.models.db.UserCampaignState;

import static com.cdp.platform.shared.db.repositories.UserCampaignStateTransitionsTable.ACTION_JSON_FIELD;
import static com.cdp.platform.shared.db.repositories.UserCampaignStateTransitionsTable.BRANCH_FIELD;
import static com.cdp.platform.shared.db.repositories.UserCampaignStateTransitionsTable.CAMPAIGN_ID_FIELD;
import static com.cdp.platform.shared.db.repositories.UserCampaignStateTransitionsTable.CANON_ID_FIELD;
import static com.cdp.platform.shared.db.repositories.UserCampaignStateTransitionsTable.CHILDREN_FIELD;
import static com.cdp.platform.shared.db.repositories.UserCampaignStateTransitionsTable.CONTEXT_JSON_FIELD;
import static com.cdp.platform.shared.db.repositories.UserCampaignStateTransitionsTable.DOMAIN_USER_ID_FIELD;
import static com.cdp.platform.shared.db.repositories.UserCampaignStateTransitionsTable.ENTRY_ID_FIELD;
import static com.cdp.platform.shared.db.repositories.UserCampaignStateTransitionsTable.EVENT_ID_FIELD;
import static com.cdp.platform.shared.db.repositories.UserCampaignStateTransitionsTable.EVENT_TIMESTAMP_FIELD;
import static com.cdp.platform.shared.db.repositories.UserCampaignStateTransitionsTable.NETWORK_USER_ID_FIELD;
import static com.cdp.platform.shared.db.repositories.UserCampaignStateTransitionsTable.NODE_ID_FIELD;
import static com.cdp.platform.shared.db.repositories.UserCampaignStateTransitionsTable.NODE_TYPE_FIELD;
import static com.cdp.platform.shared.db.repositories.UserCampaignStateTransitionsTable.TABLE;
import static com.cdp.platform.shared.db.repositories.UserCampaignStateTransitionsTable.TABLE_NAME;
import static com.cdp.platform.shared.db.repositories.UserCampaignStateTransitionsTable.USER_ID_FIELD;

import org.jooq.Query;
import org.jooq.SQLDialect;
import org.jooq.conf.ParamType;
import org.jooq.impl.DSL;

/**
 * Writes {@code user_campaign_state_transitions} from the state machine, and
 * reads it through CDC for the outbox job. The columns live in
 * {@link UserCampaignStateTransitionsTable}.
 */
public final class UserCampaignStateTransitionRepository {

    private UserCampaignStateTransitionRepository() {
    }

    /**
     * Writes each transition once. The writer and committer carry the given
     * operator ids, so that state saved before the sink had its uid restores.
     */
    public static void attach(DataStream<UserCampaignState> transitions, DatabaseConfig database, String uid,
        CustomSinkOperatorUidHashes idsBeforeUid) {
        transitions
            .sinkTo(JdbcSink
                .<UserCampaignState>builder()
                .withQueryStatement(insertQuery().getSQL(ParamType.INDEXED),
                    UserCampaignStateTransitionRepository::bind)
                .withExecutionOptions(JdbcSinkOptions.batches())
                .buildAtLeastOnce(JdbcSinkOptions.connection(database)), idsBeforeUid)
            .name("Postgres User Campaign State Transition Sink")
            .uid(uid);
    }

    static Query insertQuery() {
        var candidate = DSL
            .select(DSL.val(null, CANON_ID_FIELD), DSL.val(null, DOMAIN_USER_ID_FIELD),
                DSL.val(null, NETWORK_USER_ID_FIELD), DSL.val(null, USER_ID_FIELD), DSL.val(null, CAMPAIGN_ID_FIELD),
                DSL.val(null, ENTRY_ID_FIELD), DSL.val(null, NODE_ID_FIELD), DSL.val(null, BRANCH_FIELD),
                DSL.val(null, EVENT_TIMESTAMP_FIELD), DSL.val(null, NODE_TYPE_FIELD), DSL.val(null, ACTION_JSON_FIELD),
                DSL.val(null, CONTEXT_JSON_FIELD), DSL.val(null, CHILDREN_FIELD), DSL.val(null, EVENT_ID_FIELD))
            .whereNotExists(DSL
                .selectOne()
                .from(TABLE)
                .where(CANON_ID_FIELD.eq(DSL.val(null, CANON_ID_FIELD)))
                .and(CAMPAIGN_ID_FIELD.eq(DSL.val(null, CAMPAIGN_ID_FIELD)))
                .and(ENTRY_ID_FIELD.eq(DSL.val(null, ENTRY_ID_FIELD)))
                .and(NODE_ID_FIELD.eq(DSL.val(null, NODE_ID_FIELD))));

        return DSL
            .using(SQLDialect.POSTGRES)
            .insertInto(TABLE, CANON_ID_FIELD, DOMAIN_USER_ID_FIELD, NETWORK_USER_ID_FIELD, USER_ID_FIELD,
                CAMPAIGN_ID_FIELD, ENTRY_ID_FIELD, NODE_ID_FIELD, BRANCH_FIELD, EVENT_TIMESTAMP_FIELD, NODE_TYPE_FIELD,
                ACTION_JSON_FIELD, CONTEXT_JSON_FIELD, CHILDREN_FIELD, EVENT_ID_FIELD)
            .select(candidate)
            .onConflictDoNothing();
    }

    static void bind(PreparedStatement statement, UserCampaignState transition) throws SQLException {
        statement.setString(1, transition.canonId());
        statement.setString(2, transition.domainUserId());
        statement.setString(3, transition.networkUserId());
        statement.setString(4, transition.userId());
        statement.setString(5, transition.campaignId());
        statement.setString(6, transition.entryId());
        statement.setString(7, transition.nodeId());
        statement.setString(8, transition.branch());
        statement.setLong(9, transition.eventTimestamp());
        statement.setString(10, transition.nodeType().name());
        statement.setString(11, transition.actionJson());
        statement.setString(12, transition.contextJson());
        statement.setString(13, UserCampaignStateTransitionsTable.childrenJson(transition.watchChildren()));
        statement.setString(14, transition.eventId());
        statement.setString(15, transition.canonId());
        statement.setString(16, transition.campaignId());
        statement.setString(17, transition.entryId());
        statement.setString(18, transition.nodeId());
    }

    /** The transitions inserted into the table, read through CDC. */
    public static DataStream<UserCampaignState> changelog(StreamTableEnvironment tableEnvironment,
        DatabaseConfig database, String slotName) {
        String temporaryTableName = "postgres_transitions_cdc";
        tableEnvironment.createTemporaryTable(temporaryTableName, createCdcSourceDescriptor(database, slotName));
        return PostgresCdc
            .changelog(tableEnvironment, temporaryTableName)
            .filter(row -> row.getKind() == RowKind.INSERT)
            .setParallelism(1)
            .flatMap((Row row, Collector<UserCampaignState> out) -> UserCampaignStateTransitionsTable
                .transition(row)
                .ifPresent(out::collect))
            .returns(TypeInformation.of(UserCampaignState.class))
            .setParallelism(1);
    }

    public static TableDescriptor createCdcSourceDescriptor(DatabaseConfig database, String slotName) {
        return PostgresCdc
            .source(database, TABLE_NAME, UserCampaignStateTransitionsTable.PUBLICATION_NAME, slotName,
                UserCampaignStateTransitionsTable.cdcSchema());
    }
}
