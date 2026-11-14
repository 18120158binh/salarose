package com.cdp.platform.jobs.importapplier;

import java.util.List;

/**
 * A failure of the whole file in Read the file. It quarantines the run and
 * applies nothing (IAP-FR-05). The reasons never hold a row value.
 */
final class FileFailure extends Exception {

    static final String CHECKSUM_MISMATCH = "checksum_mismatch";
    static final String ENCODING_INVALID = "encoding_invalid";
    static final String FORMAT_INVALID = "format_invalid";

    private final List<String> reasons;

    FileFailure(String reason) {
        this(List.of(reason));
    }

    FileFailure(List<String> reasons) {
        super(String.join(", ", reasons));
        this.reasons = List.copyOf(reasons);
    }

    List<String> reasons() {
        return reasons;
    }

    /**
     * The reasons without what follows a colon, for logs: a header can be a row
     * value when a file has no header row (IAP-NFR-04).
     */
    String reasonCodes() {
        return String.join(", ", reasons.stream().map(reason -> reason.split(":", 2)[0]).distinct().toList());
    }

    static String roleMissing(String role) {
        return "role_missing:" + role;
    }

    static String columnUnknown(String header) {
        return "column_unknown:" + header;
    }
}
