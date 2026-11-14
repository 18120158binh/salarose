package com.cdp.platform.jobs.importapplier;

import java.util.Map;

import com.fasterxml.jackson.databind.JsonNode;

/** Where rejected rows go with their values: the admin-only rejects file. */
interface RejectsSink {

    void write(long line, String reason, Map<String, JsonNode> raw);
}
