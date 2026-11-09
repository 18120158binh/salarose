import type { EventKind } from "shared/lib/eventCatalog";
import { type BatchResult, isObject, parseEventTime, UUID } from "./businessEvents";

// The message on the ingestion-api-events topic, which event ingestion reads next to the
// collector's topic (DIA-FR-07, DIA-FR-09).
export interface PersonEventRecord {
  schema_version: 1;
  event_id: string;
  event_name: string;
  event_time: number;
  user_id: string | null;
  anonymous_id: string | null;
  app_id: string;
  attributes: Record<string, unknown> | null;
}

// The device, else the user: the key identity stitching runs under, so one person's events
// stay in order on one partition.
export function personEventKey(record: Pick<PersonEventRecord, "user_id" | "anonymous_id">): string {
  return record.anonymous_id ?? record.user_id ?? "";
}

// Validates each event on its own (DIA-FR-05). `catalog` holds the kind of every event name the
// catalog has. A name the catalog lacks is accepted: rules can use it once it is added.
export function validatePersonEvents(
  events: unknown[],
  catalog: ReadonlyMap<string, EventKind>,
  appId: string,
): BatchResult<PersonEventRecord> {
  const result: BatchResult<PersonEventRecord> = { accepted: [], rejected: [] };
  events.forEach((event, index) => {
    const outcome = validateOne(event, catalog, appId);
    if (typeof outcome === "string") {
      const eventId = isObject(event) && typeof event.event_id === "string" ? event.event_id : undefined;
      result.rejected.push(eventId === undefined ? { index, reason: outcome } : { index, event_id: eventId, reason: outcome });
    } else {
      result.accepted.push(outcome);
    }
  });
  return result;
}

function validateOne(event: unknown, catalog: ReadonlyMap<string, EventKind>, appId: string): PersonEventRecord | string {
  if (!isObject(event)) return "event must be a JSON object";
  const { event_id: eventId, event_name: eventName, event_time: eventTime, attributes } = event;
  if (typeof eventId !== "string" || !UUID.test(eventId)) return "event_id must be a UUID";
  if (typeof eventName !== "string" || !eventName.trim()) return "event_name must be non-empty text";
  const time = parseEventTime(eventTime);
  if (time === null) return "event_time must be ISO 8601 with a zone, or epoch milliseconds";
  const userId = personId(event.user_id);
  const anonymousId = personId(event.anonymous_id);
  if (userId === undefined) return "user_id must be text";
  if (anonymousId === undefined) return "anonymous_id must be text";
  if (userId === null && anonymousId === null) return "user_id or anonymous_id is required";
  if (attributes !== undefined && attributes !== null && !isObject(attributes)) return "attributes must be a JSON object";
  if (catalog.get(eventName)?.kind === "business") {
    return `${eventName} is a business event. Post it to /v1/business-events.`;
  }

  return {
    schema_version: 1,
    event_id: eventId,
    event_name: eventName,
    event_time: time,
    user_id: userId,
    anonymous_id: anonymousId,
    app_id: appId,
    attributes: attributes ?? null,
  };
}

// The trimmed id, null when absent or blank, or undefined when it is not text.
function personId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  return value.trim() || null;
}
