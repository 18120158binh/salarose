import type { Health } from "./health";
import type { HealthCheck } from "./tools";

export const HEALTH_REUSE_MS = 15_000;

interface Entry {
  startedAt: number;
  health: Promise<Health>;
}

// Reuses each tool's check, in flight or settled, for HEALTH_REUSE_MS after it started, so studio
// calls a tool at most once per window however many admins open the page (PCN-NFR-03). The map
// lives in one studio process.
export type HealthCache = ((toolId: string, healthCheck: HealthCheck) => Promise<Health>) & {
  // When the check now reused for a tool started, or null before its first check (PCN-FR-12).
  checkedAt: (toolId: string) => number | null;
};

export function createHealthCache(check: (check: HealthCheck) => Promise<Health>, now: () => number): HealthCache {
  const entries = new Map<string, Entry>();
  const health = (toolId: string, healthCheck: HealthCheck) => {
    const entry = entries.get(toolId);
    if (entry && now() - entry.startedAt < HEALTH_REUSE_MS) return entry.health;
    const result = check(healthCheck);
    entries.set(toolId, { startedAt: now(), health: result });
    return result;
  };
  return Object.assign(health, { checkedAt: (toolId: string) => entries.get(toolId)?.startedAt ?? null });
}
