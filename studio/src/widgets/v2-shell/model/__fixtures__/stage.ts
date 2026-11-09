import { CREATE_TARGETS, type CreateId } from "../palette";
import { JOURNEY_ANALYTICS, NAV, SEGMENT_EDITOR, type NavId, type Stage } from "../routes";

export type Staged = NavId | CreateId | "journey-analytics" | "segment-editor";

/** Runs a test with the pages and create targets at the stage, then puts the tables back. */
export async function withStage<T>(ids: readonly Staged[], stage: Stage, test: () => T | Promise<T>): Promise<T> {
  const entries: { stage: Stage }[] = [
    ...NAV.filter((entry) => ids.includes(entry.id)),
    ...CREATE_TARGETS.filter((target) => ids.includes(target.id)),
  ];
  if (ids.includes("journey-analytics")) entries.push(JOURNEY_ANALYTICS);
  if (ids.includes("segment-editor")) entries.push(SEGMENT_EDITOR);
  const before = entries.map((entry) => entry.stage);
  for (const entry of entries) entry.stage = stage;
  try {
    return await test();
  } finally {
    entries.forEach((entry, index) => (entry.stage = before[index]));
  }
}
