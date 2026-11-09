package com.cdp.platform.jobs.eventparser.identity;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

import org.apache.flink.api.common.typeutils.SimpleTypeSerializerSnapshot;
import org.apache.flink.api.common.typeutils.TypeSerializerSchemaCompatibility;
import org.apache.flink.api.common.typeutils.TypeSerializerSnapshot;
import org.apache.flink.api.common.typeutils.base.TypeSerializerSingleton;
import org.apache.flink.api.java.typeutils.runtime.kryo.KryoSerializerSnapshot;
import org.apache.flink.core.memory.DataInputView;
import org.apache.flink.core.memory.DataOutputView;
import org.apache.flink.types.StringValue;

/**
 * Writes the stitcher's structure in a format of its own. Each value starts
 * with its format version, so a later format can still read the values written
 * in an earlier one.
 */
public final class DisjointSetUnionSerializer extends TypeSerializerSingleton<DisjointSetUnion> {

    public static final DisjointSetUnionSerializer INSTANCE = new DisjointSetUnionSerializer();

    private static final long serialVersionUID = 1L;
    // Format 2 keys each identifier by its type. Format 1 held untyped keys, and
    // no deployment ever wrote it, so it is not read.
    private static final byte FORMAT_VERSION = 2;

    private DisjointSetUnionSerializer() {
    }

    @Override
    public boolean isImmutableType() {
        return false;
    }

    @Override
    public DisjointSetUnion createInstance() {
        return new DisjointSetUnion();
    }

    @Override
    public DisjointSetUnion copy(DisjointSetUnion from) {
        return from.copy();
    }

    @Override
    public DisjointSetUnion copy(DisjointSetUnion from, DisjointSetUnion reuse) {
        return from.copy();
    }

    @Override
    public int getLength() {
        return -1;
    }

    @Override
    public void serialize(DisjointSetUnion record, DataOutputView target) throws IOException {
        target.writeByte(FORMAT_VERSION);
        Map<String, String> parentLinks = record.parentLinks();
        target.writeInt(parentLinks.size());
        for (Map.Entry<String, String> link : parentLinks.entrySet()) {
            StringValue.writeString(link.getKey(), target);
            StringValue.writeString(link.getValue(), target);
        }
        Map<String, Integer> rootPriorities = record.rootPriorities();
        target.writeInt(rootPriorities.size());
        for (Map.Entry<String, Integer> priority : rootPriorities.entrySet()) {
            StringValue.writeString(priority.getKey(), target);
            target.writeInt(priority.getValue());
        }
    }

    @Override
    public DisjointSetUnion deserialize(DataInputView source) throws IOException {
        byte version = source.readByte();
        if (version != FORMAT_VERSION) throw new IOException("Unknown identity state format " + version);

        int linkCount = source.readInt();
        Map<String, String> parentLinks = HashMap.newHashMap(linkCount);
        for (int link = 0; link < linkCount; link++) {
            parentLinks.put(StringValue.readString(source), StringValue.readString(source));
        }
        int rootCount = source.readInt();
        Map<String, Integer> rootPriorities = HashMap.newHashMap(rootCount);
        for (int root = 0; root < rootCount; root++) {
            rootPriorities.put(StringValue.readString(source), source.readInt());
        }
        return new DisjointSetUnion(parentLinks, rootPriorities);
    }

    @Override
    public DisjointSetUnion deserialize(DisjointSetUnion reuse, DataInputView source) throws IOException {
        return deserialize(source);
    }

    @Override
    public void copy(DataInputView source, DataOutputView target) throws IOException {
        serialize(deserialize(source), target);
    }

    @Override
    public TypeSerializerSnapshot<DisjointSetUnion> snapshotConfiguration() {
        return new DisjointSetUnionSerializerSnapshot();
    }

    /** Checkpoints name this class, so it keeps its name and package. */
    public static final class DisjointSetUnionSerializerSnapshot
        extends
            SimpleTypeSerializerSnapshot<DisjointSetUnion> {

        public DisjointSetUnionSerializerSnapshot() {
            super(() -> INSTANCE);
        }

        /**
         * The stitcher kept the structure as a Kryo value before this serializer.
         * Flink reads such state once with Kryo on restore and writes it in this
         * format.
         */
        @Override
        public TypeSerializerSchemaCompatibility<DisjointSetUnion> resolveSchemaCompatibility(
            TypeSerializerSnapshot<DisjointSetUnion> oldSerializerSnapshot) {
            if (oldSerializerSnapshot instanceof KryoSerializerSnapshot)
                return TypeSerializerSchemaCompatibility.compatibleAfterMigration();
            return super.resolveSchemaCompatibility(oldSerializerSnapshot);
        }
    }
}
