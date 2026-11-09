import type { EventKind } from "shared/lib/eventCatalog";

// DIA-NFR-01
export const MAX_BATCH_EVENTS = 500;
export const MAX_BATCH_BYTES = 1024 * 1024;

// The message on the business-events topic (DIA-FR-14).
export interface BusinessEventRecord {
  schema_version: 1;
  event_id: string;
  event_name: string;
  event_time: number;
  item_key: string;
  app_id: string;
  attributes: Record<string, unknown>;
}

export interface RejectedEvent {
  index: number;
  event_id?: string;
  reason: string;
}

export interface BatchResult<T = BusinessEventRecord> {
  accepted: T[];
  rejected: RejectedEvent[];
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A zone is required: a time without one means a different instant in each sender's zone.
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export function businessEventKey(record: Pick<BusinessEventRecord, "event_name" | "item_key">): string {
  return `${record.event_name}\u001f${record.item_key}`;
}

// The events list of a batch body, or null when the body is not a batch (400).
export function batchEvents(body: unknown): unknown[] | null {
  if (!isObject(body)) return null;
  const events = body.events;
  return Array.isArray(events) ? events : null;
}

// The names to look up in the catalog before validating.
export function eventNames(events: unknown[]): string[] {
  const names = new Set<string>();
  for (const event of events) {
    if (isObject(event) && typeof event.event_name === "string" && event.event_name.trim()) {
      names.add(event.event_name);
    }
  }
  return [...names];
}

// Validates each event on its own (DIA-FR-05). `catalog` holds the kind of every event name the
// catalog has.
export function validateBusinessEvents(
  events: unknown[],
  catalog: ReadonlyMap<string, EventKind>,
  appId: string,
): BatchResult {
  const result: BatchResult = { accepted: [], rejected: [] };
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

// The record, or the reason the event is rejected.
function validateOne(
  event: unknown,
  catalog: ReadonlyMap<string, EventKind>,
  appId: string,
): BusinessEventRecord | string {
  if (!isObject(event)) return "event must be a JSON object";
  const { event_id: eventId, event_name: eventName, event_time: eventTime, attributes } = event;
  if (typeof eventId !== "string" || !UUID.test(eventId)) return "event_id must be a UUID";
  if (typeof eventName !== "string" || !eventName.trim()) return "event_name must be non-empty text";
  const time = parseEventTime(eventTime);
  if (time === null) return "event_time must be ISO 8601 with a zone, or epoch milliseconds";
  if ("user_id" in event || "anonymous_id" in event) {
    return "a business event must not carry user_id or anonymous_id";
  }
  if (attributes !== undefined && !isObject(attributes)) return "attributes must be a JSON object";

  const kind = catalog.get(eventName);
  if (!kind) return `${eventName} is not a business event in the event catalog`;
  if (kind.kind === "person") return `${eventName} is a person event. Post it to /v1/events.`;

  const itemKey = itemKeyAt(attributes ?? {}, kind.itemKey);
  if (itemKey === null) return `the item key ${kind.itemKey} is missing from attributes`;

  return {
    schema_version: 1,
    event_id: eventId,
    event_name: eventName,
    event_time: time,
    item_key: itemKey,
    app_id: appId,
    attributes: attributes ?? {},
  };
}

export function parseEventTime(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !ISO_WITH_ZONE.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

// The value at a dotted path from the root of attributes (DIA-FR-10): non-empty text, or a
// number as text.
function itemKeyAt(attributes: Record<string, unknown>, path: string): string | null {
  let value: unknown = attributes;
  for (const key of path.split(".")) {
    if (!isObject(value)) return null;
    value = value[key];
  }
  if (typeof value === "string") return value.trim() ? value : null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
