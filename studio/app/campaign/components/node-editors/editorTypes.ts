import type { CampaignNode, EventFilters } from "@/entities/journey/model/types";
import { FieldDef, eventFieldType } from "@/entities/journey/model/conditionConfig";

/** A node's settings as its editor reads and writes them. */
export type NodeConfig = CampaignNode["config"];

export type FieldChangeHandler = (field: string, value: unknown) => void;

export type NodeUpdateHandler = (config: NodeConfig, label?: string) => void;

/** An attribute of a catalog or business event, as the pickers offer it. */
export interface EventFieldOption {
  value: string;
  label: string;
  dataType?: string;
  type?: string;
  defaultValue?: string;
}

/** A catalog or business event, as the pickers offer it. */
export interface EventOption {
  id: string;
  name: string;
  label: string;
  fields: EventFieldOption[];
}

/** The fields of the catalog default rows, which the marketer cannot edit. */
export function defaultFieldsIn(filters: EventFilters | undefined): string[] {
  return (filters?.groups ?? []).flatMap((group) =>
    group.conditions.filter((condition) => condition.isDefault === true).map((condition) => condition.field));
}

/** The attributes of an event that a condition can compare. A `json` attribute only holds others. */
export function catalogFields(event: EventOption | undefined): FieldDef[] {
  if (!event) return [];
  return event.fields
    .filter((field) => String(field.dataType || field.type || "").toLowerCase() !== "json")
    .map((field) => ({ ...field, group: "event" as const, type: eventFieldType(field) }));
}
