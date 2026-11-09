import { UserFacingError } from "./userFacingError";

// CAT-FR-02: the catalog already has an event with this system name. It carries the name so the
// caller can find the existing event and offer it.
export class DuplicateEventNameError extends UserFacingError {
  constructor(readonly eventName: string) {
    super(`An event with the system name "${eventName}" already exists.`);
  }
}

// The rules for what the event catalog stores. The server parses each write with them, and the
// browser forms use the same ones, so that both agree on a name, a path, and a type.

export const EVENT_ATTRIBUTE_TYPES = [
  { value: "string", label: "String" },
  { value: "number", label: "Number" },
  { value: "boolean", label: "Boolean" },
  { value: "datetime", label: "Datetime" },
  { value: "json", label: "JSON Object" },
] as const;

export type EventAttributeType = (typeof EVENT_ATTRIBUTE_TYPES)[number]["value"];

const TYPE_VALUES: readonly string[] = EVENT_ATTRIBUTE_TYPES.map((type) => type.value);

// An inactive event stays in the catalog, but the builder no longer offers it.
export const EVENT_STATUSES = ["active", "inactive"] as const;

export type EventStatus = (typeof EVENT_STATUSES)[number];

export function parseEventStatus(value: unknown): EventStatus {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!(EVENT_STATUSES as readonly string[]).includes(status)) {
    throw new UserFacingError(`The status "${String(value)}" is not one of ${EVENT_STATUSES.join(", ")}.`);
  }
  return status as EventStatus;
}

// A person event is sent with a person id. A business event is about an item, such as a price
// drop, and its item key is the attribute path that names the item.
export const EVENT_KINDS = ["person", "business"] as const;

export type EventKind = { kind: "person" } | { kind: "business"; itemKey: string };

export function parseEventKind(value: unknown): EventKind {
  const input = typeof value === "object" && value !== null ? (value as { kind?: unknown; itemKey?: unknown }) : {};
  const kind = typeof input.kind === "string" ? input.kind : "";
  if (kind === "person") return { kind: "person" };
  if (kind !== "business") {
    throw new UserFacingError(`The kind "${String(input.kind)}" is not one of ${EVENT_KINDS.join(", ")}.`);
  }
  if (typeof input.itemKey !== "string" || !input.itemKey.trim()) {
    throw new UserFacingError("A business event needs an item key, one of its attributes such as product.id.");
  }
  return { kind: "business", itemKey: parseEventAttributePath(input.itemKey) };
}

// Lowercase, with underscores for spaces. The form applies it as the admin types, so it keeps a
// trailing space as an underscore until the next key.
export function normalizeEventSystemName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "_");
}

export function parseEventSystemName(value: unknown): string {
  const name = typeof value === "string" ? normalizeEventSystemName(value.trim()) : "";
  if (!name) throw new UserFacingError("The system name is required.");
  return name;
}

// A dotted path from the root. Each key is trimmed, and no key may be empty.
export function parseEventAttributePath(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new UserFacingError("The attribute path is required.");
  const keys = text.split(".").map((key) => key.trim());
  if (keys.some((key) => !key)) {
    throw new UserFacingError(`The attribute path "${text}" has an empty key.`);
  }
  return keys.join(".");
}

export function parseEventAttributeType(value: unknown): EventAttributeType {
  const type = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!TYPE_VALUES.includes(type)) {
    throw new UserFacingError(`The type "${String(value)}" is not one of ${TYPE_VALUES.join(", ")}.`);
  }
  return type as EventAttributeType;
}

// The attributes of a new event, with each path and type parsed. Two attributes at one path are
// refused, since one of them would be lost.
export function parseNewEventAttributes<T extends { field_path: string; data_type: string }>(
  attributes: T[],
): (T & { data_type: EventAttributeType })[] {
  const seen = new Set<string>();
  return attributes.map((attribute) => {
    const path = parseEventAttributePath(attribute.field_path);
    if (seen.has(path)) throw new UserFacingError(`Two attributes have the path "${path}".`);
    seen.add(path);
    return { ...attribute, field_path: path, data_type: parseEventAttributeType(attribute.data_type) };
  });
}
