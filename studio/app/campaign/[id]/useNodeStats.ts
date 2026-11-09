import { useEffect, useState } from "react";

export type NodeStatsResult = { stats: Record<string, number> } | { error: string };

export const STATS_REFRESH_MS = 5000;

/**
 * The users on each node of a campaign, refreshed every 5 seconds while the tab is visible. The
 * next refresh is scheduled only after the last one settles, so requests never overlap. A failed
 * refresh keeps the last counts and sets `failed`.
 */
export function useNodeStats(
  campaignId: string | null,
  load: (campaignId: string) => Promise<NodeStatsResult>,
): { stats: Record<string, number>; failed: boolean } {
  const [stats, setStats] = useState<Record<string, number>>({});
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!campaignId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      timer = setTimeout(refresh, STATS_REFRESH_MS);
    };
    const refresh = async () => {
      if (document.hidden) {
        schedule();
        return;
      }
      let result: NodeStatsResult;
      try {
        result = await load(campaignId);
      } catch (error) {
        console.error("Failed to refresh node counts:", error);
        result = { error: "Node counts could not load." };
      }
      if (stopped) return;
      if ("stats" in result) {
        setStats(result.stats);
        setFailed(false);
      } else {
        setFailed(true);
      }
      schedule();
    };

    void refresh();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [campaignId, load]);

  return { stats, failed };
}
