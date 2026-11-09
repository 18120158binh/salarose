import { withStage } from "../__fixtures__/stage";
import { classicBuilderHref, classicHref, entryFor, journeyHref, liveHref, NAV, navFor, type Reach } from "../routes";

const ADMIN_REACH: Reach = { role: "admin", preview: true };
const EDITOR: Reach = { role: "editor", preview: false };
const PREVIEW_EDITOR: Reach = { role: "editor", preview: true };

const labels = (viewer: Reach) => navFor(viewer).map((entry) => entry.label);

describe("navFor", () => {
  it("lists the entries an admin may reach, in the board's order", () => {
    expect(labels(ADMIN_REACH)).toEqual(["Home", "Journeys", "Audience", "Customers", "Events", "Monitoring", "Tracking setup", "Sources", "Dropped data", "Metrics", "Datasets", "Imports", "Privacy", "Platform", "Settings", "Account"]);
  });

  it("offers an editor without preview access no admin page and no preview page", () => {
    expect(labels(EDITOR)).toEqual(["Home", "Journeys", "Audience", "Customers", "Events"]);
  });

  it("never widens the role for an editor with preview access (SHL-FR-22)", () => {
    expect(labels(PREVIEW_EDITOR)).toEqual(["Home", "Journeys", "Audience", "Customers", "Events", "Monitoring", "Tracking setup", "Metrics", "Datasets", "Imports", "Account"]);
  });

  it("gives a reserved route no entry, for anyone (SHL-FR-01)", () => {
    const reserved = NAV.filter((entry) => entry.stage === "reserved").map((entry) => entry.href);
    expect(reserved).toEqual([]);
    for (const viewer of [ADMIN_REACH, PREVIEW_EDITOR, EDITOR]) {
      expect(navFor(viewer).filter((entry) => entry.stage === "reserved")).toEqual([]);
    }
  });

  it("opens a page at preview to preview viewers only", async () => {
    await withStage(["customers"], "preview", () => {
      expect(labels(PREVIEW_EDITOR)).toContain("Customers");
      expect(labels(EDITOR)).not.toContain("Customers");
    });
  });

  it("keeps every link under /v2", () => {
    for (const entry of NAV) expect(entry.href.startsWith("/v2")).toBe(true);
  });
});

describe("entryFor", () => {
  it.each([
    ["/v2", "home"],
    ["/v2/", "home"],
    ["/v2/journeys", "journeys"],
    ["/v2/journeys/CAMP-4f1c9a0b2d3e5f67", "journeys"],
    ["/v2/data/dead-letters", "dead-letters"],
    ["/v2/platform", "platform"],
  ])("highlights the entry of %p", (path, id) => {
    expect(entryFor(path)?.id).toBe(id);
  });

  it("highlights nothing for a path no entry holds", () => {
    expect(entryFor("/v2/nowhere")).toBeNull();
    expect(entryFor("/v2/journeysX")).toBeNull();
  });
});

describe("classicHref", () => {
  it.each([
    ["/v2", "editor", "/campaign"],
    ["/v2/journeys", "editor", "/campaign"],
    ["/v2/segments", "editor", "/segments"],
    ["/v2/customers/abc", "admin", "/campaign"],
    ["/v2/data/events", "admin", "/admin/events"],
    ["/v2/data/events", "editor", "/campaign"],
    ["/v2/data/sources", "admin", "/admin/source-keys"],
    ["/v2/data/dead-letters", "admin", "/campaign"],
    ["/v2/platform", "admin", "/platform"],
    ["/v2/unknown", "admin", "/campaign"],
  ] as const)("maps %p for an %s to %p", (path, role, classic) => {
    expect(classicHref(path, role)).toBe(classic);
  });
});

describe("liveHref", () => {
  it.each([
    ["platform", "admin", "/v2/platform"],
    ["journeys", "editor", "/v2/journeys"],
    ["events", "admin", "/v2/data/events"],
    ["events", "editor", "/v2/data/events"],
    ["sources", "admin", "/v2/data/sources"],
    ["dead-letters", "admin", "/v2/data/dead-letters"],
    ["dead-letters", "editor", null],
    ["customers", "editor", "/v2/customers"],
    ["sources", "editor", null],
    ["platform", "editor", null],
  ] as const)("sends a link to %p for an %s to %p today", (page, role, href) => {
    expect(liveHref(page, role === "admin" ? ADMIN_REACH : EDITOR)).toBe(href);
  });

  it("sends a viewer the stage keeps out to the classic page, or nowhere", async () => {
    await withStage(["dead-letters", "events"], "preview", () => {
      expect(liveHref("dead-letters", ADMIN_REACH)).toBe("/v2/data/dead-letters");
      expect(liveHref("events", EDITOR)).toBeNull();
      expect(liveHref("events", { role: "admin", preview: false })).toBe("/admin/events");
    });
    await withStage(["dead-letters"], "reserved", () => {
      expect(liveHref("dead-letters", ADMIN_REACH)).toBeNull();
    });
  });
});

const OWNER = { userId: "u-lan", role: "editor" as const };
const ADMIN = { userId: "u-admin", role: "admin" as const };
const OTHER_EDITOR = { userId: "u-minh", role: "editor" as const };

// Journey analytics has shipped, and every staff user may open it (JBD-FR-19).
describe("journeyHref", () => {
  it.each([
    ["its owner", OWNER],
    ["an admin", ADMIN],
    ["another editor", OTHER_EDITOR],
  ])("opens the analytics for %s", (_who, viewer) => {
    expect(journeyHref({ id: "CAMP-4f1c", ownerId: "u-lan" }, viewer)).toBe("/v2/journeys/CAMP-4f1c");
  });

  it("opens the analytics of a journey without an owner, with its id encoded", () => {
    expect(journeyHref({ id: "CAMP 1/2", ownerId: null }, OTHER_EDITOR)).toBe("/v2/journeys/CAMP%201%2F2");
  });
});

// The classic builder refuses anyone but the journey's owner or an admin (JBD-FR-23, SHL-FR-08).
describe("classicBuilderHref", () => {
  const journey = { id: "CAMP-4f1c", ownerId: "u-lan" };

  it.each([
    ["its owner", OWNER, "/campaign/CAMP-4f1c"],
    ["an admin", ADMIN, "/campaign/CAMP-4f1c"],
    ["another editor", OTHER_EDITOR, null],
  ])("opens the classic builder for %s", (_who, viewer, href) => {
    expect(classicBuilderHref(journey, viewer)).toBe(href);
  });

  it("gives an editor no link to a journey without an owner, and an admin one", () => {
    expect(classicBuilderHref({ id: "CAMP-x", ownerId: null }, OTHER_EDITOR)).toBeNull();
    expect(classicBuilderHref({ id: "CAMP-x", ownerId: null }, ADMIN)).toBe("/campaign/CAMP-x");
  });
});
