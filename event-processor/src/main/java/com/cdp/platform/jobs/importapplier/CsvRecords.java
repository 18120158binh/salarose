package com.cdp.platform.jobs.importapplier;

import java.io.IOException;
import java.io.Reader;
import java.util.ArrayList;
import java.util.List;

/**
 * A streaming RFC 4180 reader. A record ends at CRLF or LF. A field is quoted
 * or plain: a quoted field doubles each quote inside it and must end at a
 * delimiter or a record end, and a plain field holds no quote. A line with no
 * character at all is skipped. Anything else fails with
 * {@code format_invalid}.
 */
final class CsvRecords {

    private final Reader reader;
    private final char delimiter;
    private long line = 1;
    private long recordLine;

    CsvRecords(Reader reader, char delimiter) {
        this.reader = reader;
        this.delimiter = delimiter;
    }

    /** The physical line the last record started on, 1 for the header. */
    long recordLine() {
        return recordLine;
    }

    /** The next record's fields, or null at the end of the input. */
    List<String> next() throws IOException, FileFailure {
        int c = read();
        while (c == '\n' || c == '\r') {
            if (c == '\r' && read() != '\n') throw new FileFailure(FileFailure.FORMAT_INVALID);
            line++;
            c = read();
        }
        if (c == -1) return null;
        recordLine = line;
        List<String> fields = new ArrayList<>();
        StringBuilder field = new StringBuilder();
        while (true) {
            if (c == '"' && field.isEmpty()) {
                c = quoted(field);
            } else {
                while (c != -1 && c != delimiter && c != '\n' && c != '\r') {
                    if (c == '"') throw new FileFailure(FileFailure.FORMAT_INVALID);
                    field.append((char) c);
                    c = read();
                }
            }
            fields.add(field.toString());
            field.setLength(0);
            if (c == delimiter) {
                c = read();
                continue;
            }
            if (c == '\r' && read() != '\n') throw new FileFailure(FileFailure.FORMAT_INVALID);
            if (c != -1) line++;
            return fields;
        }
    }

    /**
     * Reads a quoted field after its opening quote, and returns the character after
     * its closing quote.
     */
    private int quoted(StringBuilder field) throws IOException, FileFailure {
        while (true) {
            int c = read();
            if (c == -1) throw new FileFailure(FileFailure.FORMAT_INVALID);
            if (c == '"') {
                int after = read();
                if (after != '"') {
                    if (after != -1 && after != delimiter && after != '\n' && after != '\r')
                        throw new FileFailure(FileFailure.FORMAT_INVALID);
                    return after;
                }
            } else if (c == '\n') {
                line++;
            }
            field.append((char) c);
        }
    }

    private int read() throws IOException {
        return reader.read();
    }
}
