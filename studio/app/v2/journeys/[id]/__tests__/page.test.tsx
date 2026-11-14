/** @jest-environment node */
import type { ReactElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import type { JourneySummary } from "@/features/journey-analytics/model/journeyList";
import type { Span } from "@/shared/lib/time-range";

const mockRequireViewer = jest.fn();
const mockLoadJourneySummary = jest.fn();
const mockLoadJourneyAnalytics = jest.fn();
const mockLoadJourneyCanvas = jest.fn();

let mockPreview = true;
jest.mock("../../../../../src/widgets/v2-shell/model/viewer", () => ({
  requireViewer: () => mockRequireViewer(),
  viewerReach: async () => ({ role: (await mockRequireViewer()).role, preview: mockPreview }),
}));
jest.mock("../../../../../src/features/journeys/model/actions", () => ({}));
jest.mock("../../../../../src/features/journey-analytics/model/server", () => ({
  loadJourneySummary: (...args: unknown[]) => mockLoadJourneySummary(...args),
  loadJourneyAnalytics: (...args: unknown[]) => mockLoadJourneyAnalytics(...args),
  loadJourneyCanvas: (...args: unknown[]) => mockLoadJourneyCanvas(...args),
}));
jest.mock("../../../../../src/features/journey-analytics/model/actions", () => ({}));
let mockTz: string | undefined;
jest.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "tz" && mockTz !== undefined ? { value: mockTz } : undefined) }),
}));
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
  redirect: jest.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));

import V2JourneyAnalyticsPage from "../page";

const CART: JourneySummary = {
  id: "CAMP-4f1c",
  name: "Cart abandonment",
  status: "active",
  ownerId: "u-lan",
  ownerEmail: "lan@example.com",
  updatedAt: Date.UTC(2026, 10, 1, 9),
};

const LAN = { userId: "u-lan", email: "lan@example.com", role: "editor" };
const MINH = { userId: "u-minh", email: "minh@example.com", role: "editor" };
const ADMIN = { userId: "u-admin", email: "admin@example.com", role: "admin" };

function open(id: string, range?: string, tab?: string) {
  return V2JourneyAnalyticsPage({
    params: Promise.resolve({ id }),
    searchParams: Promise.resolve({ ...(range === undefined ? {} : { range }), ...(tab === undefined ? {} : { tab }) }),
  });
}

async function render(element: ReactElement): Promise<{ html: string; errors: unknown[] }> {
  const errors: unknown[] = [];
  const stream = await renderToReadableStream(element, { onError: (error) => void errors.push(error) });
  await stream.allReady;
  return { html: await new Response(stream).text(), errors };
}

async function html(element: ReactElement): Promise<string> {
  const { html, errors } = await render(element);
  expect(errors).toEqual([]);
  return html;
}


beforeEach(() => {
  mockTz = undefined;
  mockPreview = true;
  mockRequireViewer.mockReset().mockResolvedValue(LAN);
  mockLoadJourneySummary.mockReset().mockResolvedValue(CART);
  mockLoadJourneyAnalytics.mockReset().mockResolvedValue({ nodes: [], removed: [] });
  mockLoadJourneyCanvas.mockReset().mockResolvedValue({
    root: { type: "setup", id: "start", label: "Start", triggerType: "user", triggerEventName: "add_to_cart", next: { type: "end" } },
    events: [{ name: "add_to_cart", label: "Added to cart" }],
    completed: { start: 12408 },
    readAt: Date.UTC(2026, 10, 14, 9),
  });
});

