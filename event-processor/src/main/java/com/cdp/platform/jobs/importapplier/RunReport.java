package com.cdp.platform.jobs.importapplier;

import java.util.List;

import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * The run report of Report, and the counts that go on the run. Both hold only
 * counts, reasons, line numbers, and ids, never a row value or a customer key
 * (IAP-FR-17). Studio's run board reads {@code rows_read}, {@code rejected},
 * {@code rejected_by_reason}, {@code contacts_dropped}, and {@code match_rate}.
 */
final class RunReport {

    private RunReport() {
    }

    /** The counts for {@code import_runs.counts}. */
    static ObjectNode counts(ValidationStats stats) {
        ObjectNode counts = JsonNodeFactory.instance.objectNode();
        counts.put("rows_read", stats.rowsRead);
        counts.put("valid", stats.valid);
        counts.put("rejected", stats.rejected());
        ObjectNode byReason = counts.putObject("rejected_by_reason");
        stats.rejectedByReason.forEach(byReason::put);
        counts.putObject("contacts_dropped").put("email", stats.emailsDropped).put("phone", stats.phonesDropped);
        counts.putObject("contacts_shared").put("email", stats.emailsShared).put("phone", stats.phonesShared);
        counts.put("distinct_customer_keys", stats.distinctKeys);
        Double matchRate = stats.matchRate();
        if (matchRate != null) counts.put("match_rate", matchRate);
        counts.put("new_records", stats.newRecords);
        return counts;
    }

    /** The counts of a run whose file failed, which read no row that counts. */
    static ObjectNode failedCounts() {
        return JsonNodeFactory.instance.objectNode();
    }

    /**
     * The report for {@code reports/<run_id>.json}.
     *
     * @param counts
     *            the run's counts, empty after a file-level failure
     * @param stats
     *            the validation, or null after a file-level failure
     */
    static ObjectNode report(String runId, String recordTypeId, int version, ObjectNode counts,
        List<String> conditions, List<String> fileFailures, ValidationStats stats) {
        ObjectNode report = JsonNodeFactory.instance.objectNode();
        report.put("run_id", runId);
        report.put("record_type_id", recordTypeId);
        report.put("version", version);
        report.set("counts", counts);
        ArrayNode held = report.putArray("quarantine_conditions");
        conditions.forEach(held::add);
        ArrayNode failures = report.putArray("file_failures");
        fileFailures.forEach(failures::add);
        ArrayNode samples = report.putArray("sample_rejects");
        if (stats != null) {
            stats.samples
                .forEach(sample -> samples
                    .addObject()
                    .put("line", sample.line())
                    .put("reason",
                        sample.reason()));
        }
        return report;
    }
}
