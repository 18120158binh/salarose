import "server-only";
import { inTransaction, type RunQuery, type TransactionClient } from "@/lib/db";
import { assertSession, AuthorizationError } from "@/shared/auth/session";
import { toCheckedAdmin, type CheckedAdmin } from "@/shared/auth/types";
import { piiAccessInsert, readTombstoneKey, tombstoneOf, type PiiAccessRequest } from "./privacy";

// DIM-FR-25: every data import route and server action checks the session itself first: assertSession
// for a staff read, assertDataImportAdmin for an admin action.

/** An admin, as the CheckedAdmin type that the admin-only helpers below require. */
export async function assertDataImportAdmin(): Promise<CheckedAdmin> {
  const admin = toCheckedAdmin(await assertSession());
  if (!admin) throw new AuthorizationError("Only admin users can do this.");
  return admin;
}

/** Runs queries on one transaction's connection. */
export function runOn(client: TransactionClient): RunQuery {
  return async (query) => (await client.query(query.text, query.values)).rows;
}

/**
 * DIM-FR-22: writes the access log row. Call it in the transaction that reads the clear value,
 * before returning that value. Only an admin can reach it.
 */
export async function logPiiAccess(
  admin: CheckedAdmin,
  run: RunQuery,
  entry: PiiAccessRequest,
): Promise<void> {
  await run(piiAccessInsert({ ...entry, staffId: admin.userId }));
}

export type DeletionRequest = { status: "requested"; tombstone: string } | { status: "not_configured" };

/**
 * DIM-FR-23: stores the key's tombstone at `requested` and writes the `deletion_request` row, in
 * one transaction. Neither row holds the key. A repeated request for one key keeps the first row.
 */
export async function requestPersonDeletion(admin: CheckedAdmin, customerKey: string, route: string): Promise<DeletionRequest> {
  const key = readTombstoneKey();
  if (!key.configured) return { status: "not_configured" };
  const tombstone = tombstoneOf(key, customerKey);
  await inTransaction(async (client) => {
    const run = runOn(client);
    await run({
      text: `INSERT INTO person_tombstones (customer_key_hash, requested_by, state) VALUES ($1, $2, 'requested')
             ON CONFLICT (customer_key_hash) DO NOTHING`,
      values: [tombstone, admin.userId],
    });
    await logPiiAccess(admin, run, { action: "deletion_request", route, customerKeyHash: tombstone });
  });
  return { status: "requested", tombstone };
}
