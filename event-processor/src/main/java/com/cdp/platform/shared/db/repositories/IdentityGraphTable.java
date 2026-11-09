package com.cdp.platform.shared.db.repositories;

import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.OffsetDateTime;

import com.cdp.platform.shared.models.db.IdentityGraph;

import org.jooq.DSLContext;
import org.jooq.Field;
import org.jooq.Query;
import org.jooq.Record;
import org.jooq.ResultQuery;
import org.jooq.SQLDialect;
import org.jooq.Table;
import org.jooq.conf.ParamType;
import org.jooq.impl.DSL;

/**
 * The table {@code identity_graph}: one row per device, mapping its
 * {@code domain_userid} to a {@code user_id} and a {@code canon_id}. The event
 * parse job writes it and reads it back to resolve later events. Profile
 * lookups read the {@code user_id} of a {@code canon_id} from it.
 * {@code created_at} is filled by the database, so no job names it.
 */
public final class IdentityGraphTable {

    public static final String TABLE_NAME = "identity_graph";

    public static final String DOMAIN_USERID = "domain_userid";
    public static final String USER_ID = "user_id";
    public static final String CANON_ID = "canon_id";
    public static final String UPDATED_AT = "updated_at";

    static final Table<?> TABLE = DSL.table(DSL.name(TABLE_NAME));
    static final Field<String> DOMAIN_USERID_FIELD = DSL.field(DSL.name(DOMAIN_USERID), String.class);
    static final Field<String> USER_ID_FIELD = DSL.field(DSL.name(USER_ID), String.class);
    // Qualified because the excluded row also has this column in the upsert.
    static final Field<String> STORED_USER_ID_FIELD = DSL.field(DSL.name(TABLE_NAME, USER_ID), String.class);
    static final Field<String> CANON_ID_FIELD = DSL.field(DSL.name(CANON_ID), String.class);
    static final Field<OffsetDateTime> UPDATED_AT_FIELD = DSL.field(DSL.name(UPDATED_AT), OffsetDateTime.class);
    // Which half of the lookup a row came from. Not a column of the table.
    static final Field<Integer> PART = DSL.field(DSL.name("part"), Integer.class);
    static final int DEVICE_PART = 0;
    static final int USER_PART = 1;

    private IdentityGraphTable() {
    }

    /**
     * The device's row, and the user's newest rows apart from it, so a newer
     * device row cannot push the user's rows out of the result. The user is the
     * event's {@code user_id}, else the one on the device's row. Devices written
     * in one transaction share {@code updated_at}, so {@code domain_userid}
     * breaks the tie. {@link #PART} tells the two halves apart.
     */
    static ResultQuery<?> lookupQuery(String domainUserId, String userId) {
        DSLContext sql = DSL.using(SQLDialect.POSTGRES);
        Field<String> user = DSL
            .coalesce(DSL.val(userId, USER_ID_FIELD),
                sql
                    .select(USER_ID_FIELD)
                    .from(TABLE)
                    .where(DOMAIN_USERID_FIELD.eq(domainUserId))
                    .asField());
        return sql
            .select(DOMAIN_USERID_FIELD, USER_ID_FIELD, CANON_ID_FIELD, DSL.inline(DEVICE_PART).as(PART))
            .from(TABLE)
            .where(DOMAIN_USERID_FIELD.eq(domainUserId))
            .unionAll(sql
                .select(DOMAIN_USERID_FIELD, USER_ID_FIELD, CANON_ID_FIELD, DSL.inline(USER_PART).as(PART))
                .from(TABLE)
                .where(USER_ID_FIELD.eq(user))
                .orderBy(UPDATED_AT_FIELD.desc(), DOMAIN_USERID_FIELD.asc())
                .limit(IdentityGraphRepository.USER_ROW_LIMIT));
    }

    /**
     * Keeps the stored {@code user_id} when the event has none, and stamps
     * {@code updated_at} so that the lookup's newest row is the latest mapping.
     * {@link #bind} fills its parameters.
     */
    static Query upsertQuery() {
        return DSL
            .using(SQLDialect.POSTGRES)
            .insertInto(TABLE)
            .columns(DOMAIN_USERID_FIELD, USER_ID_FIELD, CANON_ID_FIELD)
            .values(DSL.val(null, DOMAIN_USERID_FIELD), DSL.val(null, USER_ID_FIELD), DSL.val(null, CANON_ID_FIELD))
            .onConflict(DOMAIN_USERID_FIELD)
            .doUpdate()
            .set(USER_ID_FIELD, DSL.coalesce(DSL.excluded(USER_ID_FIELD), STORED_USER_ID_FIELD))
            .set(CANON_ID_FIELD, DSL.excluded(CANON_ID_FIELD))
            .set(UPDATED_AT_FIELD, DSL.currentOffsetDateTime());
    }

    /**
     * The {@code user_id} of the newest row of the one {@code canon_id}
     * parameter that has one, if any. Rows written in one transaction share
     * {@code updated_at}, so {@code domain_userid} breaks the tie.
     */
    static String userIdOfCanonSql() {
        return DSL
            .using(SQLDialect.POSTGRES)
            .select(USER_ID_FIELD)
            .from(TABLE)
            .where(CANON_ID_FIELD.eq(DSL.val(null, CANON_ID_FIELD)))
            .and(USER_ID_FIELD.isNotNull())
            .orderBy(UPDATED_AT_FIELD.desc(), DOMAIN_USERID_FIELD.asc())
            .limit(DSL.inline(1))
            .getSQL(ParamType.INDEXED);
    }

    /** Whether a {@link #lookupQuery} row is the device's own row. */
    static boolean isDeviceRow(Record record) {
        return record.get(PART) == DEVICE_PART;
    }

    /** The mapping in a {@link #lookupQuery} row. */
    static IdentityGraph mapping(Record record) {
        return new IdentityGraph(record.get(DOMAIN_USERID_FIELD), record.get(USER_ID_FIELD),
            record.get(CANON_ID_FIELD));
    }

    /** Fills the parameters of {@link #upsertQuery} with one mapping. */
    static void bind(PreparedStatement statement, IdentityGraph mapping) throws SQLException {
        statement.setString(1, mapping.domainUserid());
        statement.setString(2, mapping.userId());
        statement.setString(3, mapping.canonId());
    }
}
