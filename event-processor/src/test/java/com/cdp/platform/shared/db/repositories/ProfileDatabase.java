package com.cdp.platform.shared.db.repositories;

import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.SQLTransientConnectionException;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;

import com.zaxxer.hikari.HikariDataSource;

/**
 * A {@code customer_profiles} table in memory that can go down like Postgres.
 * It holds a city per {@code cdp_uuid}, and the {@code user_id} that
 * {@code identity_graph} holds per {@code canon_id}, and answers only the
 * profile lookup and the lookup of that {@code user_id}.
 */
final class ProfileDatabase extends HikariDataSource {

    private final Map<String, String> cityByCdpUuid = new HashMap<>();
    private final Map<String, String> userIdByCanonId = new HashMap<>();
    private volatile boolean down;
    private final AtomicReference<CountDownLatch> hang = new AtomicReference<>();
    private final AtomicInteger queries = new AtomicInteger();

    void addProfile(String cdpUuid, String city) {
        cityByCdpUuid.put(cdpUuid, city);
    }

    void addIdentity(String canonId, String userId) {
        userIdByCanonId.put(canonId, userId);
    }

    void goDown() {
        down = true;
    }

    void comeBack() {
        down = false;
    }

    /** Holds the next lookup until the latch opens, as a stuck query does. */
    void hangNextLookupUntil(CountDownLatch release) {
        hang.set(release);
    }

    /** How many lookups reached the database, failed ones included. */
    int queries() {
        return queries.get();
    }

    @Override
    public Connection getConnection() throws SQLException {
        queries.incrementAndGet();
        CountDownLatch release = hang.getAndSet(null);
        if (release != null) awaitUninterruptibly(release);
        if (down) throw new SQLTransientConnectionException("Connection is not available, request timed out");
        return proxy(Connection.class, (method, args) -> switch (method) {
            case "prepareStatement" -> ((String) args[0]).contains(IdentityGraphTable.TABLE_NAME)
                ? statement(this::identityRows)
                : statement(this::rows);
            default -> null;
        });
    }

    private static void awaitUninterruptibly(CountDownLatch release) {
        try {
            release.await();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private PreparedStatement statement(Function<String, ResultSet> answer) {
        String[] parameter = new String[1];
        return proxy(PreparedStatement.class, (method, args) -> switch (method) {
            case "setString" -> {
                parameter[0] = (String) args[1];
                yield null;
            }
            case "executeQuery" -> answer.apply(parameter[0]);
            default -> null;
        });
    }

    private ResultSet rows(String cdpUuid) {
        boolean[] hasRow = {cityByCdpUuid.containsKey(cdpUuid)};
        return proxy(ResultSet.class, (method, args) -> switch (method) {
            case "next" -> {
                boolean next = hasRow[0];
                hasRow[0] = false;
                yield next;
            }
            case "getString" -> switch ((String) args[0]) {
                case "cdp_uuid" -> cdpUuid;
                case "city" -> cityByCdpUuid.get(cdpUuid);
                default -> null;
            };
            default -> null;
        });
    }

    private ResultSet identityRows(String canonId) {
        boolean[] hasRow = {userIdByCanonId.containsKey(canonId)};
        return proxy(ResultSet.class, (method, args) -> switch (method) {
            case "next" -> {
                boolean next = hasRow[0];
                hasRow[0] = false;
                yield next;
            }
            case "getString" -> userIdByCanonId.get(canonId);
            default -> null;
        });
    }

    @FunctionalInterface
    private interface Answer {
        Object answer(String method, Object[] args);
    }

    private static <T> T proxy(Class<T> type, Answer answer) {
        return type
            .cast(Proxy
                .newProxyInstance(ProfileDatabase.class.getClassLoader(), new Class<?>[] {type},
                    (proxy, method, args) -> answer.answer(method.getName(), args)));
    }
}
