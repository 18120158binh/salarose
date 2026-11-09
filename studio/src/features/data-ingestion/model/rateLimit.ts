const SECOND_MS = 1000;
const DEFAULT_PER_SECOND = 100;
const MAX_PER_SECOND = 100_000;

export type KeyRateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface KeyRateLimiter {
  // Records the request if it is allowed. A refused request is not recorded.
  take(key: string, perSecond: number): KeyRateDecision;
}

// DIA-NFR-02. An invalid value throws, and the route answers 503.
export function parseRequestsPerSecond(env: Record<string, string | undefined>): number {
  const value = env.INGESTION_RATE_LIMIT_PER_SECOND?.trim();
  if (!value) return DEFAULT_PER_SECOND;
  const limit = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(limit >= 1 && limit <= MAX_PER_SECOND)) {
    throw new Error(`INGESTION_RATE_LIMIT_PER_SECOND must be an integer from 1 to ${MAX_PER_SECOND}.`);
  }
  return limit;
}

// A sliding one-second log per key.
export function createKeyRateLimiter(now: () => number = () => Date.now()): KeyRateLimiter {
  const requests = new Map<string, number[]>();
  return {
    take(key, perSecond) {
      const time = now();
      for (const [other, times] of requests) {
        if (times[times.length - 1] <= time - SECOND_MS) requests.delete(other);
      }
      const recent = (requests.get(key) ?? []).filter((t) => t > time - SECOND_MS);
      requests.set(key, recent);
      if (recent.length >= perSecond) {
        const waitMs = recent[recent.length - perSecond] + SECOND_MS - time;
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / SECOND_MS)) };
      }
      recent.push(time);
      return { allowed: true };
    },
  };
}
