package com.cdp.platform.shared.db.repositories;

import java.sql.Timestamp;

import org.jooq.Field;
import org.jooq.SQLDialect;
import org.jooq.Table;
import org.jooq.conf.ParamType;
import org.jooq.impl.DSL;

/**
 * The table {@code cdc_heartbeat}: one row per replication slot, which the
 * slot's CDC source writes on every heartbeat. Every CDC publication covers
 * it, so the write reaches the slot and moves its confirmed position while the
 * captured table is quiet.
 */
public final class CdcHeartbeatTable {

    private static final String TABLE_NAME = "cdc_heartbeat";

    private static final Table<?> TABLE = DSL.table(DSL.name(TABLE_NAME));
    private static final Field<String> SLOT_NAME = DSL.field(DSL.name("slot_name"), String.class);
    private static final Field<Timestamp> BEAT_AT = DSL.field(DSL.name("beat_at"), Timestamp.class);

    private CdcHeartbeatTable() {
    }

    /**
     * The statement that writes the slot's own row, for Debezium's heartbeat action
     * query.
     */
    public static String beatQuery(String slotName) {
        return DSL
            .using(SQLDialect.POSTGRES)
            .insertInto(TABLE, SLOT_NAME, BEAT_AT)
            .values(DSL.val(slotName), DSL.currentTimestamp())
            .onConflict(SLOT_NAME)
            .doUpdate()
            .set(BEAT_AT, DSL.currentTimestamp())
            .getSQL(ParamType.INLINED);
    }
}
