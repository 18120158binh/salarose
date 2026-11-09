import type { UserEventUsage } from "@/app/types";
import type { AttributeUses } from "@/lib/db";
import type { SqlQuery } from "@/lib/db";
import type { EventKind, EventStatus } from "shared/lib/eventCatalog";

export type EventDetailAttribute = {
  readonly path: string;
  readonly label: string;
  readonly type: string;
  readonly required: boolean;
  readonly example: string | null;
  readonly defaultValue: string | null;
};

export type EventDetail = {
  readonly id: string;
  readonly name: string;
  readonly label: string;
  readonly description: string | null;
  readonly kind: EventKind;
  readonly status: EventStatus;
  readonly gate: boolean;
  /** When the event was added, or null when the row has no time. */
  readonly createdAt: Date | null;
  readonly attributes: readonly EventDetailAttribute[];
};

export type FieldUses = AttributeUses;

/**
 * The page's whole content: the event, the metric definitions and campaigns that use it, the
 * segments that use it, and the uses of each field by path (CAT-FR-20).
 */
export type EventDetailPage = {
  readonly event: EventDetail;
  readonly uses: UserEventUsage;
  readonly segments: readonly { readonly id: string; readonly name: string; readonly description: string }[];
  readonly fieldUses: Readonly<Record<string, FieldUses>>;
};

export function eventDetailQuery(id: string): SqlQuery {
  return {
    text: `SELECT id, event_name, display_name, description, kind, item_key, status, enforce_schema, created_at FROM user_events WHERE id = $1`,
    values: [id],
  };
}

export function eventDetailAttributesQuery(id: string): SqlQuery {
  return {
    text: `SELECT field_path, display_name, data_type, required, example_value, default_value FROM user_event_fields
WHERE user_event_id = $1 ORDER BY field_path`,
    values: [id],
  };
}

type Row = Record<string, unknown>;

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function kindOf(row: Row): EventKind | null {
  if (row.kind === "person") return { kind: "person" };
  const itemKey = text(row.item_key);
  if (row.kind === "business" && itemKey !== null) return { kind: "business", itemKey };
  return null;
}

/** The event, or null when no row has the id. A row whose kind its CHECK constraints refuse is an error. */
export function parseEventDetail(eventRows: readonly Row[], attributeRows: readonly Row[]): EventDetail | null {
  const row = eventRows[0];
  if (row === undefined) return null;
  const id = text(row.id);
  const name = text(row.event_name);
  const kind = kindOf(row);
  if (id === null || name === null || kind === null) {
    throw new Error(`Event ${String(row.id)} has an id, name, or kind that is not valid.`);
  }
  return {
    id,
    name,
    label: text(row.display_name) ?? name,
    description: text(row.description),
    kind,
    status: row.status === "inactive" ? "inactive" : "active",
    gate: row.enforce_schema === true,
    createdAt: row.created_at instanceof Date ? row.created_at : null,
    attributes: attributeRows.flatMap((attribute): EventDetailAttribute[] => {
      const path = text(attribute.field_path);
      if (path === null) return [];
      return [
        {
          path,
          label: text(attribute.display_name) ?? path,
          type: text(attribute.data_type) ?? "string",
          required: attribute.required === true,
          example: typeof attribute.example_value === "string" ? attribute.example_value : null,
          defaultValue: typeof attribute.default_value === "string" ? attribute.default_value : null,
        },
      ];
    }),
  };
}

/** An attribute's depth in the tree: 0 for `product`, 1 for `product.price`. */
export function attributeDepth(path: string): number {
  return path.split(".").length - 1;
}

/** The last key of a path: `price` for `product.price`. */
export function leafKey(path: string): string {
  return path.slice(path.lastIndexOf(".") + 1);
}

/** The path a rename of the leaf key gives: `product.cost` for `product.price` and `cost`. */
export function renamedPath(path: string, key: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? key.trim() : `${path.slice(0, dot)}.${key.trim()}`;
}

export function eventDetailHref(id: string): string {
  return `/v2/data/events/${encodeURIComponent(id)}`;
}

// CAT-FR-21: the workspace's one vendor prefix. A stored name without a prefix shows with it, as
// tracking sends it.
export const VENDOR_PREFIX = "com.acme/";

/** The name tracking sends: `com.acme/add_to_cart` for `add_to_cart`. */
export function trackingName(name: string): string {
  return name.includes("/") ? name : `${VENDOR_PREFIX}${name}`;
}

/** How many metric definitions, campaigns, and segments use a field (CAT-FR-20). */
export function usesCount(uses: FieldUses | undefined): number {
  return uses === undefined ? 0 : uses.metrics.length + uses.campaigns.length + uses.segments.length;
}

/** The type names marketers read, by stored type. */
export const FIELD_TYPE_LABELS: Readonly<Record<string, string>> = {
  string: "Text",
  number: "Number",
  boolean: "Yes or no",
  datetime: "Date and time",
  json: "Group of fields",
};

export function fieldTypeLabel(type: string): string {
  return FIELD_TYPE_LABELS[type] ?? type;
}
