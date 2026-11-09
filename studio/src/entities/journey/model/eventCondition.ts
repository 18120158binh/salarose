import type {
  ConditionGroup,
  ConditionGroups,
  EventFilters,
  EventPropertyCondition,
  FieldOperator,
  FieldValue,
} from "./types";

interface CatalogEvent {
  name: string;
  fields?: { value: string; defaultValue?: string }[];
}

/**
 * The filters a node on this catalog event starts with: each default value of the catalog as a
 * group of its own, which the marketer cannot edit. Every group must pass, so a group the
 * marketer adds never weakens them.
 */
export function defaultFiltersFor(event: CatalogEvent): EventFilters {
  return {
    groups: (event.fields ?? [])
      .filter((field) => field.defaultValue)
      .map((field) => ({
        conditions: [
          { type: "event_property", field: field.value, op: "=", value: field.defaultValue as string, isDefault: true },
        ],
      })),
  };
}

/** Whether a group holds only catalog default rows. */
export function isDefaultGroup(group: ConditionGroup<EventPropertyCondition>): boolean {
  return group.conditions.length > 0 && group.conditions.every((condition) => condition.isDefault === true);
}

/** The groups as a node row saves them: catalog default flags dropped, and absent when there is none. */
export function savedGroups<C extends object>(groups: ConditionGroups<C> | undefined): ConditionGroups<C> | undefined {
  if (!groups || groups.groups.length === 0) return undefined;
  return {
    groups: groups.groups.map((group) => ({
      conditions: group.conditions.map((condition) => {
        if (!("isDefault" in condition)) return condition;
        const copy: Partial<Record<"isDefault", unknown>> = { ...condition };
        delete copy.isDefault;
        return copy as C;
      }),
    })),
  };
}

// A decimal number, which customer decision reads as a number.
const DECIMAL_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function numberOrText(text: string, numeric: boolean): string | number {
  const trimmed = text.trim();
  return numeric && DECIMAL_NUMBER.test(trimmed) ? Number(trimmed) : text;
}

/**
 * The value to save for what the editor shows. IN takes a list, split on commas. A number field
 * saves a JSON number, so that the ordering operators compare numbers.
 */
export function typedValue(op: FieldOperator, text: string, fieldType: string): FieldValue {
  const numeric = fieldType === "number";
  if (op === "IN") {
    return text
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .map((item) => numberOrText(item, numeric));
  }
  return numberOrText(text, numeric);
}

/** The text the editor shows for a saved value. */
export function valueText(value: FieldValue | undefined): string {
  if (value === undefined || value === null) return "";
  return Array.isArray(value) ? value.join(", ") : String(value);
}
