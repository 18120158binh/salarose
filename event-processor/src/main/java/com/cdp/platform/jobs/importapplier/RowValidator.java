package com.cdp.platform.jobs.importapplier;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.Period;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.function.Predicate;

import com.cdp.platform.shared.models.imports.DatasetColumn;
import com.cdp.platform.shared.models.imports.DatasetVersion;
import com.cdp.platform.shared.models.imports.DatasetVersion.Kind;
import com.cdp.platform.shared.models.imports.DatasetVersion.Role;
import com.cdp.platform.shared.utils.PlaceholderIds;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;

/**
 * Parses each row into the version's types and rejects it by the checks of
 * Validate each row, in the order the contract lists them (IAP-FR-06). Code
 * after this class trusts a {@link Valid} row. It holds the file's seen record
 * ids or customer keys, so one validator reads one file.
 */
final class RowValidator {

    static final String CUSTOMER_KEY_MISSING = "customer_key_missing";
    static final String DELETED_PERSON = "deleted_person";
    static final String RECORD_ID_MISSING = "record_id_missing";
    static final String RECORD_ID_DUPLICATE = "record_id_duplicate";
    static final String CUSTOMER_KEY_DUPLICATE = "customer_key_duplicate";
    static final String EVENT_TIME_INVALID = "event_time_invalid";
    static final String EVENT_TIME_OUT_OF_RANGE = "event_time_out_of_range";

    sealed interface Result permits Valid, Rejected {
    }

    /**
     * A row that passed every check.
     *
     * @param customerKey
     *            exactly as delivered (IAP-FR-07)
     * @param data
     *            every column's value in its type, emails and phones normalized
     */
    record Valid(String customerKey, String recordId, Instant eventTime, ObjectNode data, List<String> emails,
        List<String> phones, int emailsDropped, int phonesDropped) implements Result {
    }

    record Rejected(String reason) implements Result {
    }

    private final DatasetVersion version;
    private final Contacts contacts;
    private final PlaceholderIds placeholders;
    private final Predicate<String> deleted;
    private final Instant earliest;
    private final Instant latest;
    private final SeenKeys seen = new SeenKeys();
    private final String keyColumn;
    private final Set<String> contactColumns = new HashSet<>();

    /**
     * @param deleted
     *            true for a customer key whose tombstone is in
     *            {@code person_tombstones}
     * @param startedAt
     *            when the run started, which the event time range is relative to
     */
    RowValidator(DatasetVersion version, Contacts contacts, PlaceholderIds placeholders, Predicate<String> deleted,
        Instant startedAt, Period historyLimit, Period futureLimit) {
        this.version = version;
        this.contacts = contacts;
        this.placeholders = placeholders;
        this.deleted = deleted;
        OffsetDateTime start = startedAt.atOffset(ZoneOffset.UTC);
        this.earliest = start.minus(historyLimit).toInstant();
        this.latest = start.plus(futureLimit).toInstant();
        this.keyColumn = version.column(Role.CUSTOMER_KEY).orElseThrow();
        contactColumns.addAll(version.columnsOf(Role.EMAIL));
        contactColumns.addAll(version.columnsOf(Role.PHONE));
    }

    Result validate(RawRow row) {
        JsonNode keyValue = row.values().get(keyColumn);
        if (keyValue == null) return new Rejected(CUSTOMER_KEY_MISSING);
        if (!keyValue.isTextual()) return new Rejected(typeMismatch(keyColumn));
        String customerKey = keyValue.asText();
        if (placeholders.normalize(customerKey) == null) return new Rejected(CUSTOMER_KEY_MISSING);
        if (deleted.test(customerKey)) return new Rejected(DELETED_PERSON);

        String recordId = null;
        Instant eventTime = null;
        String eventTimeColumn = null;
        String eventTimeText = null;
        if (version.kind() == Kind.EVENT) {
            String idColumn = version.column(Role.RECORD_ID).orElseThrow();
            JsonNode idValue = row.values().get(idColumn);
            if (idValue != null && !idValue.isTextual()) return new Rejected(typeMismatch(idColumn));
            if (idValue == null || idValue.asText().isBlank()) return new Rejected(RECORD_ID_MISSING);
            recordId = idValue.asText();
            if (!seen.add(recordId)) return new Rejected(RECORD_ID_DUPLICATE);
        } else if (!seen.add(customerKey)) {
            return new Rejected(CUSTOMER_KEY_DUPLICATE);
        }
        if (version.kind() == Kind.EVENT) {
            eventTimeColumn = version.column(Role.EVENT_TIME).orElseThrow();
            JsonNode timeValue = row.values().get(eventTimeColumn);
            Optional<OffsetDateTime> parsed = timeValue != null && timeValue.isTextual()
                ? Values.instant(timeValue.asText(), version.timeZone())
                : Optional.empty();
            if (parsed.isEmpty()) return new Rejected(EVENT_TIME_INVALID);
            eventTime = parsed.get().toInstant();
            eventTimeText = Values.format(parsed.get());
            if (eventTime.isAfter(latest) || eventTime.isBefore(earliest)) {
                return new Rejected(EVENT_TIME_OUT_OF_RANGE);
            }
        }

        ObjectNode data = JsonNodeFactory.instance.objectNode();
        for (DatasetColumn column : version.columns()) {
            JsonNode value = row.values().get(column.name());
            if (value == null || contactColumns.contains(column.name())) continue;
            if (column.name().equals(eventTimeColumn)) {
                data.put(column.name(), eventTimeText);
                continue;
            }
            Optional<JsonNode> typed = Values.parse(column.type(), value, row.csv(), version.timeZone());
            if (typed.isEmpty()) return new Rejected(typeMismatch(column.name()));
            data.set(column.name(), typed.get());
        }

        List<String> emails = new ArrayList<>();
        List<String> phones = new ArrayList<>();
        int emailsDropped = 0;
        int phonesDropped = 0;
        for (String column : version.columnsOf(Role.EMAIL)) {
            JsonNode value = row.values().get(column);
            if (value == null) continue;
            Optional<String> email = value.isTextual() ? Contacts.email(value.asText()) : Optional.empty();
            if (email.isPresent()) {
                emails.add(email.get());
                data.put(column, email.get());
            } else {
                emailsDropped++;
            }
        }
        for (String column : version.columnsOf(Role.PHONE)) {
            JsonNode value = row.values().get(column);
            if (value == null) continue;
            Optional<String> phone = value.isTextual() ? contacts.phone(value.asText()) : Optional.empty();
            if (phone.isPresent()) {
                phones.add(phone.get());
                data.put(column, phone.get());
            } else {
                phonesDropped++;
            }
        }
        return new Valid(customerKey, recordId, eventTime, data, emails, phones, emailsDropped, phonesDropped);
    }

    static String typeMismatch(String column) {
        return "type_mismatch:" + column;
    }
}
