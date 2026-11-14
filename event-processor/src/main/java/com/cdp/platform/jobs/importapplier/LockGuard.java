package com.cdp.platform.jobs.importapplier;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;

/**
 * The applier lock (IAP-FR-23): a session-level advisory lock on the main
 * Postgres, held by one dedicated connection for the whole run. The lock dies
 * with that connection, so the applier checks the connection before each state
 * change and every few thousand rows, and stops when it is gone.
 */
final class LockGuard {

    /**
     * The advisory lock key, the ASCII of {@code IMPAPPLY}. Any process that takes
     * it is an applier.
     */
    static final long LOCK_KEY = 0x494d_5041_5050_4c59L;

    /** The lock's connection dropped: another instance may hold the lock now. */
    static final class LockLost extends RuntimeException {
        LockLost() {
            super("the applier lock's connection dropped");
        }
    }

    private final Connection connection;

    private LockGuard(Connection connection) {
        this.connection = connection;
    }

    /** A guard with no lock, for tests. */
    static LockGuard none() {
        return new LockGuard(null);
    }

    /**
     * Takes the lock on the connection, or returns null when another session holds
     * it.
     */
    static LockGuard tryAcquire(Connection connection) throws SQLException {
        try (PreparedStatement statement = connection.prepareStatement("SELECT pg_try_advisory_lock(?)")) {
            statement.setLong(1, LOCK_KEY);
            try (ResultSet result = statement.executeQuery()) {
                result.next();
                return result.getBoolean(1) ? new LockGuard(connection) : null;
            }
        }
    }

    void check() {
        if (connection == null) return;
        try {
            if (connection.isValid(5)) return;
        } catch (SQLException e) {
            // isValid throws only for a negative timeout.
        }
        throw new LockLost();
    }
}
