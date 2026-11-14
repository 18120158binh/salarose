package com.cdp.platform.jobs.importapplier;

import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;

/**
 * One row of a file, before validation: its line number and the value of each
 * column it holds, by column name. A CSV value is a text node. An empty CSV
 * cell, and a missing or null NDJSON key, is absent.
 *
 * @param raw
 *            the row as delivered, by header, for the rejects file
 */
record RawRow(long line, boolean csv, Map<String, JsonNode> values, Map<String, JsonNode> raw) {
}
