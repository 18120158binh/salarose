import { createHmac } from "node:crypto";
import type { SqlQuery } from "@/lib/db";
import type { DatasetVersion } from "./domain";

export type PiiKind = "email" | "phone" | "other";

/** How a column of a version masks: by its role for email and phone, `other` for a flagged column, null when not PII. */
export function piiKindOf(version: DatasetVersion, columnName: string): PiiKind | null {
  if (version.roles.email?.includes(columnName)) return "email";
  if (version.roles.phone?.includes(columnName)) return "phone";
  return version.columns.some((column) => column.name === columnName && column.pii) ? "other" : null;
}

// E.164 country calling codes are prefix-free: these start with 1 or 2 digits, every other with 3.
const ONE_DIGIT_CODES = new Set(["1", "7"]);
const TWO_DIGIT_CODES = new Set(
  "20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98".split(" "),
);

function maskEmail(value: string): string {
  const at = value.lastIndexOf("@");
  if (at < 1 || at === value.length - 1) return "***";
  return `${value[0]}***@${value.slice(at + 1)}`;
}

function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (!value.trim().startsWith("+")) return digits.length >= 6 ? `*** *** ${digits.slice(-3)}` : "***";
  const code = ONE_DIGIT_CODES.has(digits.slice(0, 1))
    ? digits.slice(0, 1)
    : TWO_DIGIT_CODES.has(digits.slice(0, 2))
      ? digits.slice(0, 2)
      : digits.slice(0, 3);
  if (digits.length - code.length < 6) return "***";
  return `+${code} *** *** ${digits.slice(-3)}`;
}

/**
 * DIM-FR-21: the one masking rule for every studio response, whatever the viewer's role. An
 * email keeps its first character and its domain, a phone its country code and last three
 * digits, and any other PII value shows as `***`. A value too short to keep anything is `***`.
 */
export function maskPii(kind: PiiKind, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (kind === "email") return maskEmail(text);
  if (kind === "phone") return maskPhone(text);
  return "***";
}

/** A `pii_access_log` row, in the shape of its action (DIM-FR-22). */
export type PiiAccessRequest =
  | { action: "reveal"; route: string; customerKey: string; field: string }
  | { action: "rejects_download"; route: string; runId: string; fields: string[] }
  | { action: "deletion_request"; route: string; customerKeyHash: string };

export type PiiAccessEntry = PiiAccessRequest & { staffId: string };

export function piiAccessInsert(entry: PiiAccessEntry): SqlQuery {
  const columns = {
    customerKey: entry.action === "reveal" ? entry.customerKey : null,
    customerKeyHash: entry.action === "deletion_request" ? entry.customerKeyHash : null,
    runId: entry.action === "rejects_download" ? entry.runId : null,
    fields:
      entry.action === "reveal" ? [entry.field] : entry.action === "rejects_download" ? entry.fields : [],
  };
  return {
    text: `INSERT INTO pii_access_log (staff_id, action, route, customer_key, customer_key_hash, run_id, fields)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    values: [
      entry.staffId,
      entry.action,
      entry.route,
      columns.customerKey,
      columns.customerKeyHash,
      columns.runId,
      JSON.stringify(columns.fields),
    ],
  };
}

export const TOMBSTONE_KEY_ENV = "IMPORT_TOMBSTONE_KEY";
const MIN_TOMBSTONE_KEY_LENGTH = 32;

export type TombstoneKey = { configured: true; key: string } | { configured: false };

/** Reads the tombstone key. Unset or shorter than 32 characters, the Privacy page shows "not configured". */
export function readTombstoneKey(env: Record<string, string | undefined> = process.env): TombstoneKey {
  const key = env[TOMBSTONE_KEY_ENV];
  return key !== undefined && key.length >= MIN_TOMBSTONE_KEY_LENGTH ? { configured: true, key } : { configured: false };
}

/** DIM-FR-23: the tombstone of a customer key, HMAC-SHA-256 under the tombstone key in lowercase hex. The key is used byte for byte. */
export function tombstoneOf(key: { configured: true; key: string }, customerKey: string): string {
  return createHmac("sha256", key.key).update(customerKey, "utf8").digest("hex");
}
