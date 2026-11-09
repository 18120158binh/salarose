package com.cdp.platform.jobs.eventparser.identity;

import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;

/**
 * Disjoint-Set Union (DSU) / Union-Find Algorithm with Path Compression.
 * Implements deterministic identity stitching across domain and authenticated
 * user IDs.
 */
public class DisjointSetUnion {
    /**
     * An identifier's type. It is part of the identifier, so values of two types
     * never name one entry, and each type derives its root from its own name.
     * Every {@code user_id} derives the root it derived before types were added.
     */
    public enum IdentifierType {
        USER_ID("user_id:", "canon:", 3), DOMAIN_USERID("domain_userid:", "canon-domain_userid:", 2);

        private final String keyPrefix;
        private final String rootPrefix;
        private final int priority;

        IdentifierType(String keyPrefix, String rootPrefix, int priority) {
            this.keyPrefix = keyPrefix;
            this.rootPrefix = rootPrefix;
            this.priority = priority;
        }

        public int priority() {
            return priority;
        }

        String key(String value) {
            return value == null ? null : keyPrefix + value;
        }

        /** The name-based UUID of the root an identifier of this type derives. */
        String derivedRoot(String value) {
            return UUID.nameUUIDFromBytes((rootPrefix + value).getBytes(StandardCharsets.UTF_8)).toString();
        }
    }

    // The caller clears a full structure before an event, never during a merge.
    public static final int MAX_NODES_PER_GRAPH = 200;

    // Kryo reads state written before DisjointSetUnionSerializer by the names and
    // types of both fields. Keep them while such state can still be restored.
    private final Map<String, String> parentMap;
    // Root priority map: 3 = USER_ID, 2 = DOMAIN_ID
    private final Map<String, Integer> rootPriorityMap;

    public DisjointSetUnion() {
        this.parentMap = new HashMap<>();
        this.rootPriorityMap = new HashMap<>();
    }

    /** Takes ownership of the maps. */
    DisjointSetUnion(Map<String, String> parentMap, Map<String, Integer> rootPriorityMap) {
        this.parentMap = parentMap;
        this.rootPriorityMap = rootPriorityMap;
    }

    private DisjointSetUnion(DisjointSetUnion other) {
        this.parentMap = new HashMap<>(other.parentMap);
        this.rootPriorityMap = new HashMap<>(other.rootPriorityMap);
    }

    public DisjointSetUnion copy() {
        return new DisjointSetUnion(this);
    }

    /**
     * Identifiers and roots, the entries that {@link #MAX_NODES_PER_GRAPH} bounds.
     */
    public int size() {
        return parentMap.size();
    }

    Map<String, String> parentLinks() {
        return Collections.unmodifiableMap(parentMap);
    }

    Map<String, Integer> rootPriorities() {
        return Collections.unmodifiableMap(rootPriorityMap);
    }

    /** Copies one stored parent link, as read from an older layout. */
    void link(String id, String parent) {
        parentMap.put(id, parent);
    }

    /** Copies one stored root priority, as read from an older layout. */
    void prioritize(String root, int priority) {
        rootPriorityMap.put(root, priority);
    }

    public void clear() {
        parentMap.clear();
        rootPriorityMap.clear();
    }

    /** The root of the identifier's set, deriving one if the structure lacks it. */
    public String find(IdentifierType type, String value) {
        return findWithPriority(type, value);
    }

    public boolean containsIdentity(IdentifierType type, String value) {
        return value != null && parentMap.containsKey(type.key(value));
    }

    /** The root of a key the structure holds, a root, or an identifier key. */
    private String findRoot(String key) {
        String parent = parentMap.get(key);
        if (parent.equals(key)) return key;

        String root = findRoot(parent);
        parentMap.put(key, root);
        return root;
    }

    /**
     * Seeds an identity mapping from the authoritative identity graph. The supplied
     * canonical ID is retained exactly instead of being converted into a locally
     * generated deterministic UUID. A canonical ID already merged into another set
     * stays there, and the identity joins that set.
     */
    public void seedCanonicalIdentity(IdentifierType type, String identity, String canonId) {
        if (identity == null || canonId == null) return;

        parentMap.putIfAbsent(canonId, canonId);
        String root = findRoot(canonId);
        rootPriorityMap.merge(root, type.priority(), Math::max);
        parentMap.put(type.key(identity), root);
    }

    /**
     * Joins the set of {@code identity} with the set that {@code canonId} names,
     * by priority. A {@code canonId} the structure does not hold becomes a root of
     * the type's priority.
     */
    public void join(IdentifierType type, String identity, String canonId) {
        if (identity == null || canonId == null) return;

        parentMap.putIfAbsent(canonId, canonId);
        String root = findRoot(canonId);
        rootPriorityMap.merge(root, type.priority(), Math::max);
        unionRoots(findWithPriority(type, identity), type.priority(), root, type.priority());
    }

    /**
     * The priority of the root of the identifier's set, or 0 when the structure
     * does not hold the identifier.
     */
    public int rootPriority(IdentifierType type, String value) {
        if (!containsIdentity(type, value)) return 0;
        return rootPriorityMap.getOrDefault(findRoot(type.key(value)), 0);
    }

    private String findWithPriority(IdentifierType type, String value) {
        if (value == null) return null;

        String key = type.key(value);
        if (!parentMap.containsKey(key)) {
            String derivedRoot = type.derivedRoot(value);
            parentMap.put(key, derivedRoot);
            parentMap.putIfAbsent(derivedRoot, derivedRoot);
            rootPriorityMap.putIfAbsent(derivedRoot, type.priority());
            return findRoot(derivedRoot);
        }
        return findRoot(key);
    }

    /** Joins the sets of two identifiers by the priorities of their roots. */
    public boolean union(IdentifierType type1, String value1, IdentifierType type2, String value2) {
        if (value1 == null || value2 == null) return false;

        return unionRoots(findWithPriority(type1, value1), type1.priority(), findWithPriority(type2, value2),
            type2.priority());
    }

    private boolean unionRoots(String root1, int prio1, String root2, int prio2) {
        if (!Objects.equals(root1, root2)) {
            int p1 = rootPriorityMap.getOrDefault(root1, prio1);
            int p2 = rootPriorityMap.getOrDefault(root2, prio2);

            if (p1 > p2) {
                parentMap.put(root2, root1);
            } else if (p2 > p1) {
                parentMap.put(root1, root2);
            } else if (root1.compareTo(root2) <= 0) {
                parentMap.put(root2, root1);
            } else {
                parentMap.put(root1, root2);
            }
            return true;
        }
        return false;
    }

    /**
     * Resolves the unified canon_id for an incoming event's identities. Algorithmic
     * sequence: 1. Union user_id (prio 3) with domain_userid (prio 2) if present.
     * 2. Return canonical root ID.
     *
     * @param domainUserid
     *            Device/Browser domain ID
     * @param userId
     *            Logged in User ID (optional)
     * @return The resolved canonical ID
     */
    public String resolveCanonId(String domainUserid, String userId) {
        if (userId != null) {
            if (domainUserid != null) union(IdentifierType.USER_ID, userId, IdentifierType.DOMAIN_USERID, domainUserid);
            return findWithPriority(IdentifierType.USER_ID, userId);
        }

        if (domainUserid != null) return findWithPriority(IdentifierType.DOMAIN_USERID, domainUserid);

        return null;
    }
}
