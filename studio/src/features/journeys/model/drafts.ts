import "server-only";
import { inTransaction, writePublishedGraph, type TransactionClient } from "@/lib/db";
import { newCampaignId } from "@/entities/journey/model/campaignId";
import { validateJourney, type JourneyProblem } from "@/entities/journey/model/parseCampaign";
import { RUNTIME_REGISTRY } from "@/entities/journey/model/registry";
import { flattenCampaignTree } from "@/entities/journey/model/utils";
import type { DraftOrigin, DraftSave, NewDraft, PublishRequest } from "./draftInput";
import { decidePublish, type PublishFacts } from "./publishDecision";

// Drafts on the server (JBD-NFR-02, decision 0036). Every function takes the caller's id, and a
// draft is visible to its owner only: another user's draft reads as no draft.

export interface DraftSummary {
  id: string;
  name: string;
  description: string;
  origin: DraftOrigin;
  version: number;
  updatedAt: string;
}

export interface StoredDraft extends DraftSummary {
  root: Record<string, unknown>;
}

export type SaveResult =
  | { status: "saved"; version: number }
  | { status: "conflict"; draft: StoredDraft }
  | { status: "missing" };

export type PublishResult =
  | { status: "published"; campaignId: string }
  | { status: "already_published"; campaignId: string }
  | { status: "collision" }
  | { status: "draft_missing" }
  | { status: "stale"; version: number }
  | { status: "invalid"; problems: JourneyProblem[] };

// The SHA-256 of a jsonb value's text form. jsonb prints one canonical text for equal values, so a
// draft's root and the campaign root copied from it hash alike.
const ROOT_HASH = (column: string) => `encode(sha256(convert_to(${column}::text, 'UTF8')), 'hex')`;

const SUMMARY_COLUMNS = "id, name, description, origin, version, updated_at";

function summary(row: Record<string, unknown>): DraftSummary {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description),
    origin: row.origin as DraftOrigin,
    version: Number(row.version),
    updatedAt: new Date(row.updated_at as string | Date).toISOString(),
  };
}

function storedDraft(row: Record<string, unknown>): StoredDraft {
  return { ...summary(row), root: row.root as Record<string, unknown> };
}

async function readDraft(client: TransactionClient, ownerId: string, id: string): Promise<StoredDraft | null> {
  const result = await client.query(
    `SELECT ${SUMMARY_COLUMNS}, root FROM journey_drafts WHERE id = $1 AND owner_id = $2`,
    [id, ownerId],
  );
  return result.rows.length === 0 ? null : storedDraft(result.rows[0]);
}

export async function getMyDraft(ownerId: string, id: string): Promise<StoredDraft | null> {
  return inTransaction((client) => readDraft(client, ownerId, id));
}

export async function listMyDrafts(ownerId: string): Promise<DraftSummary[]> {
  return inTransaction(async (client) => {
    const result = await client.query(
      `SELECT ${SUMMARY_COLUMNS} FROM journey_drafts WHERE owner_id = $1 ORDER BY updated_at DESC, id`,
      [ownerId],
    );
    return result.rows.map(summary);
  });
}

// A new draft takes a fresh campaign id, which it keeps until publish (decision 0036).
export async function createDraft(ownerId: string, draft: NewDraft): Promise<{ id: string; version: number }> {
  return inTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO journey_drafts (id, owner_id, name, description, root, origin)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, version`,
      [newCampaignId(), ownerId, draft.name, draft.description, JSON.stringify(draft.root), draft.origin],
    );
    return { id: String(result.rows[0].id), version: Number(result.rows[0].version) };
  });
}

// JBD-FR-26: a save names the version it read and raises it by one. A save against another
// version is refused with the stored draft, so the builder can offer Load latest and Keep mine.
export async function saveDraft(ownerId: string, save: DraftSave): Promise<SaveResult> {
  return inTransaction(async (client) => {
    const updated = await client.query(
      `UPDATE journey_drafts SET name = $4, description = $5, root = $6, version = version + 1, updated_at = NOW()
       WHERE id = $1 AND owner_id = $2 AND version = $3 RETURNING version`,
      [save.id, ownerId, save.version, save.name, save.description, JSON.stringify(save.root)],
    );
    if (updated.rows.length === 1) return { status: "saved", version: Number(updated.rows[0].version) };
    const stored = await readDraft(client, ownerId, save.id);
    return stored === null ? { status: "missing" } : { status: "conflict", draft: stored };
  });
}

// CMP-FR-09: any staff user may copy a published campaign's stored tree into a draft of their own.
// Null when the id names no active or paused campaign.
export async function duplicateCampaign(ownerId: string, campaignId: string): Promise<{ id: string; version: number } | null> {
  return inTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO journey_drafts (id, owner_id, name, description, root, origin)
       SELECT $1, $2, 'Copy of ' || name, COALESCE(description, ''), root, 'duplicate:' || id
       FROM campaigns WHERE id = $3 AND status IN ('active', 'paused') AND root IS NOT NULL
       RETURNING id, version`,
      [newCampaignId(), ownerId, campaignId],
    );
    return result.rows.length === 0 ? null : { id: String(result.rows[0].id), version: Number(result.rows[0].version) };
  });
}

