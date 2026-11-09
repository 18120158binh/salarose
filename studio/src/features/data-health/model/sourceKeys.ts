import type { SqlQuery } from "@/lib/db";

export type SourceKeyStatus = { readonly kind: "active" } | { readonly kind: "revoked"; readonly at: number };

// DHL-FR-04: what the source keys view shows of a key. It has no field for the key or its hash.
export type SourceKeyRow = {
  readonly id: string;
  readonly appId: string;
  readonly hint: string;
  /** Null when the creator's staff user was deleted, or the key predates the column. */
  readonly createdBy: string | null;
  readonly createdAt: number;
  readonly status: SourceKeyStatus;
};

// The column list is spelled out so that key_hash can never reach studio's memory for this page.
// Active keys first, then by app id (DHL-FR-04).
export const SOURCE_KEYS_QUERY: SqlQuery = {
  text: `SELECT k.id, k.app_id, k.key_hint, u.email AS created_by_email, k.created_at, k.revoked_at
FROM ingestion_source_keys k LEFT JOIN system_users u ON u.id = k.created_by
ORDER BY k.revoked_at IS NOT NULL, k.app_id, k.created_at DESC, k.id`,
  values: [],
};

type Row = Record<string, unknown>;

function instant(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const ms = new Date(value as string | Date).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function parseSourceKeyRows(rows: readonly Row[]): SourceKeyRow[] {
  return rows.flatMap((row): SourceKeyRow[] => {
    const createdAt = instant(row.created_at);
    if (typeof row.id !== "string" || typeof row.app_id !== "string" || createdAt === null) {
      console.warn(`[data-health] Skipping source key row ${String(row.id)}: its id, app id, or creation time is not valid.`);
      return [];
    }
    const revokedAt = instant(row.revoked_at);
    return [
      {
        id: row.id,
        appId: row.app_id,
        hint: typeof row.key_hint === "string" ? row.key_hint : "",
        createdBy: typeof row.created_by_email === "string" && row.created_by_email !== "" ? row.created_by_email : null,
        createdAt,
        status: revokedAt === null ? { kind: "active" } : { kind: "revoked", at: revokedAt },
      },
    ];
  });
}
