/**
 * @jest-environment node
 */
import { getSession } from "@/shared/auth/session";
import { POST } from "../route";

jest.mock("@/shared/auth/session", () => ({ getSession: jest.fn() }));

const groups = (...conditions: unknown[]) => ({ groups: conditions.map((condition) => ({ conditions: [condition] })) });
const profile = (field: string, value: unknown) => ({ type: "profile_property", field, op: "=", value });
const eventProperty = (field: string, op: string, value: unknown) => ({ type: "event_property", field, op, value });

// "Send a push to women in Hanoi who view a product but don't buy within a day."
const journey = {
  type: "setup",
  id: "setup-ai",
  label: "Start",
  description: "Women in Hanoi who view a product",
  triggerEventName: "view_item",
  conditions: groups(profile("gender", "female"), profile("city", "Hanoi")),
  next: {
    type: "watch",
    id: "watch-1",
    label: "Wait 1 day",
    eventName: "purchase",
    timeLimitValue: 1,
    timeLimitUnit: "days",
    next: {
      type: "TimeoutPath",
      timeout: {
        type: "engagement",
        id: "push-1",
        label: "Reminder",
        action: { type: "push", title: "Still thinking?", body: "Your product is waiting" },
        next: { type: "end" },
      },
    },
  },
};

// The journey with one change, made at the dotted path.
function journeyWith(path: string, value: unknown): unknown {
  const copy = structuredClone(journey) as Record<string, unknown>;
  const keys = path.split(".");
  const last = keys.pop() as string;
  const parent = keys.reduce((node, key) => node[key] as Record<string, unknown>, copy);
  parent[last] = value;
  return copy;
}

const fetchMock = jest.fn<Promise<Response>, [string, RequestInit]>();

function modelReplies(content: string) {
  fetchMock.mockImplementation(async () => Response.json({ choices: [{ message: { content } }] }));
}

