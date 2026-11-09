import {
  COLUMN_TYPES,
  DATASET_KINDS,
  DELIMITERS,
  DELIVERY_MODES,
  LIST_ROLES,
  ROLE_LABELS,
  ROLE_RULES,
  SINGLE_ROLES,
  isOneOf,
  type DatasetColumn,
  type DatasetKind,
  type DatasetRoles,
  type DatasetVersion,
  type Role,
} from "./domain";

const SYSTEM_NAME = /^[a-z][a-z0-9_]*$/;

/** DIM-FR-02: lowercase letters, digits, and underscores, starting with a letter. No `.` or `/`. */
export function isSystemName(value: unknown): value is string {
  return typeof value === "string" && SYSTEM_NAME.test(value);
}

export const SYSTEM_NAME_RULE = "Use lowercase letters, digits, and underscores, starting with a letter.";

export function isDatasetKind(value: unknown): value is DatasetKind {
  return isOneOf(DATASET_KINDS, value);
}

export type Parsed<T> = { ok: true; value: T } | { ok: false, problems: string[] };

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseColumn(input: unknown, at: string, problems: string[]): DatasetColumn | null {
  const fields = record(input);
  if (!fields) {
    problems.push(`${at} is not a column.`);
    return null;
  }
  const { name, displayName, type, pii, aliases } = fields;
  const label = typeof name === "string" && name !== "" ? `Column "${name}"` : at;
  if (!isSystemName(name)) problems.push(`${label}: ${SYSTEM_NAME_RULE}`);
  if (typeof displayName !== "string" || displayName.trim() === "") problems.push(`${label} needs a display name.`);
  if (!isOneOf(COLUMN_TYPES, type)) problems.push(`${label} needs a type: ${COLUMN_TYPES.join(", ")}.`);
  const aliasList = aliases === undefined ? [] : aliases;
  const validAliases = Array.isArray(aliasList) && aliasList.every((alias) => typeof alias === "string" && alias.trim() !== "");
  if (!validAliases) problems.push(`${label} has an empty alias.`);
  if (!isSystemName(name) || typeof displayName !== "string" || !isOneOf(COLUMN_TYPES, type) || !validAliases) return null;
  return { name, displayName: displayName.trim(), type, pii: pii === true, aliases: aliasList as string[] };
}

function parseRoles(kind: DatasetKind, input: unknown, columns: DatasetColumn[], problems: string[]): DatasetRoles {
  const fields = record(input) ?? {};
  const byName = new Map(columns.map((column) => [column.name, column]));
  const roles: DatasetRoles = {};
  const unknownRoles = Object.keys(fields).filter((key) => !isOneOf<Role>([...SINGLE_ROLES, ...LIST_ROLES], key));
  for (const key of unknownRoles) problems.push(`"${key}" is not a role.`);

  for (const role of SINGLE_ROLES) {
    const value = fields[role];
    const rule = ROLE_RULES[kind][role];
    if (value === undefined || value === null || value === "") {
      if (rule === "required") problems.push(`Map ${ROLE_LABELS[role]} to a column.`);
      continue;
    }
    if (rule === "absent") {
      problems.push(`A ${kind} dataset has no ${ROLE_LABELS[role]}.`);
      continue;
    }
    if (typeof value !== "string" || !byName.has(value)) {
      problems.push(`${ROLE_LABELS[role]} maps to a column that does not exist.`);
      continue;
    }
    if (role === "deleted_flag" && byName.get(value)?.type !== "boolean") {
      problems.push(`${ROLE_LABELS[role]} must map to a boolean column.`);
      continue;
    }
    roles[role] = value;
  }

  for (const role of LIST_ROLES) {
    const value = fields[role];
    if (value === undefined || value === null || (Array.isArray(value) && value.length === 0)) continue;
    if (ROLE_RULES[kind][role] === "absent") {
      problems.push(`A ${kind} dataset has no ${ROLE_LABELS[role]}.`);
      continue;
    }
    if (!Array.isArray(value) || !value.every((name) => typeof name === "string" && byName.has(name))) {
      problems.push(`${ROLE_LABELS[role]} maps to a column that does not exist.`);
      continue;
    }
    roles[role] = [...new Set(value as string[])];
  }
  return roles;
}

