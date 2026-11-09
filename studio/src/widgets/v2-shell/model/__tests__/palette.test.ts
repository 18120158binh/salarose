import { withStage } from "../__fixtures__/stage";
import { CREATE_TARGETS, journeyNameQuery, NAME_MATCH_LIMIT, paletteGroups, parseNameMatches, segmentNameQuery } from "../palette";
import { mayReach, NAV, type Reach } from "../routes";

const ADMIN: Reach = { role: "admin", preview: true };
const EDITOR: Reach = { role: "editor", preview: false };
const PREVIEW_EDITOR: Reach = { role: "editor", preview: true };
const VIEWERS = { admin: ADMIN, editor: EDITOR } as const;

const labels = (groups: ReturnType<typeof paletteGroups>, group: string) =>
  groups.find((candidate) => candidate.value === group)?.items.map((item) => item.label) ?? [];

describe("paletteGroups pages (SHL-FR-04)", () => {
  it.each(["editor", "admin"] as const)("offers %s every sidebar page they may reach, in sidebar order", (role) => {
    const viewer = VIEWERS[role];
    const expected = NAV.filter((entry) => entry.section !== "menu" && mayReach(entry, viewer)).map((entry) => entry.label);
    expect(labels(paletteGroups(viewer, "", null), "Pages")).toEqual(expected);
  });

  it("offers no reserved page to anyone", () => {
    const pages = labels(paletteGroups(ADMIN, "", null), "Pages");
    for (const entry of NAV.filter((e) => e.stage === "reserved")) expect(pages).not.toContain(entry.label);
  });

  it("offers a preview page with its badge to a preview viewer only (SHL-FR-22)", () => {
    const settings = paletteGroups(ADMIN, "settings", null)[0].items[0];
    expect(settings).toMatchObject({ label: "Settings", preview: true });
    expect(labels(paletteGroups(PREVIEW_EDITOR, "settings", null), "Pages")).toEqual([]);
  });

  it("never offers an editor an admin page", () => {
    const pages = labels(paletteGroups(PREVIEW_EDITOR, "", null), "Pages");
    expect(pages).toEqual(expect.arrayContaining(["Home", "Journeys"]));
    for (const adminPage of ["Sources", "Dropped data", "Platform", "Settings"]) expect(pages).not.toContain(adminPage);
  });

  it("matches the typed text anywhere in a page name, ignoring case", () => {
    const groups = paletteGroups(ADMIN, "  TFOR ", null);
    expect(labels(groups, "Pages")).toEqual(["Platform"]);
    expect(groups[0].items[0].href).toBe("/v2/platform");
  });
});

describe("paletteGroups create targets (SHL-FR-07, SHL-FR-22)", () => {
  it("offers Create journey at its preview stage, and no create target whose area is not built", () => {
    expect(labels(paletteGroups(ADMIN, "", null), "Create")).toEqual(["Create journey"]);
    expect(labels(paletteGroups(EDITOR, "", null), "Create")).toEqual([]);
  });

  it("offers a create target at preview to preview viewers only, within their role", async () => {
    await withStage(CREATE_TARGETS.map((target) => target.id), "preview", () => {
      expect(labels(paletteGroups(ADMIN, "", null), "Create")).toEqual(["Create journey", "New segment", "Add event"]);
      expect(labels(paletteGroups(PREVIEW_EDITOR, "", null), "Create")).toEqual(["Create journey", "New segment"]);
      expect(labels(paletteGroups(EDITOR, "", null), "Create")).toEqual([]);
      expect(paletteGroups(ADMIN, "add", null)[0].items[0]).toMatchObject({ href: "/v2/data/events?add=event", preview: true });
    });
  });
});

describe("paletteGroups search results (SHL-FR-07)", () => {
  const found = {
    status: "found",
    journeys: [{ id: "CAMP-4f1c9a0b2d3e5f67", name: "Cart abandonment" }],
    segments: [{ id: "SEG-4f1c9a0b2d3e5f67", name: "Cart builders" }],
  } as const;

  it("opens a journey's analytics page and the segment list with the segment selected", () => {
    const groups = paletteGroups(EDITOR, "cart", found);
    expect(groups.map((group) => group.value)).toEqual(["Journeys", "Segments", "Customers"]);
    expect(groups[0].items[0]).toMatchObject({ label: "Cart abandonment", href: "/v2/journeys/CAMP-4f1c9a0b2d3e5f67" });
    expect(groups[1].items[0]).toMatchObject({ label: "Cart builders", href: "/v2/segments?segment=SEG-4f1c9a0b2d3e5f67" });
  });

  it("looks up the trimmed text as a customer", () => {
    const [customer] = paletteGroups(EDITOR, " user 42&x ", null).at(-1)!.items;
    expect(customer).toMatchObject({ label: 'Look up customer "user 42&x"', href: "/v2/customers?q=user%2042%26x" });
  });

  it("offers no customer lookup before any text is typed", () => {
    expect(paletteGroups(EDITOR, "   ", null).map((group) => group.value)).toEqual(["Pages"]);
  });

  it("still offers the pages and the lookup when the search failed", () => {
    const groups = paletteGroups(EDITOR, "home", { status: "failed" });
    expect(groups.map((group) => group.value)).toEqual(["Pages", "Customers"]);
  });
});

describe("name queries (SHL-FR-07)", () => {
  it("finds the text anywhere in the name, ignoring case, at most 8 rows", () => {
    const query = journeyNameQuery("Cart");
    expect(query.text).toContain("name ILIKE $1");
    expect(query.values).toEqual(["%Cart%", NAME_MATCH_LIMIT]);
    expect(NAME_MATCH_LIMIT).toBe(8);
  });

  it("offers only journeys that have an analytics page", () => {
    expect(journeyNameQuery("x").text).toContain("status IN ('active', 'paused')");
  });

  it("matches typed wildcards literally", () => {
    expect(segmentNameQuery("50%_off\\").values[0]).toBe("%50\\%\\_off\\\\%");
  });

  it("drops rows without a text id and name", () => {
    expect(parseNameMatches([{ id: "SEG-1", name: "A" }, { id: 1, name: "B" }, { id: "SEG-2" }])).toEqual([{ id: "SEG-1", name: "A" }]);
  });
});