// Deleting is final, and deleting a draft that is already gone converges on the same state.
export async function deleteDraft(ownerId: string, id: string): Promise<void> {
  await inTransaction((client) => client.query("DELETE FROM journey_drafts WHERE id = $1 AND owner_id = $2", [id, ownerId]));
}

async function readPublishFacts(client: TransactionClient, ownerId: string, draftId: string): Promise<PublishFacts> {
  // The lock makes a second publish of this draft wait, then find it gone and the publish row.
  const draft = await client.query(
    `SELECT version, ${ROOT_HASH("root")} AS root_hash FROM journey_drafts WHERE id = $1 AND owner_id = $2 FOR UPDATE`,
    [draftId, ownerId],
  );
  const found = await client.query(
    `SELECT
       (SELECT campaign_id FROM journey_publishes WHERE draft_id = $1 AND campaign_id <> $1) AS published_as,
       EXISTS (SELECT 1 FROM campaigns WHERE id = $1) AS campaign_exists,
       (SELECT root_hash FROM journey_publishes WHERE campaign_id = $1 AND draft_id = $1) AS own_publish_hash`,
    [draftId],
  );
  const row = found.rows[0];
  return {
    publishedAs: row.published_as == null ? null : String(row.published_as),
    draft: draft.rows.length === 0 ? null : { version: Number(draft.rows[0].version), rootHash: String(draft.rows[0].root_hash) },
    campaignExists: row.campaign_exists === true,
    ownPublishHash: row.own_publish_hash == null ? null : String(row.own_publish_hash),
  };
}

class Refused extends Error {
  constructor(readonly result: PublishResult) {
    super(result.status);
  }
}

// A campaign of that id committed by another publisher after the facts were read.
function isCampaignIdTaken(error: unknown): boolean {
  const pgError = error as { code?: unknown; constraint?: unknown };
  return pgError.code === "23505" && pgError.constraint === "campaigns_pkey";
}

// CMP-FR-01 and JBD-FR-27: one transaction writes the campaign from the stored draft, its node
// rows and metric definitions, and the journey_publishes row, and deletes the draft. The campaign
// takes the draft's root as stored, and the node rows come from that root, never from the browser.
async function publishStoredDraft(client: TransactionClient, draftId: string, campaignId: string): Promise<void> {
  const stored = await client.query("SELECT root FROM journey_drafts WHERE id = $1", [draftId]);
  const { root, problems } = validateJourney(stored.rows[0].root, RUNTIME_REGISTRY);
  const blocking = problems.filter((problem) => problem.severity === "blocking");
  if (root === undefined || blocking.length > 0) throw new Refused({ status: "invalid", problems: blocking });

  await client.query(
    `INSERT INTO campaigns (id, name, description, status, root, created_user, updated_at)
     SELECT $2, name, description, 'active', root, owner_id, NOW() FROM journey_drafts WHERE id = $1`,
    [draftId, campaignId],
  );
  await writePublishedGraph(client, campaignId, flattenCampaignTree(campaignId, root));
  await client.query(
    `INSERT INTO journey_publishes (campaign_id, draft_id, root_hash)
     SELECT id, $2, ${ROOT_HASH("root")} FROM campaigns WHERE id = $1`,
    [campaignId, draftId],
  );
  await client.query("DELETE FROM journey_drafts WHERE id = $1", [draftId]);
}

export async function publishDraft(ownerId: string, request: PublishRequest): Promise<PublishResult> {
  try {
    return await inTransaction(async (client): Promise<PublishResult> => {
      const { draftId } = request;
      const outcome = decidePublish(draftId, await readPublishFacts(client, ownerId, draftId), request.version, request.mode);
      switch (outcome.kind) {
        case "publish": {
          const campaignId = request.mode === "new_id" ? newCampaignId() : draftId;
          await publishStoredDraft(client, draftId, campaignId);
          return { status: "published", campaignId };
        }
        case "already_published":
          if (outcome.deleteDraft) await client.query("DELETE FROM journey_drafts WHERE id = $1", [draftId]);
          return { status: "already_published", campaignId: outcome.campaignId };
        case "stale":
          return { status: "stale", version: outcome.storedVersion };
        case "collision":
        case "draft_missing":
          return { status: outcome.kind };
      }
    });
  } catch (error) {
    if (error instanceof Refused) return error.result;
    if (isCampaignIdTaken(error)) return { status: "collision" };
    throw error;
  }
}
