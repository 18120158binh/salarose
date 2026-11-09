import { UserFacingError } from "shared/lib/userFacingError";
import type { PublishMode } from "./publishDecision";

// The browser sends these to the draft actions. Each parser refuses a malformed value with a
// message for the staff user, and the code past them trusts the types.

/** Where a draft came from, as journey_drafts.origin stores it. */
export type DraftOrigin = "blank" | "ai" | "browser" | `template:${string}` | `duplicate:${string}`;

/** The origins a marketer starts a draft with. Duplicate and the browser move write their own. */
export type CreatedOrigin = "blank" | "ai" | `template:${string}`;

export interface DraftContent {
  name: string;
  description: string;
  /** The journey in the saved format. A draft may be unfinished, so publish checks it, not save. */
  root: Record<string, unknown>;
}

export interface NewDraft extends DraftContent {
  origin: CreatedOrigin;
}

export interface DraftSave extends DraftContent {
  id: string;
  /** The version the builder last read. */
  version: number;
}

export interface PublishRequest {
  draftId: string;
  version: number;
  mode: PublishMode;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new UserFacingError(`${what} must be an object.`);
  return value as Record<string, unknown>;
}

export function parseDraftId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new UserFacingError("The draft id is not valid.");
  }
  return value;
}

export function parseJourneyId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) {
    throw new UserFacingError("The journey id is not valid.");
  }
  return value;
}

function parseVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new UserFacingError("The draft version is not valid.");
  return value;
}

function parseContent(fields: Record<string, unknown>): DraftContent {
  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  if (name === "") throw new UserFacingError("Give the journey a name.");
  const description = fields.description ?? "";
  if (typeof description !== "string") throw new UserFacingError("The description must be text.");
  return { name, description, root: record(fields.root, "The journey") };
}

function parseCreatedOrigin(value: unknown): CreatedOrigin {
  if (value === "blank" || value === "ai") return value;
  if (typeof value === "string" && /^template:\S+$/.test(value)) return value as `template:${string}`;
  throw new UserFacingError("A new draft starts blank, from a template, or from a description.");
}

export function parseNewDraft(value: unknown): NewDraft {
  const fields = record(value, "The draft");
  return { ...parseContent(fields), origin: parseCreatedOrigin(fields.origin) };
}

export function parseDraftSave(value: unknown): DraftSave {
  const fields = record(value, "The draft");
  return { ...parseContent(fields), id: parseDraftId(fields.id), version: parseVersion(fields.version) };
}

export function parsePublishRequest(value: unknown): PublishRequest {
  const fields = record(value, "The publish request");
  if (fields.asNewJourney !== undefined && typeof fields.asNewJourney !== "boolean") {
    throw new UserFacingError("The publish request is not valid.");
  }
  return {
    draftId: parseDraftId(fields.draftId),
    version: parseVersion(fields.version),
    mode: fields.asNewJourney === true ? "new_id" : "same_id",
  };
}
