package com.cdp.platform.jobs.importapplier;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.cdp.platform.shared.models.imports.DatasetColumn;
import com.cdp.platform.shared.models.imports.DatasetVersion;
import com.cdp.platform.shared.models.imports.DatasetVersion.Role;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.TextNode;

/**
 * Reads a decompressed file as rows, by Read the file: strict UTF-8, CSV with
 * the version's delimiter or NDJSON, and header matching. A header matches a
 * column when it equals the column's name or one of its aliases, exactly. For
 * NDJSON each top-level key plays the role of a header.
 */
final class FileRows {

    private static final ObjectMapper JSON = new ObjectMapper()
        .enable(JsonParser.Feature.STRICT_DUPLICATE_DETECTION);

    /**
     * The most characters a CSV record or an NDJSON line may hold: 1 MiB
     * (IAP-NFR-01).
     */
    static final int MAX_RECORD_CHARS = 1 << 20;

    private final DatasetVersion version;
    private final boolean csv;
    private final BufferedReader reader;
    private final Map<String, String> columnOfHeader = new HashMap<>();
    private final Set<String> seenColumns = new HashSet<>();
    private CsvRecords records;
    private List<String> headers;
    private long line;

    private FileRows(DatasetVersion version, boolean csv, InputStream input) {
        this.version = version;
        this.csv = csv;
        this.reader = new BufferedReader(new InputStreamReader(input,
            StandardCharsets.UTF_8
                .newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)),
            1 << 16);
        for (DatasetColumn column : version.columns()) {
            columnOfHeader.putIfAbsent(column.name(), column.name());
            for (String alias : column.aliases()) {
                columnOfHeader.putIfAbsent(alias, column.name());
            }
        }
    }

    /**
     * Opens the file and, for CSV, reads and checks its header.
     *
     * @param format
     *            {@code csv} or {@code ndjson}, without the gzip suffix
     */
    static FileRows open(DatasetVersion version, String format, InputStream input) throws IOException, FileFailure {
        FileRows rows = switch (format) {
            case "csv" -> new FileRows(version, true, input);
            case "ndjson" -> new FileRows(version, false, input);
            default -> throw new FileFailure(FileFailure.FORMAT_INVALID);
        };
        if (rows.csv) rows.readHeader();
        return rows;
    }

    private void readHeader() throws IOException, FileFailure {
        skipByteOrderMark();
        records = new CsvRecords(reader, version.delimiter());
        List<String> header = decoding(records::next);
        if (header == null) header = List.of();
        List<String> failures = new ArrayList<>();
        Set<String> columns = new HashSet<>();
        for (String name : header) {
            String column = columnOfHeader.get(name);
            if (column == null) {
                failures.add(FileFailure.columnUnknown(name));
            } else if (!columns.add(column)) {
                // Two headers for one column leave no single value to read.
                failures.add(FileFailure.FORMAT_INVALID);
            }
        }
        seenColumns.addAll(columns);
        failures.addAll(missingRoles());
        if (!failures.isEmpty()) throw new FileFailure(failures.stream().distinct().toList());
        headers = header;
    }

    private void skipByteOrderMark() throws IOException, FileFailure {
        reader.mark(1);
        if (decoding(reader::read) != '﻿') reader.reset();
    }

    /** The required roles whose column no header has matched. */
    List<String> missingRoles() {
        List<String> missing = new ArrayList<>();
        for (Role role : Role.values()) {
            if (role.requiredFor(version.kind()) && !seenColumns.contains(version.column(role).orElseThrow())) {
                missing.add(FileFailure.roleMissing(role.wireName()));
            }
        }
        return missing;
    }

    /** The next row, or null at the end of the file. */
    RawRow next() throws IOException, FileFailure {
        return csv ? nextCsv() : nextJson();
    }

    private RawRow nextCsv() throws IOException, FileFailure {
        List<String> fields = decoding(records::next);
        if (fields == null) return null;
        if (fields.size() != headers.size()) throw new FileFailure(FileFailure.FORMAT_INVALID);
        Map<String, JsonNode> values = new LinkedHashMap<>();
        Map<String, JsonNode> raw = new LinkedHashMap<>();
        for (int i = 0; i < fields.size(); i++) {
            String value = fields.get(i);
            raw.put(headers.get(i), TextNode.valueOf(value));
            if (!value.isEmpty()) values.put(columnOfHeader.get(headers.get(i)), TextNode.valueOf(value));
        }
        return new RawRow(records.recordLine(), true, values, raw);
    }

    private RawRow nextJson() throws IOException, FileFailure {
        String text;
        do {
            text = decoding(this::readBoundedLine);
            if (text == null) return null;
            line++;
            if (line == 1 && text.startsWith("﻿")) text = text.substring(1);
        } while (text.isBlank());
        JsonNode node;
        try {
            node = JSON.readTree(text);
        } catch (JsonProcessingException e) {
            throw new FileFailure(FileFailure.FORMAT_INVALID);
        }
        if (node == null || !node.isObject()) throw new FileFailure(FileFailure.FORMAT_INVALID);
        Map<String, JsonNode> values = new LinkedHashMap<>();
        Map<String, JsonNode> raw = new LinkedHashMap<>();
        var fields = node.fields();
        while (fields.hasNext()) {
            var field = fields.next();
            String column = columnOfHeader.get(field.getKey());
            if (column == null) throw new FileFailure(FileFailure.columnUnknown(field.getKey()));
            seenColumns.add(column);
            raw.put(field.getKey(), field.getValue());
            if (!field.getValue().isNull() && values.put(column, field.getValue()) != null) {
                // A key and an alias of one column in one object.
                throw new FileFailure(FileFailure.FORMAT_INVALID);
            }
        }
        return new RawRow(line, false, values, raw);
    }

    /**
     * Reads one NDJSON line without its line end, or null at the end. A line
     * longer than {@link #MAX_RECORD_CHARS} is {@code format_invalid}, so a file
     * with no line ends cannot exhaust the heap.
     */
    private String readBoundedLine() throws IOException, FileFailure {
        StringBuilder text = new StringBuilder();
        int c = reader.read();
        if (c == -1) return null;
        while (c != -1 && c != '\n') {
            if (text.length() == MAX_RECORD_CHARS) throw new FileFailure(FileFailure.FORMAT_INVALID);
            text.append((char) c);
            c = reader.read();
        }
        int last = text.length() - 1;
        if (last >= 0 && text.charAt(last) == '\r') text.setLength(last);
        return text.toString();
    }

    private interface Read<T> {
        T read() throws IOException, FileFailure;
    }

    private static <T> T decoding(Read<T> read) throws IOException, FileFailure {
        try {
            return read.read();
        } catch (CharacterCodingException e) {
            throw new FileFailure(FileFailure.ENCODING_INVALID);
        }
    }
}
