package com.cdp.platform.jobs.eventparser.identity;

import java.io.IOException;
import java.util.HexFormat;

import org.apache.flink.core.memory.DataInputDeserializer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

/**
 * Checkpoints hold the stitcher's structure in the serializer's format, so a
 * later version of the serializer must still read the bytes an earlier one
 * wrote.
 */
class DisjointSetUnionSerializerTest {

    // Format 2: domain_userid d1 -> 0-canon, the root 0-canon, and 0-canon's user
    // priority 3.
    private static final String SECOND_FORMAT = "02" + "00000002" + "11646f6d61696e5f7573657269643a6431"
        + "08302d63616e6f6e"
        + "08302d63616e6f6e" + "08302d63616e6f6e" + "00000001" + "08302d63616e6f6e" + "00000003";

    @Test
    void aStructureInTheSecondFormatStillReads() throws IOException {
        DisjointSetUnion restored = DisjointSetUnionSerializer.INSTANCE
            .deserialize(new DataInputDeserializer(HexFormat.of().parseHex(SECOND_FORMAT)));

        assertEquals("0-canon", restored.resolveCanonId("d1", null));
        // 0-canon sorts before u2's derived root, so it keeps the set on a tie
        // between user roots only if its priority was read.
        assertEquals("0-canon", restored.resolveCanonId("d1", "u2"));
    }

    @Test
    void aStructureInTheFirstFormatIsRejected() {
        assertThrows(IOException.class, () -> DisjointSetUnionSerializer.INSTANCE
            .deserialize(new DataInputDeserializer(HexFormat.of().parseHex("0100000000" + "00000000"))));
    }
}
