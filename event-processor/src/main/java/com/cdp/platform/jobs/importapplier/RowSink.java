package com.cdp.platform.jobs.importapplier;

/** Where a file's rows go after validation, in file order. */
@FunctionalInterface
interface RowSink {

    void valid(RowValidator.Valid row);

    /**
     * A rejected row.
     *
     * @param key
     *            the row's key when the applier can read it, or null
     */
    default void rejected(String key) {
    }
}
