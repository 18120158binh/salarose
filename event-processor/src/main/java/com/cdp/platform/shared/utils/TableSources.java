package com.cdp.platform.shared.utils;

import org.apache.flink.api.dag.Transformation;
import org.apache.flink.streaming.api.datastream.DataStream;

/** Operator ids for the sources that the SQL planner creates. */
public final class TableSources {

    private TableSources() {
    }

    /**
     * The SQL planner creates the source operator of a table stream and gives it no
     * uid, so set it here, with the id Flink generated for it before the job set
     * uids. For a Kafka source, a savepoint taken before then still restores its
     * offsets. For a CDC source the id restores nothing from before: the source
     * became the connector's incremental snapshot source, whose state no older
     * savepoint holds, so the job needs a fresh start once.
     */
    public static void identify(DataStream<?> stream, String uid, String idBeforeUids) {
        identify(stream, uid).setUidHash(idBeforeUids);
    }

    /**
     * Sets the uid of the source operator that the SQL planner created for a table
     * stream, for a source that had no id before the job set uids.
     */
    public static Transformation<?> identify(DataStream<?> stream, String uid) {
        Transformation<?> source = stream.getTransformation();
        while (!source.getInputs().isEmpty()) {
            source = source.getInputs().getFirst();
        }
        source.setUid(uid);
        return source;
    }
}
