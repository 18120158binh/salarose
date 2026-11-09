package com.cdp.platform.shared.db.repositories;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Optional;

import com.zaxxer.hikari.HikariDataSource;

/**
 * Abstract generic base class for relational database repositories.
 * Encapsulates connection pooling, PreparedStatement binding, ResultSet
 * mapping,
 * and error handling into reusable generic query methods.
 */
public abstract class AbstractDatabaseRepository implements DataRepository {

    protected final HikariDataSource dataSource;

    protected AbstractDatabaseRepository(HikariDataSource dataSource) {
        this.dataSource = dataSource;
    }

    /**
     * Executes a database query expecting a single optional mapped record. A
     * failed query throws, so the caller cannot mistake it for a missing record.
     * The query waits for its result no longer than for a connection.
     */
    protected <T> Optional<T> queryForObject(String sql, SqlStatementBinder binder, SqlRowMapper<T> mapper) {
        try (Connection connection = dataSource.getConnection()) {
            // The pool resets the timeout when the connection returns to it.
            connection.setNetworkTimeout(Runnable::run, (int) dataSource.getConnectionTimeout());
            try (PreparedStatement statement = connection.prepareStatement(sql)) {
                binder.bind(statement);
                try (ResultSet resultSet = statement.executeQuery()) {
                    if (!resultSet.next()) return Optional.empty();
                    return Optional.ofNullable(mapper.mapRow(resultSet));
                }
            }
        } catch (Exception exception) {
            throw new IllegalStateException("Database query failed", exception);
        }
    }

    @FunctionalInterface
    public interface SqlStatementBinder {
        void bind(PreparedStatement statement) throws SQLException;
    }

    @FunctionalInterface
    public interface SqlRowMapper<T> {
        T mapRow(ResultSet resultSet) throws Exception;
    }

    @Override
    public void close() {
        if (dataSource != null && !dataSource.isClosed()) dataSource.close();
    }
}
