package com.cdp.platform.shared.db.repositories;

/**
 * The table {@code person_tombstones} on the main Postgres: deleted people, by
 * the HMAC-SHA-256 of the customer key under the tombstone key, in lowercase
 * hex. Studio creates rows. The import applier moves them to {@code done}.
 */
public final class PersonTombstonesTable {

    public static final String TABLE_NAME = "person_tombstones";
    public static final String CUSTOMER_KEY_HASH = "customer_key_hash";
    public static final String STATE = "state";

    private PersonTombstonesTable() {
    }
}
