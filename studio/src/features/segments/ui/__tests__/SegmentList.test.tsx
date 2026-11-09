import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SegmentSummary } from "@/lib/db";
import type { TimeZone } from "@/shared/lib/time-range";
import { withStage } from "@/widgets/v2-shell/model/__fixtures__/stage";
import type { Viewer } from "@/widgets/v2-shell/model/routes";
import { segmentRows } from "../../model/segmentList";
import { SegmentList } from "../SegmentList";

const deleteAction = jest.fn();
jest.mock("../../model/actions", () => ({ deleteSegmentV2Action: (...args: unknown[]) => deleteAction(...args) }));
const refresh = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: jest.fn() }) }));

const NOW = Date.parse("2026-11-08T09:00:00Z");
const ZONE = "Asia/Ho_Chi_Minh" as TimeZone;
const LAN: Viewer = { userId: "u-lan", role: "editor" };
const MINH: Viewer = { userId: "u-minh", role: "editor" };
const ADMIN: Viewer = { userId: "u-admin", role: "admin" };

const SEGMENTS: SegmentSummary[] = [
  {
    id: "SEG-4f1c9a0b2d3e5f67",
    name: "Hanoi cart builders",
    description: "Shoppers in Hanoi who keep adding to cart",
    createdBy: "lan@example.com",
    updatedAt: "2026-11-08T08:48:00Z",
    usedBy: [
      { campaignId: "CAMP-A", campaignName: "Cart rescue", status: "active", kinds: ["entry_trigger"], ownerId: "u-lan" },
      { campaignId: "CAMP-B", campaignName: "VIP push", status: "paused", kinds: ["event_audience", "condition"], ownerId: null },
    ],
  },
  {
    id: "SEG-0000000000000001",
    name: "Lapsed VIPs",
    description: "No order in 90 days",
    createdBy: null,
    updatedAt: "2026-10-01T02:00:00Z",
    usedBy: [],
  },
];

