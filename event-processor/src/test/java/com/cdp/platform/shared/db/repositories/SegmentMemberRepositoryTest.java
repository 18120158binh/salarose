package com.cdp.platform.shared.db.repositories;

import java.lang.reflect.Proxy;
import java.sql.PreparedStatement;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.cdp.platform.shared.models.SegmentMembershipChange;
import com.cdp.platform.shared.models.SegmentMembershipChange.Change;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class SegmentMemberRepositoryTest {

    private static final String SEGMENT = "SEG-3f9a0c1d7e2b4a65";
    private static final long TEN = 1785800000000L;
    private static final long ELEVEN = TEN + 3_600_000L;

    @Test
    void enteredThenExitedInOneBatchLeavesNoRow() {
        SegmentMembershipChange merged = SegmentMemberRepository
            .mergeInOrder(entered("customer-42", TEN),
                exited("customer-42"));

        assertEquals(Change.EXITED, merged.change());
    }

    @Test
    void exitedThenEnteredInOneBatchLeavesTheRow() {
        SegmentMembershipChange merged = SegmentMemberRepository
            .mergeInOrder(exited("customer-42"),
                entered("customer-42", ELEVEN));

        assertEquals(entered("customer-42", ELEVEN), merged);
    }

    @Test
    void aChangeWritesTheRowOfItsSegmentAndPerson() {
        assertEquals(List.of(SEGMENT, "customer-42"), SegmentMemberRepository.rowKey(entered("customer-42", TEN)));
    }

    @Test
    void anEnteredChangeBindsItsEventTimeAsSince() throws Exception {
        Map<Integer, Object> parameters = bind(entered("customer-42", TEN));

        assertEquals(true, parameters.get(1));
        assertEquals(SEGMENT, parameters.get(2));
        assertEquals("customer-42", parameters.get(3));
        assertEquals(OffsetDateTime.of(2026, 8, 3, 23, 33, 20, 0, ZoneOffset.UTC), parameters.get(4));
    }

    @Test
    void anExitedChangeBindsNoSince() throws Exception {
        Map<Integer, Object> parameters = bind(exited("customer-42"));

        assertEquals(false, parameters.get(1));
        assertTrue(parameters.containsKey(4));
        assertEquals(null, parameters.get(4));
    }

    @Test
    void anUnchangedRowIsNeitherUpdatedNorLocked() {
        String sql = SegmentMembersTable.applyChangeSql();

        assertTrue(sql.contains("m.since <> c.since"), sql);
        assertTrue(sql.contains("ON CONFLICT (segment_id, canon_id) DO NOTHING"), sql);
        assertFalse(sql.contains("DO UPDATE"), sql);
    }

    @Test
    void replayingTheSameChangesLeavesTheSameRows() {
        List<SegmentMembershipChange> changes = List
            .of(entered("customer-42", TEN), exited("customer-42"),
                entered("customer-42", ELEVEN), entered("customer-7", TEN), exited("customer-9"));

        Map<List<String>, Long> once = apply(new LinkedHashMap<>(), changes);
        // Restored from a checkpoint after the first change: the rest arrive again.
        Map<List<String>, Long> replayed = apply(apply(new LinkedHashMap<>(), changes),
            changes.subList(1, changes.size()));

        assertEquals(Map.of(List.of(SEGMENT, "customer-42"), ELEVEN, List.of(SEGMENT, "customer-7"), TEN), once);
        assertEquals(once, replayed);
    }

    /**
     * The rows that the sink's statement leaves, one merged change per row and
     * batch, as the statement's comment describes it.
     */
    private static Map<List<String>, Long> apply(Map<List<String>, Long> table,
        List<SegmentMembershipChange> changes) {
        Map<List<String>, SegmentMembershipChange> batch = new LinkedHashMap<>();
        for (SegmentMembershipChange change : changes) {
            batch.merge(SegmentMemberRepository.rowKey(change), change, SegmentMemberRepository::mergeInOrder);
        }
        for (SegmentMembershipChange change : batch.values()) {
            if (change.entered()) {
                table.put(SegmentMemberRepository.rowKey(change), change.eventTime());
            } else {
                table.remove(SegmentMemberRepository.rowKey(change));
            }
        }
        return table;
    }

    private static Map<Integer, Object> bind(SegmentMembershipChange change) throws Exception {
        Map<Integer, Object> parameters = new HashMap<>();
        PreparedStatement statement = (PreparedStatement) Proxy
            .newProxyInstance(PreparedStatement.class.getClassLoader(), new Class<?>[] {PreparedStatement.class},
                (proxy, method, args) -> {
                    if (method.getName().startsWith("set")) {
                        parameters.put((Integer) args[0], method.getName().equals("setNull") ? null : args[1]);
                    }
                    return null;
                });
        SegmentMemberRepository.bind(statement, change);
        return parameters;
    }

    private static SegmentMembershipChange entered(String canonId, long eventTime) {
        return new SegmentMembershipChange(canonId, SEGMENT, Change.ENTERED, "e-" + eventTime, eventTime);
    }

    private static SegmentMembershipChange exited(String canonId) {
        return new SegmentMembershipChange(canonId, SEGMENT, Change.EXITED, "e-exit", null);
    }
}
