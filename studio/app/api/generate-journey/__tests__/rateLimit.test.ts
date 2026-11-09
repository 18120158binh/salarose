/**
 * @jest-environment node
 */
import { createRateLimiter, parseRateLimits } from "../rateLimit";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

const limits = { perMinute: 10, perDay: 100 };

// A limiter whose clock the test moves.
function limiterAt(start: number) {
  let time = start;
  const limiter = createRateLimiter(() => time);
  return {
    limiter,
    take: (userId: string) => limiter.take(userId, limits),
    at: (ms: number) => {
      time = start + ms;
    },
  };
}

// Takes one request at each offset and returns what the limiter answered.
function takeAt(clock: ReturnType<typeof limiterAt>, userId: string, offsets: number[]) {
  return offsets.map((ms) => {
    clock.at(ms);
    return clock.take(userId);
  });
}

const start = Date.UTC(2026, 9, 18, 9, 0, 0);

describe("createRateLimiter", () => {
  it("allows 10 requests in a minute and refuses the 11th until the oldest is a minute old", () => {
    const clock = limiterAt(start);

    const answers = takeAt(clock, "u1", [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((s) => s * SECOND));
    clock.at(10 * SECOND);
    const eleventh = clock.take("u1");

    expect(answers).toEqual(Array(10).fill({ allowed: true }));
    expect(eleventh).toEqual({ allowed: false, retryAfterSeconds: 50 });
  });

  it("allows a request again once the window has passed", () => {
    const clock = limiterAt(start);
    takeAt(clock, "u1", Array(10).fill(0));

    clock.at(MINUTE - 1);
    const justBefore = clock.take("u1");
    clock.at(MINUTE);
    const atReset = clock.take("u1");

    expect(justBefore).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(atReset).toEqual({ allowed: true });
  });

  it("does not count a refused request", () => {
    const clock = limiterAt(start);
    takeAt(clock, "u1", Array(10).fill(0));
    takeAt(clock, "u1", [30 * SECOND, 40 * SECOND, 50 * SECOND]);

    clock.at(MINUTE);

    expect(clock.take("u1")).toEqual({ allowed: true });
  });

  it("allows 100 requests in a day and refuses the 101st until the oldest is a day old", () => {
    const clock = limiterAt(start);
    const oneAMinute = Array.from({ length: 100 }, (_, i) => i * MINUTE);

    const answers = takeAt(clock, "u1", oneAMinute);
    clock.at(100 * MINUTE);
    const hundredAndFirst = clock.take("u1");
    clock.at(DAY);
    const nextDay = clock.take("u1");

    expect(answers.every((answer) => answer.allowed)).toBe(true);
    expect(hundredAndFirst).toEqual({ allowed: false, retryAfterSeconds: (DAY - 100 * MINUTE) / SECOND });
    expect(nextDay).toEqual({ allowed: true });
  });

  it("gives the longer wait when both limits are reached", () => {
    const clock = limiterAt(start);
    takeAt(clock, "u1", Array.from({ length: 90 }, (_, i) => i * MINUTE));
    takeAt(clock, "u1", Array(10).fill(90 * MINUTE));

    clock.at(90 * MINUTE + 30 * SECOND);

    expect(clock.take("u1")).toEqual({ allowed: false, retryAfterSeconds: (DAY - 90 * MINUTE - 30 * SECOND) / SECOND });
  });

  it("counts each user separately", () => {
    const clock = limiterAt(start);
    takeAt(clock, "u1", Array(10).fill(0));

    expect(clock.take("u1")).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(clock.take("u2")).toEqual({ allowed: true });
  });

  it("applies the limits it is given", () => {
    const clock = limiterAt(start);
    const tight = { perMinute: 2, perDay: 3 };

    const answers = [0, 0, 0].map(() => clock.limiter.take("u1", tight));
    clock.at(MINUTE);
    const nextMinute = [clock.limiter.take("u1", tight), clock.limiter.take("u1", tight)];

    expect(answers).toEqual([{ allowed: true }, { allowed: true }, { allowed: false, retryAfterSeconds: 60 }]);
    expect(nextMinute).toEqual([{ allowed: true }, { allowed: false, retryAfterSeconds: DAY / SECOND - 60 }]);
  });

  it("forgets a user a day after their last request", () => {
    const clock = limiterAt(start);
    clock.take("u1");
    clock.take("u2");
    clock.at(DAY - 1);
    clock.take("u2");

    clock.at(DAY);
    clock.take("u3");

    expect(clock.limiter.trackedUsers).toBe(2);
  });
});

describe("parseRateLimits", () => {
  it("defaults to 10 a minute and 100 a day", () => {
    expect(parseRateLimits({})).toEqual({ perMinute: 10, perDay: 100 });
    expect(parseRateLimits({ AI_GENERATION_LIMIT_PER_MINUTE: " ", AI_GENERATION_LIMIT_PER_DAY: "" }))
      .toEqual({ perMinute: 10, perDay: 100 });
  });

  it("reads both limits from the environment", () => {
    expect(parseRateLimits({ AI_GENERATION_LIMIT_PER_MINUTE: "3", AI_GENERATION_LIMIT_PER_DAY: "40" }))
      .toEqual({ perMinute: 3, perDay: 40 });
  });

  it.each(["0", "-1", "1.5", "ten", "10001", "1e3"])("rejects %p", (value) => {
    expect(() => parseRateLimits({ AI_GENERATION_LIMIT_PER_MINUTE: value }))
      .toThrow("AI_GENERATION_LIMIT_PER_MINUTE must be an integer from 1 to 10000.");
    expect(() => parseRateLimits({ AI_GENERATION_LIMIT_PER_DAY: value }))
      .toThrow("AI_GENERATION_LIMIT_PER_DAY must be an integer from 1 to 10000.");
  });
});