function renderList(segments: SegmentSummary[] = SEGMENTS, viewer: Viewer = ADMIN, canEdit = false) {
  return render(<SegmentList canEdit={canEdit} classicHref="/segments" rows={segmentRows(segments, NOW, ZONE, viewer)} />);
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest("tr");
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

function shownNames(): string[] {
  return screen.queryAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell")[0].querySelector(".font-medium")?.textContent ?? "");
}

const THEMES = ["light", "dark"] as const;

// DESIGN.md dark mode: a palette color or a hex value in a class would not follow the theme tokens.
const RAW_COLOR =
  /(?:^|:)(?:bg|text|border|ring|fill|stroke|from|to|via|shadow)-(?:white|black|gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d+)?(?:\/\d+)?$|#[0-9a-f]{3,8}\b/i;

afterEach(() => {
  document.documentElement.className = "";
});

describe.each(THEMES)("SegmentList in the %s theme", (theme) => {
  beforeEach(() => {
    document.documentElement.className = theme === "dark" ? "dark" : "";
  });

  it("lists each campaign that uses a segment with its status and kind of use, linked to its analytics (SEG-FR-09)", async () => {
    await withStage(["journey-analytics"], "shipped", () => {
      renderList(SEGMENTS, MINH);
      const row = rowOf("Hanoi cart builders");

      expect(within(row).getByRole("link", { name: "Cart rescue" })).toHaveAttribute("href", "/v2/journeys/CAMP-A");
      expect(within(row).getByRole("link", { name: "VIP push" })).toHaveAttribute("href", "/v2/journeys/CAMP-B");
    });
  });

  it("names each campaign's status and kind of use (SEG-FR-09)", () => {
    renderList();
    const row = rowOf("Hanoi cart builders");

    expect(within(row).getByText("Active")).toBeInTheDocument();
    expect(within(row).getByText("Paused")).toBeInTheDocument();
    expect(within(row).getByText("Entry trigger")).toBeInTheDocument();
    expect(within(row).getByText("Business-event audience, Condition")).toBeInTheDocument();
  });

  it("shows the creator and the last change, and Unknown when the creator was deleted (SEG-FR-09)", () => {
    renderList();

    expect(within(rowOf("Hanoi cart builders")).getByText("lan@example.com")).toBeInTheDocument();
    expect(within(rowOf("Hanoi cart builders")).getByText("12 min ago")).toBeInTheDocument();
    expect(within(rowOf("Lapsed VIPs")).getByText("Unknown")).toBeInTheDocument();
    expect(within(rowOf("Lapsed VIPs")).getByText("Oct 1, 2026, 9:00 AM")).toBeInTheDocument();
  });

  it("says a segment no campaign uses is not used by any journey (SEG-FR-09)", () => {
    renderList();

    expect(within(rowOf("Lapsed VIPs")).getByText("Not used by any journey")).toBeInTheDocument();
  });

  it("renders from theme tokens alone", () => {
    const { container } = renderList();
    const raw = [...container.querySelectorAll("*")].flatMap((element) =>
      (element.getAttribute("class") ?? "").split(/\s+/).filter((name) => RAW_COLOR.test(name)),
    );

    expect(raw).toEqual([]);
  });
});

describe("SegmentList journey links", () => {
  it.each([
    ["the journey's owner", LAN],
    ["another editor", MINH],
    ["an admin", ADMIN],
  ])("links %s to each journey's analytics, ownerless journeys included", (_who, viewer) => {
    renderList(SEGMENTS, viewer);
    const row = rowOf("Hanoi cart builders");

    expect(within(row).getByRole("link", { name: "Cart rescue" })).toHaveAttribute("href", "/v2/journeys/CAMP-A");
    expect(within(row).getByRole("link", { name: "VIP push" })).toHaveAttribute("href", "/v2/journeys/CAMP-B");
  });
});

describe("SegmentList search and filter (SEG-FR-09)", () => {
  it("lists segments by name in the order the server sorted them", () => {
    renderList();

    expect(shownNames()).toEqual(["Hanoi cart builders", "Lapsed VIPs"]);
  });

  it("matches the search anywhere in the name or the description, ignoring case", () => {
    renderList();
    const search = screen.getByRole("searchbox", { name: "Search segments" });

    fireEvent.change(search, { target: { value: "CART" } });
    expect(shownNames()).toEqual(["Hanoi cart builders"]);

    fireEvent.change(search, { target: { value: "90 days" } });
    expect(shownNames()).toEqual(["Lapsed VIPs"]);
  });

  it("shows only unused segments, or only segments in use", () => {
    renderList();

    fireEvent.click(screen.getByRole("button", { name: "Unused" }));
    expect(shownNames()).toEqual(["Lapsed VIPs"]);

    fireEvent.click(screen.getByRole("button", { name: "In use" }));
    expect(shownNames()).toEqual(["Hanoi cart builders"]);
  });

  it("says when nothing matches", () => {
    renderList();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search segments" }), { target: { value: "no such text" } });

    expect(screen.getByText("No segment matches the search and filter. Clear the search or pick All.")).toBeInTheDocument();
  });

  it("sends a viewer without preview access to the classic studio to create the first segment", () => {
    renderList([]);

    expect(screen.getByText(/^No segments yet\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create one in the classic studio" })).toHaveAttribute("href", "/segments");
  });

  it("offers New segment for the first segment to a viewer who may reach the editor", () => {
    renderList([], ADMIN, true);

    expect(screen.getByRole("link", { name: /New segment/ })).toHaveAttribute("href", "/v2/segments/new");
  });

  it("counts the segments each filter keeps and how many are shown", () => {
    renderList();

    expect(screen.getByRole("button", { name: "In use" })).toHaveTextContent("1");
    expect(screen.getByText(/segments, sorted by name/)).toHaveTextContent("Showing 2 of 2 segments, sorted by name");
  });
});

describe("SegmentList controls (SEG-FR-01, SEG-FR-08)", () => {
  it("offers no Edit or Delete to a viewer who may not reach the editor", () => {
    renderList();

    expect(screen.queryByRole("link", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Delete/ })).not.toBeInTheDocument();
  });

  it("links Edit to the segment's editor", () => {
    renderList(SEGMENTS, ADMIN, true);

    expect(within(rowOf("Lapsed VIPs")).getByRole("link", { name: "Edit" })).toHaveAttribute("href", "/v2/segments/SEG-0000000000000001");
  });

  it("shows no Size column and says why (SEG-FR-08)", () => {
    renderList();

    expect(screen.queryByRole("columnheader", { name: /member|size|count/i })).not.toBeInTheDocument();
    expect(screen.getByText("Size shows once membership is stored")).toBeInTheDocument();
  });
});

describe("SegmentList delete (SEG-FR-04)", () => {
  beforeEach(() => {
    deleteAction.mockReset();
    refresh.mockReset();
  });

  it("refuses to delete a segment journeys use, names each one, and calls nothing", () => {
    renderList(SEGMENTS, ADMIN, true);

    fireEvent.click(screen.getByRole("button", { name: "Delete Hanoi cart builders" }));

    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("“Hanoi cart builders” can't be deleted yet")).toBeInTheDocument();
    expect(within(dialog).getByText(/^2 journeys use it\./)).toBeInTheDocument();
    expect(within(dialog).getByText("Cart rescue")).toBeInTheDocument();
    expect(within(dialog).getByText("VIP push")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Delete segment" })).not.toBeInTheDocument();
    expect(deleteAction).not.toHaveBeenCalled();
  });

  it("asks once, then deletes an unused segment and reloads the list", async () => {
    deleteAction.mockResolvedValue({ deleted: true });
    renderList(SEGMENTS, ADMIN, true);

    fireEvent.click(screen.getByRole("button", { name: "Delete Lapsed VIPs" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete segment" }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(deleteAction).toHaveBeenCalledWith("SEG-0000000000000001");
  });
});

describe("SegmentList selected segment (SHL-FR-07)", () => {
  it("marks the segment the command palette opened and scrolls it into view", () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    render(<SegmentList canEdit={false} classicHref="/segments" rows={segmentRows(SEGMENTS, NOW, ZONE, ADMIN)} selected="SEG-0000000000000001" />);

    const current = screen.getByRole("row", { current: true });
    expect(within(current).getByText("Lapsed VIPs")).toBeInTheDocument();
    expect(screen.getAllByRole("row", { current: true })).toHaveLength(1);
    expect(scrolled).toEqual([current]);
  });
});
