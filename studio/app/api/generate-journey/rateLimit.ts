const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const DEFAULT_PER_MINUTE = 10;
const DEFAULT_PER_DAY = 100;
// Also caps the timestamps kept per user.
const MAX_LIMIT = 10_000;

export interface RateLimits {
  perMinute: number;
  perDay: number;
}

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface RateLimiter {
  // Records the request if it is allowed. A refused request is not recorded.
  take(userId: string, limits: RateLimits): RateLimitDecision;
  readonly trackedUsers: number;
}

type Env = Record<string, string | undefined>;

export function parseRateLimits(env: Env): RateLimits {
  return {
    perMinute: parseLimit(env, "AI_GENERATION_LIMIT_PER_MINUTE", DEFAULT_PER_MINUTE),
    perDay: parseLimit(env, "AI_GENERATION_LIMIT_PER_DAY", DEFAULT_PER_DAY),
  };
}

function parseLimit(env: Env, name: string, fallback: number): number {
  const value = env[name]?.trim();
  if (!value) return fallback;
  const limit = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(limit >= 1 && limit <= MAX_LIMIT)) {
    throw new Error(`${name} must be an integer from 1 to ${MAX_LIMIT}.`);
  }
  return limit;
}

// A sliding log: each user's request times over the last day, oldest first. A request is allowed
// when fewer than the limit fall in the last minute and in the last day.
export function createRateLimiter(now: () => number = () => Date.now()): RateLimiter {
  const requests = new Map<string, number[]>();

  // Drops users whose newest request is a day old, so the map holds only users active in the last day.
  function forgetIdleUsers(time: number) {
    for (const [userId, times] of requests) {
      if (times[times.length - 1] <= time - DAY_MS) requests.delete(userId);
    }
  }

  // Milliseconds until the window holds fewer than `limit` requests, or 0 if it already does.
  function waitFor(times: number[], limit: number, windowMs: number, time: number): number {
    return times.length < limit ? 0 : times[times.length - limit] + windowMs - time;
  }

  return {
    take(userId, limits) {
      const time = now();
      forgetIdleUsers(time);

      const day = (requests.get(userId) ?? []).filter((t) => t > time - DAY_MS);
      requests.set(userId, day);
      const minute = day.filter((t) => t > time - MINUTE_MS);
      const waitMs = Math.max(
        waitFor(minute, limits.perMinute, MINUTE_MS, time),
        waitFor(day, limits.perDay, DAY_MS, time),
      );
      if (waitMs > 0) {
        return { allowed: false, retryAfterSeconds: Math.ceil(waitMs / 1000) };
      }

      day.push(time);
      return { allowed: true };
    },
    get trackedUsers() {
      return requests.size;
    },
  };
}
