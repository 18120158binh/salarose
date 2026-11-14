package com.cdp.platform.shared.batch;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;

/**
 * A batch job's lock: a session-level advisory lock on the main Postgres, held
 * by one dedicated connection for the whole run. The lock dies with that
 * connection, so the job checks the connection before each state change and
 * every batch, and stops when it is gone.
 */
public final class LockGuard {

    /** The import applier's key, the ASCII of {@code IMPAPPLY}. */
    public static final long IMPORT_APPLIER = 0x494d_5041_5050_4c59L;

    /** The import metric pass's key, the ASCII of {@code IMPMPASS}. */
    public static final long IMPORT_METRIC_PASS = 0x494d_504d_5041_5353L;

    /** The lock's connection dropped: another instance may hold the lock now. */
    public static final class LockLost extends RuntimeException {
        LockLost() {
            super("the lock's connection dropped");
        }
    }

    private final Connection connection;

    private LockGuard(Connection connection) {
        this.connection = connection;
    }

    /** A guard with no lock, for tests. */
    public static LockGuard none() {
        return new LockGuard(null);
    }

    /**
     * Takes the lock on the connection, or returns null when another session holds
     * it.
     */
    public static LockGuard tryAcquire(Connection connection, long key) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement("SELECT pg_try_advisory_lock(?)")) {
            statement.setLong(1, key);
            try (ResultSet result = statement.executeQuery()) {
                result.next();
                return result.getBoolean(1) ? new LockGuard(connection) : null;
            }
        }
    }

    public void check() {
        if (connection == null) return;
        try {
            if (connection.isValid(5)) return;
        } catch (SQLException e) {
            // isValid throws only for a negative timeout.
        }
        throw new LockLost();
    }
}
