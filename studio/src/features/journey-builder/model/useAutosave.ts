"use client";

import { useEffect, useRef, type Dispatch } from "react";
import type { DraftSave } from "@/features/journeys/model/draftInput";
import type { SaveResult } from "@/features/journeys/model/drafts";
import { graphFromRoot, rootOfGraph, type BuilderAction, type BuilderState } from "./builder";

/** The draft save action, as the builder calls it. */
export type SaveDraft = (input: DraftSave) => Promise<SaveResult | { error: string }>;

/** JBD-FR-26 asks for the draft on the server within 2 seconds of the last edit. */
export const AUTOSAVE_DELAY_MS = 1000;

// A rolling restart removes the server action the open page calls, and Next.js rejects the call.
function isMissingAction(error: unknown): boolean {
  return error instanceof Error && /server action/i.test(error.message);
}

/**
 * Saves the draft one second after the last edit, one save at a time. A conflict or a stale
 * deployment stops autosave until the marketer acts. A failed save waits for the next edit or Retry.
 */
export function useAutosave(state: BuilderState, dispatch: Dispatch<BuilderAction>, save: SaveDraft): void {
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  });
  const inFlight = useRef(false);

  const { revision, savedRevision, save: status } = state;

  useEffect(() => {
    if (revision === savedRevision || inFlight.current) return;
    if (status.kind === "conflict" || status.kind === "stale") return;
    if (status.kind === "failed" && status.revision === revision) return;

    const timer = setTimeout(async () => {
      const sent = latest.current;
      inFlight.current = true;
      dispatch({ type: "saveStarted" });
      try {
        const result = await save({
          id: sent.id,
          version: sent.version,
          name: sent.name,
          description: sent.description,
          root: rootOfGraph(sent.graph),
        });
        if ("error" in result || result.status === "missing") {
          dispatch({ type: "saveFailed", revision: sent.revision });
        } else if (result.status === "conflict") {
          const graph = graphFromRoot(result.draft.root);
          if (graph === null) dispatch({ type: "saveFailed", revision: sent.revision });
          else
            dispatch({
              type: "saveConflict",
              stored: { name: result.draft.name, version: result.draft.version, graph, savedAt: Date.parse(result.draft.updatedAt) },
            });
        } else {
          dispatch({ type: "saved", revision: sent.revision, version: result.version, at: Date.now() });
        }
      } catch (error) {
        dispatch(isMissingAction(error) ? { type: "saveStale" } : { type: "saveFailed", revision: sent.revision });
      } finally {
        inFlight.current = false;
      }
    }, AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [revision, savedRevision, status, dispatch, save]);
}
