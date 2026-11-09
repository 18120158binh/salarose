package com.cdp.platform.shared.db.repositories;

import org.apache.flink.table.api.DataTypes;
import org.apache.flink.table.api.Schema;

/**
 * The table {@code campaigns}: one row per journey. Studio writes it, and
 * customer decision reads it through CDC.
 */
public final class CampaignsTable {

    public static final String TABLE_NAME = "campaigns";
    public static final String PUBLICATION_NAME = "campaigns_pub";

    public static final String ID = "id";
    public static final String NAME = "name";
    public static final String DESCRIPTION = "description";
    public static final String STATUS = "status";
    public static final String ROOT = "root";
    public static final String CREATED_USER = "created_user";
    public static final String CREATED_AT = "created_at";
    public static final String UPDATED_AT = "updated_at";

    private CampaignsTable() {
    }

    /** The columns customer decision reads through CDC. */
    public static Schema cdcSchema() {
        return Schema
            .newBuilder()
            .column(ID, DataTypes.STRING().notNull())
            .column(NAME, DataTypes.STRING().notNull())
            .column(DESCRIPTION, DataTypes.STRING())
            .column(STATUS, DataTypes.STRING().notNull())
            .column(ROOT, DataTypes.STRING().notNull())
            .column(CREATED_USER, DataTypes.STRING())
            .column(CREATED_AT, DataTypes.TIMESTAMP_LTZ(3))
            .column(UPDATED_AT, DataTypes.TIMESTAMP_LTZ(3))
            .primaryKey(ID)
            .build();
    }
}