/**
 * DIM-FR-02, DIM-FR-03: parses a version a page sends. Column names follow the system name rule
 * and are unique. No header, name or alias, matches two columns. Every required role of the kind
 * maps to a column, no role the kind lacks is mapped, and a deleted flag maps to a boolean column.
 * Email and phone columns are always PII.
 */
export function parseDatasetVersion(kind: DatasetKind, input: unknown): Parsed<DatasetVersion> {
  const problems: string[] = [];
  const fields = record(input);
  if (!fields) return { ok: false, problems: ["The version is missing."] };

  const rawColumns = Array.isArray(fields.columns) ? fields.columns : [];
  if (rawColumns.length === 0) problems.push("Add at least one column.");
  const columns = rawColumns
    .map((column, index) => parseColumn(column, `Column ${index + 1}`, problems))
    .filter((column): column is DatasetColumn => column !== null);

  const headers = new Map<string, string>();
  for (const column of columns) {
    for (const header of [column.name, ...column.aliases]) {
      const owner = headers.get(header);
      if (owner !== undefined) problems.push(`The header "${header}" matches both "${owner}" and "${column.name}".`);
      else headers.set(header, column.name);
    }
  }

  const roles = parseRoles(kind, fields.roles, columns, problems);
  const contactColumns = new Set([...(roles.email ?? []), ...(roles.phone ?? [])]);
  const flagged = columns.map((column) => (contactColumns.has(column.name) ? { ...column, pii: true } : column));

  const { deliveryMode, timeZone, delimiter } = fields;
  if (!isOneOf(DELIVERY_MODES, deliveryMode)) problems.push("Pick a delivery mode: incremental or snapshot.");
  if (typeof timeZone !== "string" || !isTimeZone(timeZone)) problems.push("Pick a time zone.");
  if (!isOneOf(DELIMITERS, delimiter)) problems.push("Pick a delimiter: comma or semicolon.");

  if (problems.length > 0 || !isOneOf(DELIVERY_MODES, deliveryMode) || !isOneOf(DELIMITERS, delimiter)) {
    return { ok: false, problems };
  }
  return { ok: true, value: { columns: flagged, roles, deliveryMode, timeZone: timeZone as string, delimiter } };
}

export interface VersionChange {
  /** Columns renamed, retyped, or deleted: refused while anything uses them (DIM-FR-05). */
  breakingColumns: string[];
  /** A role mapping, the delivery mode, or the time zone changed (DIM-FR-06). */
  rederives: boolean;
  /** False when only display names or PII flags changed, which save without a new version. */
  newVersion: boolean;
}

/** What saving `next` over `current` does, by the table in data-import.md's Versions. */
export function versionChange(current: DatasetVersion, next: DatasetVersion): VersionChange {
  const nextByName = new Map(next.columns.map((column) => [column.name, column]));
  const breakingColumns = current.columns
    .filter((column) => nextByName.get(column.name)?.type !== column.type)
    .map((column) => column.name);
  const rederives =
    JSON.stringify(sortedRoles(current.roles)) !== JSON.stringify(sortedRoles(next.roles)) ||
    current.deliveryMode !== next.deliveryMode ||
    current.timeZone !== next.timeZone;
  const currentNames = new Set(current.columns.map((column) => column.name));
  const added = next.columns.some((column) => !currentNames.has(column.name));
  const aliasesChanged = next.columns.some((column) => {
    const before = current.columns.find((old) => old.name === column.name);
    return before !== undefined && JSON.stringify(before.aliases) !== JSON.stringify(column.aliases);
  });
  const newVersion =
    breakingColumns.length > 0 || rederives || added || aliasesChanged || current.delimiter !== next.delimiter;
  return { breakingColumns, rederives, newVersion };
}

function sortedRoles(roles: DatasetRoles): [string, unknown][] {
  return Object.entries(roles)
    .filter(([, value]) => value !== undefined)
    .map(([role, value]): [string, unknown] => [role, Array.isArray(value) ? [...value].sort() : value])
    .sort(([a], [b]) => a.localeCompare(b));
}
