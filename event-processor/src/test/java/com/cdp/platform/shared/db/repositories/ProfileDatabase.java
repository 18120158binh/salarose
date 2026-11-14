package com.cdp.platform.shared.db.repositories;

import java.lang.reflect.Proxy;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.SQLTransientConnectionException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;

import com.zaxxer.hikari.HikariDataSource;

/**
 * A {@code customer_profiles} table in memory that can go down like Postgres.
 * It holds a city per {@code cdp_uuid}, and the {@code user_id} that
 * {@code identity_graph} holds per {@code canon_id}, and answers only the
 * profile lookup and the lookup of that {@code user_id}. It also holds
 * {@code customer_attributes} rows, and answers the lookup that reads a profile
 * with them.
 */
final class ProfileDatabase extends HikariDataSource {

    private final Map<String, String> cityByCdpUuid = new HashMap<>();
    private final Map<String, String> userIdByCanonId = new HashMap<>();
    private final Map<String, Map<String, String>> attributesByCustomerKey = new HashMap<>();
    private final List<String> statements = new CopyOnWriteArrayList<>();
    private volatile boolean down;
    private final AtomicReference<CountDownLatch> hang = new AtomicReference<>();
    private final AtomicInteger queries = new AtomicInteger();

    void addProfile(String cdpUuid, String city) {
        cityByCdpUuid.put(cdpUuid, city);
    }

    /** Adds a {@code customer_attributes} row with the given JSON object. */
    void addAttributes(String customerKey, String sourceId, String attributesJson) {
        attributesByCustomerKey.computeIfAbsent(customerKey, key -> new HashMap<>()).put(sourceId, attributesJson);
    }

    /** The SQL of every statement prepared, in order. */
    List<String> statements() {
        return statements;
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
            case "prepareStatement" -> prepare((String) args[0]);
            default -> null;
        });
    }

    private PreparedStatement prepare(String sql) {
        statements.add(sql);
        if (sql.contains(IdentityGraphTable.TABLE_NAME)) return statement(this::identityRows);
        if (sql.contains(CustomerAttributesTable.TABLE_NAME)) return statement(id -> rowsWithImported(sql, id));
        return statement(this::rows);
    }

    // One row always: the profile's city if it exists, and the attributes of the
    // sources the query names as one JSON object, or null.
    private ResultSet rowsWithImported(String sql, String id) {
        Map<String, String> rows = attributesByCustomerKey.getOrDefault(id, Map.of());
        StringBuilder imported = new StringBuilder();
        rows.forEach((source, json) -> {
            if (!sql.contains("'" + source + "'")) return;
            imported.append(imported.isEmpty() ? "{" : ",").append('"').append(source).append("\":").append(json);
        });
        String importedJson = imported.isEmpty() ? null : imported.append('}').toString();
        boolean[] hasRow = {true};
        return proxy(ResultSet.class, (method, args) -> switch (method) {
            case "next" -> {
                boolean next = hasRow[0];
                hasRow[0] = false;
                yield next;
            }
            case "getBoolean" -> cityByCdpUuid.containsKey(id);
            case "getString" -> switch ((String) args[0]) {
                case "cdp_uuid" -> cityByCdpUuid.containsKey(id) ? id : null;
                case "city" -> cityByCdpUuid.get(id);
                case "imported" -> importedJson;
                default -> null;
            };
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
