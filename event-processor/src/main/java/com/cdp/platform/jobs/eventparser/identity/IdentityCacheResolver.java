package com.cdp.platform.jobs.eventparser.identity;

import java.sql.SQLException;
import java.time.Duration;
import java.util.Optional;

import com.cdp.platform.jobs.eventparser.identity.DisjointSetUnion.IdentifierType;
import com.cdp.platform.shared.db.repositories.IdentityGraphRepository.StoredRows;
import com.cdp.platform.shared.models.db.IdentityGraph;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Pure cache policy for identity resolution.
 */
final class IdentityCacheResolver {

    private static final Logger LOG = LoggerFactory.getLogger(IdentityCacheResolver.class);
    // Besides its new identifiers, an event adds at most two entries: another
    // identifier of the stored row and the row's canon_id, or one derived root per
    // new identifier.
    private static final int ENTRIES_BEYOND_NEW_IDENTIFIERS = 2;
    // An identifier that no row seeds adds itself and its derived root.
    private static final int ENTRIES_PER_DERIVED_IDENTIFIER = 2;

    private IdentityCacheResolver() {
    }

    /**
     * Reads the device's row and the user's newest rows from
     * {@code identity_graph}.
     */
    @FunctionalInterface
    interface MappingLookup {
        StoredRows find(String domainUserid, String userId) throws SQLException;
    }

    /**
     * The event's {@code canon_id}, and whether the structure and
     * {@code identity_graph} keep it. After a failed lookup they do not, so the
     * next event reads {@code identity_graph} again instead of a derived id
     * replacing the stored one. {@code clearedEntries} counts the entries of a
     * full structure that the event cleared, or is 0.
     */
    record Resolution(String canonId, boolean stored, int clearedEntries) {
    }

    /**
     * Whether a device whose set holds a user should check the user's rows again:
     * when it has not read {@code identity_graph} for {@code recheckInterval}.
     * The check lets a merge on another device, or a row written after the
     * device's last read, reach the device.
     */
    static boolean recheckDue(DisjointSetUnion dsu, String domainUserid, String userId, Long checkedAt, long now,
        Duration recheckInterval) {
        if (checkedAt != null && now - checkedAt < recheckInterval.toMillis()) return false;
        int userPriority = IdentifierType.USER_ID.priority();
        if (dsu.containsIdentity(IdentifierType.USER_ID, userId)) {
            return dsu.rootPriority(IdentifierType.USER_ID, userId) == userPriority;
        }
        return dsu.containsIdentity(IdentifierType.DOMAIN_USERID, domainUserid)
            && dsu.rootPriority(IdentifierType.DOMAIN_USERID, domainUserid) == userPriority;
    }

    /**
     * The read one event needs, or null when the structure holds every
     * identifier on the event and no recheck is due. A structure that the event
     * could take past {@link DisjointSetUnion#MAX_NODES_PER_GRAPH} is cleared
     * after its read.
     */
    static Read readFor(DisjointSetUnion dsu, String domainUserid, String userId, boolean recheckDue) {
        String newDomainUserid = notIn(dsu, IdentifierType.DOMAIN_USERID, domainUserid);
        String newUserId = notIn(dsu, IdentifierType.USER_ID, userId);
        if (newDomainUserid == null && newUserId == null) return recheckDue ? new Read(false, false) : null;
        return new Read(true, full(dsu, newDomainUserid, newUserId));
    }

    /**
     * One read of {@code identity_graph}: whether the structure misses an
     * identifier on the event, and whether the structure is cleared after it.
     */
    record Read(boolean missesIdentifier, boolean clearsStructure) {
    }

