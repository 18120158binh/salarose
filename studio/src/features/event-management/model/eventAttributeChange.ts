import type { EventDetailAttribute } from "./eventDetail";

/**
 * CAT-FR-11: every field change is Safe, Asks first, or Breaking. A Breaking change to a field in
 * use is refused. The server refuses it again in the same transaction as the change.
 */
export type FieldChangeKind = "safe" | "asks-first" | "breaking" | "refused";

/** A rename or a type change is Breaking; a label, an example, or an if-missing value is Safe. */
export function classifyFieldEdit(before: EventDetailAttribute, after: { path: string; type: string }, uses: number): FieldChangeKind {
  if (after.path === before.path && after.type === before.type) return "safe";
  return uses > 0 ? "refused" : "breaking";
}

/** CAT-FR-19: a field inside a group is Safe; inside a field that is not a group, it makes a group. */
export function classifyAddInside(parent: EventDetailAttribute | null, uses: number): FieldChangeKind {
  if (parent === null || parent.type === "json") return "safe";
  return uses > 0 ? "refused" : "breaking";
}

/** CAT-FR-12: a delete is Breaking. */
export function classifyDelete(uses: number): FieldChangeKind {
  return uses > 0 ? "refused" : "breaking";
}

/** CAT-FR-14: Must be sent asks first; making a field optional is Safe. */
export function classifyRequired(required: boolean): FieldChangeKind {
  return required ? "asks-first" : "safe";
}

type Json = string | number | boolean | { [key: string]: Json };

function exampleValue(attribute: EventDetailAttribute): Json | undefined {
  const example = attribute.example;
  if (example === null || example.trim() === "") return undefined;
  const text = example.trim();
  if (attribute.type === "number" && text !== "" && Number.isFinite(Number(text))) return Number(text);
  if (attribute.type === "boolean" && (text === "true" || text === "false")) return text === "true";
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "string") return parsed;
  } catch {
    // An example stored without quotes is the text itself.
  }
  return text;
}

/**
 * The payload one event of this shape sends, built from the fields' examples. A field with no
 * example is left out; a group holds the fields under it that have one.
 */
export function examplePayload(attributes: readonly EventDetailAttribute[]): string {
  const root: { [key: string]: Json } = {};
  for (const attribute of [...attributes].sort((a, b) => a.path.localeCompare(b.path))) {
    if (attribute.type === "json") continue;
    const value = exampleValue(attribute);
    if (value === undefined) continue;
    const keys = attribute.path.split(".");
    let node = root;
    for (const key of keys.slice(0, -1)) {
      const next = node[key];
      if (typeof next !== "object") node[key] = {};
      node = node[key] as { [key: string]: Json };
    }
    node[keys[keys.length - 1]] = value;
  }
  return JSON.stringify(root, null, 2);
}
