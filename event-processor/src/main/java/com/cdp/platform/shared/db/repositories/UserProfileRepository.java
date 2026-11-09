package com.cdp.platform.shared.db.repositories;

import java.time.Duration;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import com.cdp.platform.shared.config.DatabaseConfig;
import com.cdp.platform.shared.models.db.UserProfile;
import com.cdp.platform.shared.utils.BoundedLookupPool;
import com.cdp.platform.shared.utils.JdbcUtil;

import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import com.zaxxer.hikari.HikariDataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Repository dedicated to user profile lookups.
 * Extends {@link AbstractDatabaseRepository} for connection pooling and query
 * execution.
 */
public final class UserProfileRepository extends AbstractDatabaseRepository {

    private static final Logger LOG = LoggerFactory.getLogger(UserProfileRepository.class);
    private static final Duration READ_CONNECTION_TIMEOUT = Duration.ofSeconds(5);

    private final ExecutorService lookupExecutor;
    private final Cache<ProfileKey, UserProfile> profileCache;
    private final Cache<String, String> userIdByCanonId;

    private UserProfileRepository(HikariDataSource dataSource, ExecutorService lookupExecutor,
        Cache<ProfileKey, UserProfile> profileCache, Cache<String, String> userIdByCanonId) {
        super(dataSource);
        this.lookupExecutor = lookupExecutor;
        this.profileCache = profileCache;
        this.userIdByCanonId = userIdByCanonId;
    }

    /** Looks profiles up in the database's read replica. */
    public static UserProfileRepository openAsync(DatabaseConfig database, int maxPoolSize, int cacheMaxEntries,
        int cacheTtlMinutes) {
        return open(readPool(database, maxPoolSize), Executors.newFixedThreadPool(maxPoolSize), maxPoolSize,
            cacheMaxEntries, cacheTtlMinutes);
    }

    /**
     * Looks profiles up in the database's read replica with {@code threads}
     * threads, and lets wait only as many lookups as they finish within the lookup
     * timeout. Beyond that, the calling thread runs the lookup itself.
     */
    public static UserProfileRepository openBounded(DatabaseConfig database, int threads, int cacheMaxEntries,
        int cacheTtlMinutes, Duration lookupTimeout) {
        return openBounded(readPool(database, threads), threads, cacheMaxEntries, cacheTtlMinutes, lookupTimeout);
    }

    private static HikariDataSource readPool(DatabaseConfig database, int maxPoolSize) {
        return JdbcUtil
            .createDataSource(database.readJdbcUrl(), database.user(), database.password(), maxPoolSize,
                READ_CONNECTION_TIMEOUT);
    }

    /** Looks profiles up in the given pool. Tests pass one without Postgres. */
    static UserProfileRepository openBounded(HikariDataSource dataSource, int threads, int cacheMaxEntries,
        int cacheTtlMinutes, Duration lookupTimeout) {
        // A read waits for a connection and then for its result, each up to the
        // connection timeout.
        Duration longestRead = Duration.ofMillis(2 * dataSource.getConnectionTimeout());
        return open(dataSource, BoundedLookupPool.create(threads, lookupTimeout, longestRead), threads,
            cacheMaxEntries, cacheTtlMinutes);
    }

    private static UserProfileRepository open(HikariDataSource dataSource, ExecutorService executor,
        int maxPoolSize, int cacheMaxEntries, int cacheTtlMinutes) {
        Cache<ProfileKey, UserProfile> cache = Caffeine
            .newBuilder()
            .maximumSize(cacheMaxEntries)
            .expireAfterWrite(cacheTtlMinutes, TimeUnit.MINUTES)
            .build();
        Cache<String, String> userIds = Caffeine
            .newBuilder()
            .maximumSize(cacheMaxEntries)
            .expireAfterWrite(cacheTtlMinutes, TimeUnit.MINUTES)
            .build();
        LOG
            .info("Async profile repository configured with threads={}, cacheMaxEntries={}, cacheTtlMinutes={}",
                maxPoolSize, cacheMaxEntries, cacheTtlMinutes);
        return new UserProfileRepository(dataSource, executor, cache, userIds);
    }

    /**
     * The columns of the profile whose {@code cdp_uuid} is the key's id, if any. A
     * failed query throws.
     */
    private Optional<UserProfile> findProfile(ProfileKey key) {
        return queryForObject(CustomerProfilesTable.lookupSql(key.columns()),
            statement -> statement.setString(1, key.lookupId()),
            row -> CustomerProfilesTable.profile(row, key.columns()));
    }

    /**
     * The {@code cdp_uuid} that a person's profile is looked up by: the
     * {@code user_id}, else the {@code user_id} that {@code identity_graph} holds
     * for the {@code canon_id}, else none. A blank id is no id. A failed query
     * throws.
     */
    private Optional<String> lookupId(String userId, String canonId) {
        if (hasText(userId)) return Optional.of(userId);
        if (!hasText(canonId)) return Optional.empty();
        return Optional.ofNullable(userIdByCanonId.get(canonId, this::storedUserId));
    }

    private String storedUserId(String canonId) {
        return queryForObject(IdentityGraphTable.userIdOfCanonSql(), statement -> statement.setString(1, canonId),
            row -> row.getString(IdentityGraphTable.USER_ID)).filter(UserProfileRepository::hasText).orElse(null);
    }

    private static boolean hasText(String id) {
        return id != null && !id.isBlank();
    }

    /**
     * Every column of the profile, as
     * {@link #findProfileAsync(String, String, Set)} finds it.
     */
    public CompletableFuture<UserProfile> findProfileAsync(String userId, String canonId) {
        return findProfileAsync(userId, canonId, Set.copyOf(CustomerProfilesTable.COLUMNS));
    }

    /**
     * The given columns of a person's profile, or an empty profile when there is
     * none or no column is asked for. The profile is the one whose
     * {@code cdp_uuid} is the person's {@code user_id}, else the {@code user_id}
     * that {@code identity_graph} holds for their {@code canon_id}. Without either
     * there is no profile. The other fields are null. Only a found profile, and a
     * found {@code user_id}, is cached, so one created later is found on the next
     * lookup. A failed query completes the future exceptionally and is not cached
     * either. A lookup cancelled while it waits for a thread skips its queries.
     */
    public CompletableFuture<UserProfile> findProfileAsync(String userId, String canonId, Set<String> columns) {
        if (columns.isEmpty() || !hasText(userId) && !hasText(canonId)) {
            return CompletableFuture.completedFuture(UserProfile.empty());
        }
        Set<String> read = Set.copyOf(columns);
        return CompletableFuture
            .supplyAsync(() -> lookupId(userId, canonId)
                .map(id -> profileCache.get(new ProfileKey(id, read), missing -> findProfile(missing).orElse(null)))
                .orElseGet(UserProfile::empty), lookupExecutor);
    }

    @Override
    public void close() {
        if (lookupExecutor != null) {
            lookupExecutor.shutdown();
            try {
                if (!lookupExecutor.awaitTermination(5, TimeUnit.SECONDS)) lookupExecutor.shutdownNow();
            } catch (InterruptedException interrupted) {
                lookupExecutor.shutdownNow();
                Thread.currentThread().interrupt();
            }
        }
        super.close();
    }

    /** A cache entry: the columns read of one profile. */
    private record ProfileKey(String lookupId, Set<String> columns) {
    }
}
