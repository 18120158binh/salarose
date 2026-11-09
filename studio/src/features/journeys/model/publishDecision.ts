// JBD-FR-27: publish decides from what it finds, so a retry converges and a clash with another
// publisher writes nothing. These are the facts it reads inside its transaction, after it locked
// the draft row.
export interface PublishFacts {
  /** The campaign id of a journey_publishes row that names this draft under another campaign id. */
  publishedAs: string | null;
  /** The caller's draft with this id, or null when there is none. */
  draft: { version: number; rootHash: string } | null;
  /** Whether a campaign has the draft's id. */
  campaignExists: boolean;
  /** The root hash of a journey_publishes row that names this draft under its own id. */
  ownPublishHash: string | null;
}

export type PublishMode = "same_id" | "new_id";

export type PublishOutcome =
  | { kind: "publish" }
  | { kind: "already_published"; campaignId: string; deleteDraft: boolean }
  | { kind: "collision" }
  | { kind: "draft_missing" }
  | { kind: "stale"; storedVersion: number };

// The retry and collision table of the journey builder contract's Publish section. The version
// check runs before the table, and a publish as a new journey skips the collision rows, because
// a fresh id meets no campaign.
export function decidePublish(draftId: string, facts: PublishFacts, seenVersion: number, mode: PublishMode): PublishOutcome {
  const { publishedAs, draft, campaignExists, ownPublishHash } = facts;
  if (publishedAs !== null) return { kind: "already_published", campaignId: publishedAs, deleteDraft: false };
  if (draft !== null && draft.version !== seenVersion) return { kind: "stale", storedVersion: draft.version };

  const publishedHere = campaignExists && ownPublishHash !== null;
  if (draft === null) {
    return publishedHere ? { kind: "already_published", campaignId: draftId, deleteDraft: false } : { kind: "draft_missing" };
  }
  if (mode === "new_id" || !campaignExists) return { kind: "publish" };
  if (ownPublishHash === draft.rootHash) return { kind: "already_published", campaignId: draftId, deleteDraft: true };
  return { kind: "collision" };
}
