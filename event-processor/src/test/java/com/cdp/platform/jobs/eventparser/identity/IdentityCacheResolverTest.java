package com.cdp.platform.jobs.eventparser.identity;

import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.time.Duration;
import java.util.Arrays;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import com.cdp.platform.jobs.eventparser.identity.IdentityCacheResolver.MappingLookup;
import com.cdp.platform.jobs.eventparser.identity.IdentityCacheResolver.Resolution;
import com.cdp.platform.shared.db.repositories.IdentityGraphRepository.StoredRows;
import com.cdp.platform.shared.models.db.IdentityGraph;

import static com.cdp.platform.jobs.eventparser.identity.DisjointSetUnion.IdentifierType.DOMAIN_USERID;
import static com.cdp.platform.jobs.eventparser.identity.DisjointSetUnion.IdentifierType.USER_ID;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class IdentityCacheResolverTest {

    private static final MappingLookup NO_ROWS = (domainUserid, userId) -> new StoredRows(Optional.empty(), List.of());
    private static final MappingLookup FAILING = (domainUserid, userId) -> {
        throw new SQLException("connection refused");
    };

    /**
     * Answers like identity_graph: the device's row, and the rows of the event's
     * user, else of the user on the device's row. The rows are newest first.
     */
    private static MappingLookup storedRows(IdentityGraph... newestFirst) {
        return (domainUserid, userId) -> {
            Optional<IdentityGraph> deviceRow = Arrays
                .stream(newestFirst)
                .filter(row -> row.domainUserid().equals(domainUserid))
                .findFirst();
            String user = userId != null ? userId : deviceRow.map(IdentityGraph::userId).orElse(null);
            List<IdentityGraph> userRows = Arrays
                .stream(newestFirst)
                .filter(row -> user != null && user.equals(row.userId()))
                .toList();
            return new StoredRows(deviceRow, userRows);
        };
    }

    private static String derived(String identifier) {
        return UUID.nameUUIDFromBytes(("canon:" + identifier).getBytes(StandardCharsets.UTF_8)).toString();
    }

    private static String deviceRoot(String domainUserid) {
        return UUID
            .nameUUIDFromBytes(("canon-domain_userid:" + domainUserid).getBytes(StandardCharsets.UTF_8))
            .toString();
    }

    /** A structure that links u9 to C-stored and holds {@code entries} entries. */
    private static DisjointSetUnion fullStructure(int entries) {
        DisjointSetUnion dsu = new DisjointSetUnion();
        dsu.seedCanonicalIdentity(USER_ID, "u9", "C-stored");
        if (entries % 2 == 1) dsu.seedCanonicalIdentity(DOMAIN_USERID, "d9", "C-stored");
        for (int filler = 0; dsu.size() < entries; filler++) {
            dsu.resolveCanonId("filler-" + filler, null);
        }
        assertEquals(entries, dsu.size());
        return dsu;
    }

    @Test
    void newDeviceWithNoStoredRowGetsItsDerivedRoot() {
        Resolution resolution = IdentityCacheResolver.resolve(new DisjointSetUnion(), "d1", null, false, NO_ROWS);

        assertEquals(new Resolution(deviceRoot("d1"), true, 0), resolution);
    }

    @Test
    void loginOnAKnownDeviceGetsTheUsersDerivedRoot() {
        DisjointSetUnion dsu = new DisjointSetUnion();
        IdentityCacheResolver.resolve(dsu, "d1", null, false, NO_ROWS);
        MappingLookup deviceRowOnly = storedRows(new IdentityGraph("d1", null, deviceRoot("d1")));

        assertEquals(derived("u1"), IdentityCacheResolver.resolve(dsu, "d1", "u1", false, deviceRowOnly).canonId());
        assertEquals(derived("u1"), IdentityCacheResolver.resolve(dsu, "d1", null, false, NO_ROWS).canonId());
    }

    @Test
    void loginOnASecondDeviceAlreadyInStateGetsTheUsersStoredCanonId() {
        DisjointSetUnion deviceTwo = new DisjointSetUnion();
        IdentityCacheResolver.resolve(deviceTwo, "d2", null, false, NO_ROWS);
        MappingLookup stored = storedRows(new IdentityGraph("d1", "u1", "canon-of-u1"),
            new IdentityGraph("d2", null, deviceRoot("d2")));

        assertEquals("canon-of-u1", IdentityCacheResolver.resolve(deviceTwo, "d2", "u1", false, stored).canonId());
        assertEquals("canon-of-u1", IdentityCacheResolver.resolve(deviceTwo, "d2", null, false, NO_ROWS).canonId());
    }

    @Test
    void loginOnASecondDeviceNotInStateGetsTheUsersStoredCanonId() {
        MappingLookup stored = storedRows(new IdentityGraph("d2", null, "canon-of-d2"),
            new IdentityGraph("d1", "u1", "canon-of-u1"));

        Resolution resolution = IdentityCacheResolver.resolve(new DisjointSetUnion(), "d2", "u1", false, stored);

        assertEquals(new Resolution("canon-of-u1", true, 0), resolution);
    }

    @Test
    void storedRowOfAMergedSetKeepsTheMergedRoot() {
        DisjointSetUnion device = new DisjointSetUnion();
        MappingLookup stored = storedRows(new IdentityGraph("d2x", "u2", "C2"), new IdentityGraph("d1x", "u1", "C1"),
            new IdentityGraph("dx", "u4", "C2"));

        assertEquals("C2", IdentityCacheResolver.resolve(device, "d", "u2", false, stored).canonId());
        assertEquals("C1", IdentityCacheResolver.resolve(device, "d", "u1", false, stored).canonId());
        assertEquals("C1", IdentityCacheResolver.resolve(device, "d", "u4", false, stored).canonId());
        assertEquals("C1", IdentityCacheResolver.resolve(device, "d", null, false, stored).canonId());
        assertEquals("C1", IdentityCacheResolver.resolve(device, "d", "u2", false, stored).canonId());
        assertEquals("C1", IdentityCacheResolver.resolve(device, "d", "u1", false, stored).canonId());
    }

    @Test
    void failedLookupIsNotStored() {
        Resolution resolution = IdentityCacheResolver.resolve(new DisjointSetUnion(), "d1", "u1", false, FAILING);

        assertEquals(new Resolution(derived("u1"), false, 0), resolution);
    }

    @Test
    void eventAfterAFailedLookupReadsTheStoredCanonId() {
        DisjointSetUnion dsu = new DisjointSetUnion();
        IdentityCacheResolver.resolve(dsu, "d1", "u1", false, FAILING);

        Resolution next = IdentityCacheResolver
            .resolve(dsu, "d1", "u1", false, storedRows(new IdentityGraph("d1", "u1", "canon-of-u1")));

        assertEquals(new Resolution("canon-of-u1", true, 0), next);
    }

    @Test
    void failedLookupResolvesFromStateAndLeavesItAsItWas() {
        DisjointSetUnion dsu = new DisjointSetUnion();
        IdentityCacheResolver.resolve(dsu, "d1", null, false, NO_ROWS);

        Resolution failed = IdentityCacheResolver.resolve(dsu, "d1", "u2", false, FAILING);

        assertEquals(new Resolution(derived("u2"), false, 0), failed);
        assertEquals(deviceRoot("d1"), IdentityCacheResolver.resolve(dsu, "d1", null, false, NO_ROWS).canonId());
    }

    @Test
    void failedLookupOnAFullStructureResolvesFromStateAndLeavesItAsItWas() {
        DisjointSetUnion dsu = fullStructure(200);

        Resolution failed = IdentityCacheResolver.resolve(dsu, "dnew", "u9", false, FAILING);

        assertEquals(new Resolution("C-stored", false, 0), failed);
        assertEquals(200, dsu.size());
        assertFalse(dsu.containsIdentity(DOMAIN_USERID, "dnew"));
    }

    @Test
    void fullStructureIsClearedBeforeANewIdentifierArrives() {
        DisjointSetUnion dsu = fullStructure(200);

        Resolution resolution = IdentityCacheResolver.resolve(dsu, "dnew", null, false, NO_ROWS);

        assertEquals(new Resolution(deviceRoot("dnew"), true, 200), resolution);
        assertEquals(2, dsu.size());
    }

    @Test
    void structureWithRoomForOneMoreEntryStaysWithin200() {
        DisjointSetUnion dsu = fullStructure(199);

        IdentityCacheResolver.resolve(dsu, "dnew", null, false, NO_ROWS);

        assertTrue(dsu.size() <= DisjointSetUnion.MAX_NODES_PER_GRAPH,
            "entries: " + dsu.size());
    }

    @Test
    void deviceThatSeesANewUserOnEveryEventStaysWithin200() {
        DisjointSetUnion kiosk = new DisjointSetUnion();
        for (int login = 0; login < 300; login++) {
            IdentityCacheResolver.resolve(kiosk, "kiosk", "user-" + login, false, NO_ROWS);

            assertTrue(kiosk.size() <= DisjointSetUnion.MAX_NODES_PER_GRAPH,
                "entries after login " + login + ": " + kiosk.size());
        }
    }

    @Test
    void newDeviceOfAKnownUserOnAFullStructureKeepsTheStoredCanonId() {
        DisjointSetUnion dsu = fullStructure(200);
        MappingLookup stored = storedRows(new IdentityGraph("d9", "u9", "C-stored"));

        assertEquals("C-stored", IdentityCacheResolver.resolve(dsu, "dnew", "u9", false, stored).canonId());
        assertEquals("C-stored", IdentityCacheResolver.resolve(dsu, "dnew", null, false, NO_ROWS).canonId());
        assertTrue(dsu.size() <= DisjointSetUnion.MAX_NODES_PER_GRAPH);
    }

    @Test
    void loginWithNoRowForTheUserFallsBackToTheDevicesRow() {
        MappingLookup stored = storedRows(new IdentityGraph("d2", null, "canon-of-d2"));

        assertEquals("canon-of-d2", IdentityCacheResolver
            .resolve(new DisjointSetUnion(), "d2", "u1", false, stored)
            .canonId());
    }

    @Test
    void anonymousEventOnANewDeviceGetsTheDevicesRow() {
        MappingLookup stored = storedRows(new IdentityGraph("d2", "u1", "canon-of-u1"));

        assertEquals("canon-of-u1", IdentityCacheResolver
            .resolve(new DisjointSetUnion(), "d2", null, false, stored)
            .canonId());
    }

    @Test
    void recheckJoinsTheRootOfAMergeOnAnotherDevice() {
        assertTrue(derived("u1").compareTo(derived("u2")) < 0, "u1's root must sort first");
        DisjointSetUnion deviceA = new DisjointSetUnion();
        IdentityCacheResolver.resolve(deviceA, "dA", "u2", false, NO_ROWS);
        MappingLookup afterMerge = storedRows(new IdentityGraph("dA", "u2", derived("u2")),
            new IdentityGraph("dS", "u2", derived("u1")));

        assertEquals(new Resolution(derived("u1"), true, 0),
            IdentityCacheResolver.resolve(deviceA, "dA", "u2", true, afterMerge));
        assertEquals(derived("u1"), IdentityCacheResolver.resolve(deviceA, "dA", null, false, NO_ROWS).canonId());
    }

    @Test
    void failedRecheckKeepsTheDevicesState() {
        DisjointSetUnion deviceA = new DisjointSetUnion();
        IdentityCacheResolver.resolve(deviceA, "dA", "u2", false, NO_ROWS);

        assertEquals(new Resolution(derived("u2"), true, 0),
            IdentityCacheResolver.resolve(deviceA, "dA", "u2", true, FAILING));
    }

    @Test
    void recheckIsDueOnlyForADeviceWithAUserAfterTheInterval() {
        DisjointSetUnion anonymous = new DisjointSetUnion();
        IdentityCacheResolver.resolve(anonymous, "d1", null, false, NO_ROWS);
        DisjointSetUnion loggedIn = new DisjointSetUnion();
        IdentityCacheResolver.resolve(loggedIn, "d2", "u2", false, NO_ROWS);
        Duration minute = Duration.ofMinutes(1);

        assertFalse(IdentityCacheResolver.recheckDue(anonymous, "d1", null, null, 0L, minute));
        assertTrue(IdentityCacheResolver.recheckDue(loggedIn, "d2", null, null, 0L, minute));
        assertFalse(IdentityCacheResolver.recheckDue(loggedIn, "d2", null, 0L, 59_999L, minute));
        assertTrue(IdentityCacheResolver.recheckDue(loggedIn, "d2", "u2", 0L, 60_000L, minute));
    }
}
