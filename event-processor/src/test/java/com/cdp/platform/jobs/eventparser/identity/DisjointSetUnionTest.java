package com.cdp.platform.jobs.eventparser.identity;

import java.nio.charset.StandardCharsets;
import java.util.UUID;

import static com.cdp.platform.jobs.eventparser.identity.DisjointSetUnion.IdentifierType.DOMAIN_USERID;
import static com.cdp.platform.jobs.eventparser.identity.DisjointSetUnion.IdentifierType.USER_ID;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

class DisjointSetUnionTest {

    private DisjointSetUnion dsu;

    @BeforeEach
    void setUp() {
        dsu = new DisjointSetUnion();
    }

    private boolean isValidUUID(String str) {
        if (str == null) return false;
        try {
            UUID.fromString(str);
            return true;
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    @Test
    @DisplayName("Single anonymous domain_userid should resolve to a valid UUID canon_id")
    void testSingleDomainUserid() {
        String canonId = dsu.resolveCanonId("d4", null);
        assertTrue(isValidUUID(canonId));
    }

    @Test
    @DisplayName("PostgreSQL fallback should preserve the authoritative canon_id")
    void testSeedCanonicalIdentityPreservesAuthoritativeCanonId() {
        String postgresCanonId = "93c9f564-f6d7-49ca-a98f-cfbb5f5e3354";

        assertFalse(dsu.containsIdentity(DOMAIN_USERID, "d1"));
        dsu.seedCanonicalIdentity(DOMAIN_USERID, "d1", postgresCanonId);
        dsu.seedCanonicalIdentity(USER_ID, "u1", postgresCanonId);

        assertTrue(dsu.containsIdentity(DOMAIN_USERID, "d1"));
        assertTrue(dsu.containsIdentity(USER_ID, "u1"));
        assertEquals(postgresCanonId, dsu.resolveCanonId("d1", null));
        assertEquals(postgresCanonId, dsu.resolveCanonId("d1", "u1"));
    }

    @Test
    @DisplayName("Seeding with a canon_id that was merged into another set joins that set")
    void seedWithAMergedCanonIdJoinsItsCurrentSet() {
        dsu.seedCanonicalIdentity(USER_ID, "u2", "C2");
        dsu.seedCanonicalIdentity(USER_ID, "u1", "C1");
        assertTrue(dsu.union(USER_ID, "u1", USER_ID, "u2"));

        dsu.seedCanonicalIdentity(USER_ID, "u4", "C2");

        assertEquals("C1", dsu.find(USER_ID, "u4"));
        assertEquals("C1", dsu.find(USER_ID, "u2"));
    }

    @Test
    @DisplayName("A merge on a full structure keeps the linked identifier's root")
    void mergeOnAFullStructureKeepsTheLinkedRoot() {
        dsu.seedCanonicalIdentity(USER_ID, "u9", "C-stored");
        for (int filler = 0; dsu.size() < DisjointSetUnion.MAX_NODES_PER_GRAPH; filler++) {
            dsu.resolveCanonId("filler-" + filler, null);
        }

        assertEquals("C-stored", dsu.resolveCanonId("dnew", "u9"));
        assertEquals("C-stored", dsu.resolveCanonId("dnew", null));
    }

    @Test
    @DisplayName("Checking for a cached identity must not create local graph state")
    void testContainsIdentityDoesNotCreateState() {
        assertFalse(dsu.containsIdentity(DOMAIN_USERID, "missing"));
        assertEquals(0, dsu.size());
    }

    @Test
    @DisplayName("Pairing domain_userid and user_id should union them to a single UUID canon_id")
    void testTwoIdentityPairing() {
        String canonId1 = dsu.resolveCanonId("d1", "u1");
        assertTrue(isValidUUID(canonId1));

        // Subsequent queries for user_id and domain_userid should resolve to same UUID
        assertEquals(canonId1, dsu.find(USER_ID, "u1"));
        assertEquals(canonId1, dsu.find(DOMAIN_USERID, "d1"));
    }

    @Test
    @DisplayName("Transitive identity merging: d1-u1, d2-u1, d3-u1 should all merge into single UUID")
    void testMultipleIdentityPairingAndTransitiveMerge() {
        // Event 1: (d1, u1)
        String c1 = dsu.resolveCanonId("d1", "u1");
        assertTrue(isValidUUID(c1));

        // Event 2: (d2, u1) -> d2 merges into c1 via u1
        String c2 = dsu.resolveCanonId("d2", "u1");
        assertEquals(c1, c2);

        // Event 3: (d3, u1) -> d3 merges into graph via u1
        String c3 = dsu.resolveCanonId("d3", "u1");
        assertEquals(c1, c3);

        // Verify all node identifiers point to the EXACT SAME merged UUID root (c1)
        assertEquals(c1, dsu.find(DOMAIN_USERID, "d1"));
        assertEquals(c1, dsu.find(DOMAIN_USERID, "d2"));
        assertEquals(c1, dsu.find(DOMAIN_USERID, "d3"));
        assertEquals(c1, dsu.find(USER_ID, "u1"));

        // Event 4: Independent device d4 remains isolated with a distinct UUID
        String c4 = dsu.resolveCanonId("d4", null);
        assertTrue(isValidUUID(c4));
        assertEquals(c4, dsu.find(DOMAIN_USERID, "d4"));
        assertNotEquals(c1, dsu.find(DOMAIN_USERID, "d4"));
    }

    @Test
    @DisplayName("Path Compression should flatten multi-hop parent chains to UUID root")
    void testPathCompression() {
        dsu.union(DOMAIN_USERID, "A", DOMAIN_USERID, "B");
        dsu.union(DOMAIN_USERID, "B", DOMAIN_USERID, "C");
        dsu.union(DOMAIN_USERID, "C", DOMAIN_USERID, "D");

        String rootD = dsu.find(DOMAIN_USERID, "D");
        assertTrue(isValidUUID(rootD));

        // Path compression flattens D's parent directly to root UUID
        assertEquals(rootD, dsu.parentLinks().get("domain_userid:D"));
    }

    @Test
    @DisplayName("A user_id and a domain_userid with one value stay apart until an event carries both")
    void identifiersOfDifferentTypesWithOneValueStayApart() {
        String user = dsu.resolveCanonId("d1", "abc");
        String device = dsu.resolveCanonId("abc", null);

        assertNotEquals(user, device);
        assertEquals(derived("abc"), user);
        assertEquals(deviceRoot("abc"), device);
        assertEquals(user, dsu.resolveCanonId("d1", null));

        assertEquals(user, dsu.resolveCanonId("abc", "abc"));
        assertEquals(user, dsu.resolveCanonId("abc", null));
    }

    @Test
    @DisplayName("Anonymous devices that log in as one user all take the user's root")
    void anonymousDevicesThatLogInAsOneUserTakeTheUsersRoot() {
        assertEquals(deviceRoot("d1"), dsu.resolveCanonId("d1", null));
        assertEquals(deviceRoot("d2"), dsu.resolveCanonId("d2", null));

        assertEquals(derived("u1"), dsu.resolveCanonId("d1", "u1"));
        assertEquals(derived("u1"), dsu.resolveCanonId("d2", "u1"));
        assertEquals(derived("u1"), dsu.resolveCanonId("d3", "u1"));

        assertEquals(derived("u1"), dsu.resolveCanonId("d1", null));
        assertEquals(derived("u1"), dsu.resolveCanonId("d2", null));
        assertEquals(deviceRoot("d4"), dsu.resolveCanonId("d4", null));
    }

    private static String derived(String identifier) {
        return UUID.nameUUIDFromBytes(("canon:" + identifier).getBytes(StandardCharsets.UTF_8)).toString();
    }

    private static String deviceRoot(String domainUserid) {
        return UUID
            .nameUUIDFromBytes(("canon-domain_userid:" + domainUserid).getBytes(StandardCharsets.UTF_8))
            .toString();
    }

    @Test
    @DisplayName("rootPriority is 0 for an identifier the structure does not hold, and adds nothing")
    void rootPriorityOfUnknownIdentifierIsZero() {
        dsu.find(USER_ID, "abc");

        assertEquals(0, dsu.rootPriority(DOMAIN_USERID, "abc"));
        assertEquals(0, dsu.rootPriority(USER_ID, null));
        assertFalse(dsu.containsIdentity(DOMAIN_USERID, "abc"));
        assertEquals(USER_ID.priority(), dsu.rootPriority(USER_ID, "abc"));
    }
}
