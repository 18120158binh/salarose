package com.cdp.platform.jobs.importapplier;

import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.zip.GZIPOutputStream;

import com.cdp.platform.shared.utils.JacksonMapper;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * The rejects file, {@code rejects/<run_id>.ndjson.gz}: one JSON object per
 * rejected row, with its line, reason, and values as delivered. It is written
 * to a local temporary file while the run streams, so memory holds none of it.
 */
final class RejectsFile implements RejectsSink, AutoCloseable {

    private final Path path;
    private final OutputStream out;

    RejectsFile() throws IOException {
        path = Files.createTempFile("rejects-", ".ndjson.gz");
        out = new GZIPOutputStream(new BufferedOutputStream(Files.newOutputStream(path), 1 << 16));
    }

    @Override
    public void write(long line, String reason, Map<String, JsonNode> raw) {
        ObjectNode row = JacksonMapper.instance().createObjectNode();
        row.put("line", line);
        row.put("reason", reason);
        ObjectNode values = row.putObject("values");
        raw.forEach(values::set);
        try {
            out.write(JacksonMapper.writeValueAsBytes(row));
            out.write('\n');
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** Finishes the file and returns it. */
    Path finish() throws IOException {
        out.close();
        return path;
    }

    @Override
    public void close() throws IOException {
        out.close();
        Files.deleteIfExists(path);
    }
}
