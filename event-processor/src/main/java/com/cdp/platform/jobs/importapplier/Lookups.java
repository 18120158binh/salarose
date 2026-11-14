package com.cdp.platform.jobs.importapplier;

import java.util.List;

/**
 * The reads that validation and the decision need beyond the file itself. Each
 * takes one batch.
 */
interface Lookups {

    /** An email or phone of a valid profile row, normalized. */
    record Contact(String customerKey, String type, String value) {
    }

    record Shared(long emails, long phones) {
    }

    /**
     * How many of the keys {@code identity_graph} holds as a {@code user_id},
     * compared exactly.
     */
    int matchedUserIds(List<String> customerKeys);

    /** How many of the distinct record ids the import store holds for the type. */
    int storedRecordIds(String recordTypeId, List<String> recordIds);

    /**
     * The contacts that another customer key already holds in
     * {@code import_identifiers}.
     */
    Shared sharedContacts(List<Contact> contacts);

    /** The rows {@code import_records} holds now, for the record cap. */
    long storedRecords();
}
