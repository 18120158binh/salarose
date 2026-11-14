package com.cdp.platform.jobs.importapplier;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Path;
import java.util.Optional;

/**
 * The drop zone: the {@code imports/} prefix of the deployment's bucket. Keys
 * include the prefix.
 */
interface DropZone {

    /**
     * The object's bytes, or empty when there is no object. The caller closes the
     * stream.
     */
    Optional<InputStream> open(String key) throws IOException;

    void put(String key, byte[] body, String contentType) throws IOException;

    void put(String key, Path file, String contentType) throws IOException;
}
