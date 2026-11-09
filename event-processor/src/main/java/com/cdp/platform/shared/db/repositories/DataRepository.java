package com.cdp.platform.shared.db.repositories;

/**
 * Generic contract for data platform storage repositories.
 */
public interface DataRepository extends AutoCloseable {

    @Override
    void close();
}