describe("/v2/journeys/[id]", () => {
  it("sends a visitor without a session to sign in and reads nothing", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });
    mockRequireViewer.mockRejectedValue(redirect);

    await expect(open("CAMP-4f1c")).rejects.toBe(redirect);
    expect(mockLoadJourneySummary).not.toHaveBeenCalled();
    expect(mockLoadJourneyAnalytics).not.toHaveBeenCalled();
  });

  it("says the journey does not exist for an id that names no published campaign (JBD-FR-19)", async () => {
    mockLoadJourneySummary.mockResolvedValue(null);

    const page = await html(await open("CAMP-gone"));

    expect(page).toContain("This journey does not exist.");
    expect(mockLoadJourneyAnalytics).not.toHaveBeenCalled();
  });

  it("loads the analytics for an editor on another user's journey, with Duplicate to edit only (JBD-FR-19, JBD-FR-23)", async () => {
    mockRequireViewer.mockResolvedValue(MINH);

    const page = await html(await open("CAMP-4f1c"));

    expect(page).toContain("Cart abandonment");
    expect(page).toContain("lan@example.com");
    expect(page).toContain("Active");
    expect(page).toContain("Duplicate to edit");
    expect(page).not.toMatch(/>Pause</);
    expect(page).not.toMatch(/>Delete</);
    expect(page).not.toContain('href="/campaign/');
    expect(mockLoadJourneyAnalytics).toHaveBeenCalledWith("CAMP-4f1c", expect.anything());
  });

  it.each([
    ["the owner", LAN],
    ["an admin", ADMIN],
  ])("offers %s Pause, Duplicate to edit, and Delete, and no link to the classic builder (JBD-FR-23)", async (_who, viewer) => {
    mockRequireViewer.mockResolvedValue(viewer);

    const page = await html(await open("CAMP-4f1c"));

    for (const label of ["Pause", "Duplicate to edit", "Delete"]) expect(page).toContain(`${label}</button>`);
    expect(page).not.toContain('href="/campaign/');
    expect(page).not.toContain("Open in classic builder");
  });

  it("offers Resume on a paused journey and says nobody moves on (CMP-FR-05)", async () => {
    mockLoadJourneySummary.mockResolvedValue({ ...CART, status: "paused" });

    const page = await html(await open("CAMP-4f1c"));

    expect(page).toContain("Resume</button>");
    expect(page).not.toContain("Pause</button>");
    expect(page).toContain("Nobody new enters and nobody moves on until it is resumed.");
  });

  it("leaves out Duplicate to edit for a viewer the v2 builder does not let through", async () => {
    mockPreview = false;

    const page = await html(await open("CAMP-4f1c"));

    expect(page).not.toContain("Duplicate to edit");
    expect(page).toContain("Pause</button>");
  });

  it("offers Today, Last 7 days, Last 30 days, and All time, and counts Last 7 days by default (JBD-FR-20)", async () => {
    const before = Date.now();
    const page = await html(await open("CAMP-4f1c"));

    for (const [range, label] of [
      ["today", "Today"],
      ["7d", "Last 7 days"],
      ["30d", "Last 30 days"],
      ["all", "All time"],
    ]) {
      expect(page).toMatch(new RegExp(`href="/v2/journeys/CAMP-4f1c\\?range=${range}"[^>]*>${label}<`));
    }
    const span: Span = mockLoadJourneyAnalytics.mock.calls[0][1];
    expect(span.end).toBeGreaterThanOrEqual(before);
    expect(span.end - span.start).toBeGreaterThan(6 * 86_400_000);
    expect(span.end - span.start).toBeLessThanOrEqual(7 * 86_400_000);
  });

  it("starts Today at the viewer's local midnight from the tz cookie (SHL-FR-15)", async () => {
    mockTz = "Asia/Ho_Chi_Minh";
    jest.useFakeTimers({ now: Date.parse("2026-11-08T03:00:00Z"), doNotFake: ["queueMicrotask", "setImmediate", "nextTick"] });
    try {
      await html(await open("CAMP-4f1c", "today"));
    } finally {
      jest.useRealTimers();
    }

    const span: Span = mockLoadJourneyAnalytics.mock.calls[0][1];
    expect(new Date(span.start).toISOString()).toBe("2026-11-07T17:00:00.000Z");
  });

  it("counts with no start for All time (JBD-FR-20)", async () => {
    await html(await open("CAMP-4f1c", "all"));

    expect(mockLoadJourneyAnalytics).toHaveBeenCalledWith("CAMP-4f1c", null);
  });

  it("puts the default range back in the address for an unknown range", async () => {
    await expect(open("CAMP-4f1c", "90d")).rejects.toThrow("NEXT_REDIRECT /v2/journeys/CAMP-4f1c?range=7d");
    expect(mockLoadJourneySummary).not.toHaveBeenCalled();
  });

  it("keeps the header and the range picker when the analytics fail (SHL-FR-12)", async () => {
    mockLoadJourneyAnalytics.mockRejectedValue(new Error("canceling statement due to statement timeout"));

    const { html, errors } = await render(await open("CAMP-4f1c"));

    expect(errors).toHaveLength(1);
    expect(html).toContain("<h1");
    expect(html).toContain("Cart abandonment");
    expect(html).toContain("All time");
    expect(html).not.toContain("<table");
  });

  it("opens on the Analytics tab, with a link to the Journey tab (JBD-FR-09)", async () => {
    const page = await html(await open("CAMP-4f1c"));

    expect(page).toMatch(/aria-current="page"[^>]*>Analytics</);
    expect(page).toContain('href="/v2/journeys/CAMP-4f1c?tab=journey"');
    expect(mockLoadJourneyCanvas).not.toHaveBeenCalled();
  });

  it("draws the read-only canvas with all-time Completed counts on ?tab=journey, for any staff user (JBD-FR-09)", async () => {
    mockRequireViewer.mockResolvedValue(MINH);

    const page = await html(await open("CAMP-4f1c", undefined, "journey"));

    expect(page).toMatch(/aria-current="page"[^>]*>Journey</);
    expect(page).toContain("Journey canvas");
    expect(page).toContain("Added to cart");
    expect(page).toContain("12,408");
    expect(page).toContain("refreshes every 5 seconds");
    expect(page).not.toContain("Last 7 days");
    expect(mockLoadJourneyCanvas).toHaveBeenCalledWith("CAMP-4f1c");
    expect(mockLoadJourneyAnalytics).not.toHaveBeenCalled();
  });

  it("keeps the header when the canvas's first read fails, leaving the error to its region (JBD-FR-09)", async () => {
    mockLoadJourneyCanvas.mockRejectedValue(new Error("statement timeout"));
    jest.spyOn(console, "error").mockImplementation(() => {});

    const { html: page } = await render(await open("CAMP-4f1c", undefined, "journey"));

    expect(page).toContain("Cart abandonment");
  });
});