async function generate(body: unknown) {
  const response = await POST(
    new Request("http://studio.test/api/generate-journey", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
  return { status: response.status, retryAfter: response.headers.get("Retry-After"), body: await response.json() };
}

function signInAs(userId: string) {
  jest.mocked(getSession).mockResolvedValue({ userId, email: `${userId}@example.com`, role: "editor" } as never);
}

// The rate limit lives for the whole test file, so each test signs in as a user of its own.
let testNumber = 0;

beforeEach(() => {
  signInAs(`editor-${++testNumber}`);
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  process.env.OPENAI_API_KEY = "test-key";
  process.env.OPENAI_API_BASE = "https://model.test/v1";
  process.env.LLM_MODEL = "test-model";
  delete process.env.AI_GENERATION_LIMIT_PER_MINUTE;
  delete process.env.AI_GENERATION_LIMIT_PER_DAY;
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("POST /api/generate-journey", () => {
  it("returns 401 without a session and does not call the model", async () => {
    jest.mocked(getSession).mockResolvedValue(null);

    const { status } = await generate({ prompt: "send a push" });

    expect(status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a valid generated journey", async () => {
    modelReplies(JSON.stringify(journey));

    const { status, body } = await generate({ prompt: "send a push to women in Hanoi who view a product" });

    expect(status).toBe(200);
    expect(body).toMatchObject({ type: "setup", id: "setup-ai", conditions: journey.conditions });
  });

  it("accepts event conditions on page and product fields", async () => {
    modelReplies(JSON.stringify(journeyWith("filters", groups(
      eventProperty("page.url", "LIKE", "%/sale/%"),
      eventProperty("product.name", "=", "Phone"),
    ))));

    const { status } = await generate({ prompt: "send a push to people who view a phone on sale" });

    expect(status).toBe(200);
  });

  it("accepts a journey wrapped in a Markdown code fence", async () => {
    modelReplies("```json\n" + JSON.stringify(journey) + "\n```");

    const { status, body } = await generate({ prompt: "send a push" });

    expect(status).toBe(200);
    expect(body.type).toBe("setup");
  });

  describe("rejects a reply that is not a valid journey", () => {
    it.each([
      ["a root that is not a setup node", { ...journey, type: "check" }],
      ["a second node of an unknown type", journeyWith("next.type", "sleep")],
      ["a missing branch", journeyWith("next.next", { type: "SuccessOrTimeoutPath", timeout: { type: "end" } })],
      ["an unknown path type", journeyWith("next.next.type", "MaybePath")],
      ["a time limit that is not a number", journeyWith("next.timeLimitValue", "1")],
      ["an unsupported channel", journeyWith("next.next.timeout.action.type", "telegram")],
      ["a check with no trigger event", journeyWith("next", {
        type: "check", id: "check-1", label: "Is VIP?", next: { type: "YesPath", yes: { type: "end" } },
      })],
      ["a profile field in event filters", journeyWith("filters", groups(eventProperty("gender", "=", "female")))],
      ["a profile field in a watch's event filters", journeyWith("next.filters", groups(eventProperty("city", "=", "Hanoi")))],
      ["an event field in a profile condition", journeyWith("conditions", groups(profile("product.name", "Phone")))],
      ["a multi-branch key that repeats", journeyWith("next", {
        type: "check",
        id: "check-1",
        label: "Split",
        eventName: "view_item",
        next: {
          type: "MultiBranchPath",
          branches: [
            { branchKey: "vip", priority: 0, next: { type: "end" } },
            { branchKey: "vip", priority: 1, next: { type: "end" } },
          ],
        },
      })],
      ["a segment with a multi-branch path", journeyWith("next", {
        type: "segment",
        id: "segment-1",
        label: "Split by tier",
        conditions: groups({ type: "behavior", event: "purchase", measure: "COUNT", op: ">=", value: 2 }),
        next: {
          type: "MultiBranchPath",
          branches: [
            { branchKey: "gold", priority: 0, next: { type: "end" } },
            { branchKey: "silver", priority: 1, next: { type: "end" } },
          ],
        },
      })],
      ["a profile field that is not in the profile on a branch", journeyWith("next", {
        type: "check",
        id: "check-1",
        label: "Split",
        eventName: "view_item",
        next: {
          type: "MultiBranchPath",
          branches: [
            { branchKey: "hanoi", priority: 0, conditions: groups(profile("profile.city", "Hanoi")), next: { type: "end" } },
            { branchKey: "other", priority: 1, next: { type: "end" } },
          ],
        },
      })],
      ["a field that is not an event field in event filters", journeyWith("filters", groups(eventProperty("metric.views", ">", 3)))],
      ["an empty group in a check's filters", journeyWith("next", {
        type: "check",
        id: "check-1",
        label: "Anything",
        eventName: "view_item",
        filters: { groups: [{ conditions: [] }] },
        next: { type: "YesPath", yes: { type: "end" } },
      })],
      ["an IN value that is a comma string", journeyWith("conditions", groups({ type: "profile_property", field: "city", op: "IN", value: "Hanoi,Da Nang" }))],
    ])("%s", async (_, reply) => {
      modelReplies(JSON.stringify(reply));

      const { status, body } = await generate({ prompt: "send a push" });

      expect(status).toBe(502);
      expect(body).toEqual({ error: expect.any(String) });
    });

    it("text that is not JSON", async () => {
      modelReplies("Sure! Here is your journey.");

      const { status, body } = await generate({ prompt: "send a push" });

      expect(status).toBe(502);
      expect(body).toEqual({ error: expect.any(String) });
    });
  });

  describe("checks the prompt before it calls the model", () => {
    it.each([
      ["a missing prompt", {}],
      ["a prompt that is not a string", { prompt: ["send", "a", "push"] }],
      ["a blank prompt", { prompt: "   " }],
      ["a prompt over 2000 characters", { prompt: "x".repeat(2001) }],
      ["a body that is not JSON", "prompt=send"],
    ])("returns 400 for %s", async (_, body) => {
      const { status, body: reply } = await generate(body);

      expect(status).toBe(400);
      expect(reply).toEqual({ error: expect.any(String) });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("hides the model's errors from the browser", () => {
    it("returns a fixed message when the model is not configured", async () => {
      delete process.env.OPENAI_API_KEY;

      const { status, body } = await generate({ prompt: "send a push" });

      expect(status).toBe(503);
      expect(body).toEqual({ error: expect.any(String) });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns a fixed message when the model call fails", async () => {
      fetchMock.mockResolvedValue(new Response("upstream secret: quota exceeded for key sk-123", { status: 429 }));

      const { status, body } = await generate({ prompt: "send a push" });

      expect(status).toBe(502);
      expect(JSON.stringify(body)).not.toMatch(/sk-123|quota|429/);
    });

    it("logs the provider's status but not its error body, which can echo the key", async () => {
      fetchMock.mockResolvedValue(new Response(
        JSON.stringify({ error: { message: "Incorrect API key provided: test-***-key", code: "invalid_api_key" } }),
        { status: 401 },
      ));

      await generate({ prompt: "send a push" });

      const logged = jest.mocked(console.error).mock.calls.flat().map(String).join(" ");
      expect(logged).toMatch(/401/);
      expect(logged).not.toMatch(/test-\*\*\*-key|test-key|Incorrect API key/);
    });

    it("returns a fixed message when the reply has no choices", async () => {
      fetchMock.mockResolvedValue(Response.json({ error: { message: "model overloaded" } }));

      const { status, body } = await generate({ prompt: "send a push" });

      expect(status).toBe(502);
      expect(JSON.stringify(body)).not.toMatch(/overloaded|TypeError|undefined/);
    });

    it("bounds the model call with a timeout and returns 504 when it fires", async () => {
      fetchMock.mockImplementation(async (_url, init) => {
        expect(init.signal).toBeInstanceOf(AbortSignal);
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      });

      const { status, body } = await generate({ prompt: "send a push" });

      expect(status).toBe(504);
      expect(body).toEqual({ error: expect.any(String) });
    });
  });

  describe("rate limits each user", () => {
    const start = Date.UTC(2026, 9, 18, 9, 0, 0);

    async function generateTimes(count: number) {
      const replies = [];
      for (let i = 0; i < count; i++) {
        replies.push(await generate({ prompt: "send a push" }));
      }
      return replies;
    }

    beforeEach(() => {
      jest.spyOn(Date, "now").mockReturnValue(start);
      modelReplies(JSON.stringify(journey));
    });

    it("returns 429 with Retry-After on the 11th request in a minute and does not call the model", async () => {
      const replies = await generateTimes(11);

      expect(replies.slice(0, 10).map((reply) => reply.status)).toEqual(Array(10).fill(200));
      expect(replies[10]).toEqual({
        status: 429,
        retryAfter: "60",
        body: { error: "Too many AI generation requests. Try again later." },
      });
      expect(fetchMock).toHaveBeenCalledTimes(10);
    });

    it("counts a request whose model call fails", async () => {
      fetchMock.mockImplementation(async () => new Response("overloaded", { status: 500 }));

      const replies = await generateTimes(11);

      expect(replies.map((reply) => reply.status)).toEqual([...Array(10).fill(502), 429]);
    });

    it("lets the user in again after the minute", async () => {
      await generateTimes(10);

      jest.mocked(Date.now).mockReturnValue(start + 60_000);
      const { status } = await generate({ prompt: "send a push" });

      expect(status).toBe(200);
    });

    it("counts each user separately", async () => {
      signInAs("editor-a");
      await generateTimes(10);

      signInAs("editor-b");
      const other = await generate({ prompt: "send a push" });
      signInAs("editor-a");
      const same = await generate({ prompt: "send a push" });

      expect([other.status, same.status]).toEqual([200, 429]);
    });

    it("returns 401 without a session before it applies the limit", async () => {
      await generateTimes(10);

      jest.mocked(getSession).mockResolvedValue(null);
      const replies = await generateTimes(11);

      expect(replies.map((reply) => reply.status)).toEqual(Array(11).fill(401));
      expect(fetchMock).toHaveBeenCalledTimes(10);
    });

    it("reads the limits from the environment", async () => {
      process.env.AI_GENERATION_LIMIT_PER_MINUTE = "2";

      const replies = await generateTimes(3);

      expect(replies.map((reply) => reply.status)).toEqual([200, 200, 429]);
    });

    it("returns 503 and does not call the model when a limit is not valid", async () => {
      process.env.AI_GENERATION_LIMIT_PER_DAY = "unlimited";

      const { status, body } = await generate({ prompt: "send a push" });

      expect(status).toBe(503);
      expect(body).toEqual({ error: "AI generation is not configured." });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
