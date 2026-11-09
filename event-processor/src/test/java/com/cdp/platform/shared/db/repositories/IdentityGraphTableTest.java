package com.cdp.platform.shared.db.repositories;

import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertTrue;

import org.jooq.conf.ParamType;
import org.junit.jupiter.api.Test;

class IdentityGraphTableTest {

    private static final Pattern STAMPS_UPDATED_AT = Pattern
        .compile("\"updated_at\" = (cast\\()?current_timestamp\\b");

    @Test
    void upsertReplacesTheDevicesRow() {
        String sql = IdentityGraphTable.upsertQuery().getSQL();

        assertTrue(sql.contains("on conflict (\"domain_userid\") do update set"), sql);
    }

    @Test
    void anonymousEventKeepsTheStoredUserId() {
        String sql = IdentityGraphTable.upsertQuery().getSQL();

        assertTrue(sql.contains("\"user_id\" = coalesce(excluded.\"user_id\", \"identity_graph\".\"user_id\")"), sql);
    }

    @Test
    void upsertStampsUpdatedAtWithTheTimeOfTheWrite() {
        String sql = IdentityGraphTable.upsertQuery().getSQL();

        assertTrue(STAMPS_UPDATED_AT.matcher(sql).find(), sql);
    }

    @Test
    void lookupReadsTheDevicesRowAndTheUsersNewestRowsApart() {
        String sql = IdentityGraphTable.lookupQuery("d2", "u1").getSQL(ParamType.INLINED);

        assertTrue(sql.contains("where \"domain_userid\" = 'd2'"), sql);
        assertTrue(sql.contains(" union all "), sql);
        assertTrue(sql.contains("order by \"updated_at\" desc, \"domain_userid\" asc fetch next 10 rows only"), sql);
    }

    @Test
    void lookupReadsTheRowsOfTheEventsUserElseOfTheUserOnTheDevicesRow() {
        String sql = IdentityGraphTable.lookupQuery("d2", "u1").getSQL(ParamType.INLINED);

        assertTrue(sql
            .contains("\"user_id\" = coalesce('u1', (select \"user_id\" from \"identity_graph\" "
                + "where \"domain_userid\" = 'd2'))"),
            sql);
    }

    @Test
    void userIdOfACanonIdIsTheNewestRowsThatHasOne() {
        String sql = IdentityGraphTable.userIdOfCanonSql();

        assertTrue(sql.contains("where (\"canon_id\" = ? and \"user_id\" is not null)"), sql);
        assertTrue(sql.contains("order by \"updated_at\" desc, \"domain_userid\" asc"), sql);
    }
}