    /**
     * Resolves one event against the device's structure, reading
     * {@code identity_graph} as {@link #readFor} says. An identifier the
     * structure does not hold is seeded from the user's newest row, else from the
     * device's row. Then the user's identifier joins the roots on the user's
     * other rows, so all devices of one user converge on one root. The structure
     * changes only when the resolution is stored.
     */
    static Resolution resolve(DisjointSetUnion dsu, String domainUserid, String userId, boolean recheckDue,
        MappingLookup storedMappings) {
        Read read = readFor(dsu, domainUserid, userId, recheckDue);
        if (read == null) return new Resolution(dsu.resolveCanonId(domainUserid, userId), true, 0);

        String newDomainUserid = read.clearsStructure()
            ? domainUserid
            : notIn(dsu, IdentifierType.DOMAIN_USERID, domainUserid);
        String newUserId = read.clearsStructure() ? userId : notIn(dsu, IdentifierType.USER_ID, userId);
        StoredRows rows;
        try {
            rows = storedMappings.find(domainUserid, userId);
        } catch (SQLException e) {
            if (!read.missesIdentifier()) {
                LOG.warn("Failed to recheck identity_graph; the device keeps its state: {}", e.getMessage());
                return new Resolution(dsu.resolveCanonId(domainUserid, userId), true, 0);
            }
            LOG.warn("Failed to read identity_graph; the event's canon_id is not kept: {}", e.getMessage());
            return new Resolution(dsu.copy().resolveCanonId(domainUserid, userId), false, 0);
        }

        int clearedEntries = read.clearsStructure() ? dsu.size() : 0;
        if (read.clearsStructure()) dsu.clear();
        seedRow(rows, newDomainUserid, newUserId).ifPresent(row -> seedNewIdentifiers(dsu, row, domainUserid, userId));
        joinUsersRoots(dsu, rows, domainUserid, userId);
        return new Resolution(dsu.resolveCanonId(domainUserid, userId), true, clearedEntries);
    }

    /**
     * The newest row of a new {@code user_id} when the user has one, else the
     * device's row for a new {@code domain_userid}. The device's row may hold an
     * anonymous visit or another account.
     */
    private static Optional<IdentityGraph> seedRow(StoredRows rows, String newDomainUserid, String newUserId) {
        if (newUserId != null && !rows.userRows().isEmpty()) return Optional.of(rows.userRows().getFirst());
        return newDomainUserid != null ? rows.deviceRow() : Optional.empty();
    }

    /**
     * Each root on the user's rows names a set that holds the user, so it is the
     * same person as the user's set here. Stops when the structure has room only
     * for the derived roots the event may still add.
     */
    private static void joinUsersRoots(DisjointSetUnion dsu, StoredRows rows, String domainUserid, String userId) {
        int stillDerived = ENTRIES_PER_DERIVED_IDENTIFIER
            * ((notIn(dsu, IdentifierType.DOMAIN_USERID, domainUserid) == null ? 0 : 1)
                + (notIn(dsu, IdentifierType.USER_ID, userId) == null ? 0 : 1));
        for (IdentityGraph row : rows.userRows()) {
            if (dsu.size() + stillDerived >= DisjointSetUnion.MAX_NODES_PER_GRAPH) return;
            if (dsu.containsIdentity(IdentifierType.USER_ID, row.userId())) {
                dsu.join(IdentifierType.USER_ID, row.userId(), row.canonId());
            }
        }
    }

    private static boolean full(DisjointSetUnion dsu, String newDomainUserid, String newUserId) {
        int newIdentifiers = (newDomainUserid == null ? 0 : 1) + (newUserId == null ? 0 : 1);
        return dsu.size() + newIdentifiers + ENTRIES_BEYOND_NEW_IDENTIFIERS > DisjointSetUnion.MAX_NODES_PER_GRAPH;
    }

    private static String notIn(DisjointSetUnion dsu, IdentifierType type, String identifier) {
        return identifier == null || dsu.containsIdentity(type, identifier) ? null : identifier;
    }

    /**
     * An identifier the structure holds keeps its set. The merge then joins that
     * set to the stored one by priority.
     */
    private static void seedNewIdentifiers(DisjointSetUnion dsu, IdentityGraph row, String domainUserid,
        String userId) {
        seedIfNew(dsu, IdentifierType.DOMAIN_USERID, row.domainUserid(), row.canonId());
        seedIfNew(dsu, IdentifierType.USER_ID, row.userId(), row.canonId());
        seedIfNew(dsu, IdentifierType.DOMAIN_USERID, domainUserid, row.canonId());
        seedIfNew(dsu, IdentifierType.USER_ID, userId, row.canonId());
    }

    private static void seedIfNew(DisjointSetUnion dsu, IdentifierType type, String identifier, String canonId) {
        if (notIn(dsu, type, identifier) != null) dsu.seedCanonicalIdentity(type, identifier, canonId);
    }
}
