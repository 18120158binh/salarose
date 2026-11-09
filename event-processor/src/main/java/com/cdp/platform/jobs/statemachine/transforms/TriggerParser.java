package com.cdp.platform.jobs.statemachine.transforms;

import java.io.IOException;
import java.util.Map;

import org.apache.flink.api.common.serialization.DeserializationSchema;
import org.apache.flink.api.common.typeinfo.TypeInformation;
import org.apache.flink.metrics.Counter;
import org.apache.flink.types.Row;

import com.cdp.platform.shared.models.VersionedTrigger;
import com.cdp.platform.shared.utils.ParseResult;

import com.fasterxml.jackson.core.JsonParseException;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.core.json.JsonReadFeature;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.json.JsonMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Decodes and parses each record of the trigger topic. A record that does not
 * decode, or a trigger that does not parse, is logged, counted in
 * {@code invalidMatchedEvents}, and dropped, so the job keeps running.
 *
 * <p>
 * A field is read the way the Flink JSON format read the trigger table: a
 * missing or null field is null, a number or a string of digits is read into a
 * number field, and an object or array in a string field is kept as its JSON.
 */
public final class TriggerParser implements DeserializationSchema<VersionedTrigger> {

    private static final Logger LOG = LoggerFactory.getLogger(TriggerParser.class);
    private static final JsonMapper JSON = JsonMapper
        .builder()
        .enable(JsonReadFeature.ALLOW_UNESCAPED_CONTROL_CHARS)
        .enable(DeserializationFeature.USE_BIG_DECIMAL_FOR_FLOATS)
        .build();
    private static final Map<String, FieldType> FIELDS = Map
        .ofEntries(Map.entry("schema_version", FieldType.INT), Map.entry("event_id", FieldType.STRING),
            Map.entry("canon_id", FieldType.STRING), Map.entry("domain_userid", FieldType.STRING),
            Map.entry("network_userid", FieldType.STRING), Map.entry("user_id", FieldType.STRING),
            Map.entry("campaign_id", FieldType.STRING), Map.entry("node_id", FieldType.STRING),
            Map.entry("branch", FieldType.STRING), Map.entry("event_name", FieldType.STRING),
            Map.entry("event_time", FieldType.BIGINT), Map.entry("context_json", FieldType.STRING),
            Map.entry("graph_version", FieldType.BIGINT), Map.entry("entry_id", FieldType.STRING));

    private transient Counter invalidTriggerCounter;

    @Override
    public void open(InitializationContext context) {
        invalidTriggerCounter = context.getMetricGroup().counter("invalidMatchedEvents");
    }

    /** Returns null for a dropped record, which the source then skips. */
    @Override
    public VersionedTrigger deserialize(byte[] message) {
        Row row;
        try {
            row = decode(message);
        } catch (IOException | NumberFormatException undecodable) {
            invalidTriggerCounter.inc();
            // The message of a decode error quotes the record, so only its class is logged.
            LOG.warn("Dropping a trigger that does not decode: {}", undecodable.getClass().getName());
            return null;
        }
        ParseResult<VersionedTrigger> trigger = VersionedTrigger.parse(row);
        if (trigger.isValid()) {
            return trigger.valueOrThrow();
        }
        invalidTriggerCounter.inc();
        LOG
            .warn("Dropping trigger {} for {}:{}:{}: {}", row.getField("event_id"), row.getField("canon_id"),
                row.getField("campaign_id"), row.getField("node_id"), trigger.failureMessage());
        return null;
    }

    @Override
    public boolean isEndOfStream(VersionedTrigger nextElement) {
        return false;
    }

    @Override
    public TypeInformation<VersionedTrigger> getProducedType() {
        return TypeInformation.of(VersionedTrigger.class);
    }

    private static Row decode(byte[] message) throws IOException {
        Row row = Row.withNames();
        FIELDS.keySet().forEach(name -> row.setField(name, null));
        try (JsonParser parser = JSON.createParser(message == null ? new byte[0] : message)) {
            if (parser.nextToken() != JsonToken.START_OBJECT) {
                throw new JsonParseException(parser, "A trigger must be a JSON object");
            }
            while (parser.nextToken() == JsonToken.FIELD_NAME) {
                String name = parser.currentName();
                FieldType type = FIELDS.get(name);
                JsonToken value = parser.nextToken();
                if (type == null) {
                    parser.skipChildren();
                } else {
                    row.setField(name, value == JsonToken.VALUE_NULL ? null : type.read(parser));
                }
            }
        }
        return row;
    }

    private enum FieldType {
        STRING {
            @Override
            Object read(JsonParser parser) throws IOException {
                return parser.currentToken().isStructStart() ? parser.readValueAsTree().toString() : parser.getText();
            }
        },
        INT {
            @Override
            Object read(JsonParser parser) throws IOException {
                return parser.currentToken().isNumeric()
                    ? parser.getIntValue()
                    : Integer.parseInt(parser.getText().trim());
            }
        },
        BIGINT {
            @Override
            Object read(JsonParser parser) throws IOException {
                return parser.currentToken().isNumeric()
                    ? parser.getLongValue()
                    : Long.parseLong(parser.getText().trim());
            }
        };

        abstract Object read(JsonParser parser) throws IOException;
    }
}
