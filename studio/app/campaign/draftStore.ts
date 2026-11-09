import type { Campaign, SetupNode } from "@/entities/journey/model/types";
import { newCampaignId } from "@/entities/journey/model/campaignId";

// Drafts live in the browser, one list per signed-in user, so that users who share a browser
// do not see or activate each other's drafts. Drafts saved under the one key that every user
// shared before are not read, because nothing records who wrote them. They stay in storage.
const DRAFTS_KEY_PREFIX = "auroracy_campaigns:";

function draftsKey(userId: string): string {
  return `${DRAFTS_KEY_PREFIX}${userId}`;
}

// A stored entry is read back as a draft only when it has the fields the list and the builder
// use. The journey itself is not checked: a draft may be half drawn, and publish parses it.
function parseDraft(value: unknown): Campaign | null {
  if (typeof value !== "object" || value === null) return null;
  const fields = value as Record<string, unknown>;
  const { id, name, description, status, root, created_at, updated_at } = fields;
  if (typeof id !== "string" || id === "" || typeof name !== "string" || status !== "draft") return null;
  if (typeof root !== "object" || root === null || (root as Record<string, unknown>).type !== "setup") return null;
  if (typeof created_at !== "string" || typeof updated_at !== "string") return null;
  return {
    id,
    name,
    description: typeof description === "string" ? description : "",
    status,
    root: root as SetupNode,
    created_at,
    updated_at,
  };
}

export function loadDrafts(userId: string): Campaign[] {
  const stored = localStorage.getItem(draftsKey(userId));
  if (!stored) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch (error) {
    console.error("Ignoring drafts in browser storage that are not JSON", error);
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    const draft = parseDraft(entry);
    if (!draft) console.warn("Ignoring a stored draft that does not parse", entry);
    return draft ? [draft] : [];
  });
}

export function saveDrafts(userId: string, drafts: Campaign[]): void {
  localStorage.setItem(draftsKey(userId), JSON.stringify(drafts.filter((c) => c.status === "draft")));
}

// Copies a campaign into a new draft of the user, with a new id, and stores it.
export function cloneAsDraft(userId: string, orig: Campaign): Campaign {
  const now = new Date().toISOString();
  const clone: Campaign = {
    id: newCampaignId(),
    name: `Copy of ${orig.name}`,
    description: orig.description,
    status: "draft",
    root: JSON.parse(JSON.stringify(orig.root)),
    created_at: now,
    updated_at: now,
  };
  saveDrafts(userId, [...loadDrafts(userId), clone]);
  return clone;
}
