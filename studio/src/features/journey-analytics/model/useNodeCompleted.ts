"use client";

import { useEffect, useState } from "react";
import type { NodeCompletedRefresh } from "./actions";

export const REFRESH_MS = 5000;

export type NodeCompletedState = {
  readonly completed: Readonly<Record<string, number>>;
  /** Epoch ms of the counts shown. */
  readonly readAt: number;
  /** True when the last refresh failed, so the counts shown are older than one interval. */
  readonly stale: boolean;
  /** Epoch ms of the last refresh attempt, to tell the counts' age against. */
  readonly now: number;
};

// JBD-FR-09: refresh every 5 seconds. The next refresh is scheduled only once the last one has
// finished, so two never overlap. While the browser tab is hidden the refresh is skipped, and
// when one fails the last counts stay.
export function useNodeCompleted(
  initial: { completed: Readonly<Record<string, number>>; readAt: number },
  refresh: () => Promise<NodeCompletedRefresh>,
): NodeCompletedState {
  const [state, setState] = useState<NodeCompletedState>({ ...initial, stale: false, now: initial.readAt });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(tick, REFRESH_MS);
    };
    const tick = async () => {
      if (document.visibilityState === "hidden") return schedule();
      let result: NodeCompletedRefresh;
      try {
        result = await refresh();
      } catch {
        result = { error: "Counts could not refresh." };
      }
      if (cancelled) return;
      const now = Date.now();
      setState((last) => ("error" in result ? { ...last, stale: true, now } : { completed: result.completed, readAt: result.readAt, stale: false, now }));
      schedule();
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [refresh]);

  return state;
}
