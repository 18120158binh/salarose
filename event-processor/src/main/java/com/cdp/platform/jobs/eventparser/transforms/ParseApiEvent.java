package com.cdp.platform.jobs.eventparser.transforms;

import java.util.EnumSet;

import org.apache.flink.api.common.functions.OpenContext;
import org.apache.flink.streaming.api.functions.ProcessFunction;
import org.apache.flink.util.Collector;

import com.cdp.platform.jobs.eventparser.transforms.DroppedEvents.Reason;
import com.cdp.platform.shared.models.ParsedEvent;
import com.cdp.platform.shared.utils.JacksonMapper;
import com.cdp.platform.shared.utils.PlaceholderIds;

import static java.nio.charset.StandardCharsets.UTF_8;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Turns each message of {@code ingestion-api-events}, one person event that the
 * data ingestion API accepted, into a parsed event like the one a tracker hit
 * with the same fields gives. {@code anonymous_id} becomes
 * {@code domain_userid} and {@code attributes} becomes {@code event_json}. The
 * API validated the event, so a message that does not parse here is dropped to
 * {@link DeadLetter#OUTPUT} like a collector payload.
 */
public class ParseApiEvent extends ProcessFunction<String, ParsedEvent> {

    private final PlaceholderIds placeholderIds;
    private final int deadLetterPayloadLimit;

    private transient ObjectMapper mapper;
    private transient DroppedEvents droppedEvents;

    public ParseApiEvent() {
        this(PlaceholderIds.DEFAULT, DeadLetter.DEFAULT_PAYLOAD_LIMIT);
    }

    public ParseApiEvent(PlaceholderIds placeholderIds, int deadLetterPayloadLimit) {
        this.placeholderIds = placeholderIds;
        this.deadLetterPayloadLimit = deadLetterPayloadLimit;
    }

    @Override
    public void open(OpenContext openContext) {
        mapper = JacksonMapper.instance();
        droppedEvents = new DroppedEvents(getRuntimeContext().getMetricGroup(),
            EnumSet
                .of(Reason.PAYLOAD_NOT_DECODED, Reason.EVENT_NOT_DECODED, Reason.INVALID_EVENT_ID,
                    Reason.NO_TIMESTAMP));
    }

    @Override
    public void processElement(String message, Context context, Collector<ParsedEvent> out) {
        JsonNode event;
        try {
            event = message == null ? null : mapper.readTree(message);
        } catch (JsonProcessingException e) {
            // The message can quote the event, so log only the exception class.
            drop(context, Reason.PAYLOAD_NOT_DECODED, e.getClass().getName(), message, null);
            return;
        }
        if (event == null || !event.isObject()) {
            drop(context, Reason.PAYLOAD_NOT_DECODED, "message", message, null);
            return;
        }

        String eventName = text(event, "event_name");
        eventName = eventName == null || eventName.isBlank() ? null : eventName.trim();
        String eventId = text(event, "event_id");
        if (!ParseSnowplowEvent.isUuid(eventId)) {
            drop(context, Reason.INVALID_EVENT_ID, "event_id", message, eventName);
            return;
        }
        JsonNode eventTime = event.get("event_time");
        if (eventTime == null || !eventTime.canConvertToExactIntegral() || eventTime.asLong() <= 0) {
            drop(context, Reason.NO_TIMESTAMP, "event_time", message, eventName);
            return;
        }
        JsonNode attributes = event.get("attributes");
        boolean hasAttributes = attributes != null && !attributes.isNull();
        if (eventName == null || hasAttributes && !attributes.isObject()) {
            drop(context, Reason.EVENT_NOT_DECODED, eventName == null ? "event_name" : "attributes", message,
                eventName);
            return;
        }

        String appId = placeholderIds.normalize(text(event, "app_id"));
        JsonNode eventData = hasAttributes ? attributes : null;
        // The same columns a tracker event fills from its data, so the two stay alike.
        out
            .collect(new ParsedEvent(null, null, null, eventTime.asLong(), null,
                appId == null ? ParseSnowplowEvent.DEFAULT_APP_ID : appId, eventName,
                placeholderIds.normalize(text(event, "user_id")), null, text(eventData, "screen_location"),
                text(eventData, "value"), null, placeholderIds.normalize(text(event, "anonymous_id")), null,
                eventData == null ? null : eventData.toString(), null, eventId));
    }

    private void drop(Context context, Reason reason, String cause, String message, String eventName) {
        droppedEvents.drop(reason, cause);
        long now = context.timerService().currentProcessingTime();
        byte[] bytes = message == null ? null : message.getBytes(UTF_8);
        DeadLetter payload = DeadLetter
            .payload(reason == Reason.PAYLOAD_NOT_DECODED ? reason : null,
                reason == Reason.PAYLOAD_NOT_DECODED ? cause : null, now, bytes, deadLetterPayloadLimit);
        context.output(DeadLetter.OUTPUT, payload);
        if (reason != Reason.PAYLOAD_NOT_DECODED) {
            context
                .output(DeadLetter.OUTPUT,
                    DeadLetter.event(reason, cause, now, payload.payloadId(), message, eventName, null));
        }
    }

    private static String text(JsonNode node, String field) {
        if (node == null) return null;
        JsonNode value = node.get(field);
        return value == null || value.isNull() ? null : value.asText();
    }
}
