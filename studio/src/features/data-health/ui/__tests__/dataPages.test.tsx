import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { UTC } from "@/shared/lib/time-range";
import { DEFAULT_CATALOG_QUERY, type CatalogEvent, type CatalogPage } from "../../model/catalog";
import type { SourceKeyRow } from "../../model/sourceKeys";
import { DashboardsPanel } from "../DashboardsPanel";
import { EventCatalog } from "../EventCatalog";
import { SourceKeyList } from "../SourceKeyList";

const replace = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace, refresh: jest.fn() }) }));
jest.mock("../../../event-management/model/actions", () => ({ setEventStatusAction: jest.fn() }));

const ADD_TO_CART: CatalogEvent = {
  id: "e-add",
  name: "add_to_cart",
  label: "Add to cart",
  description: "A shopper put a product in the cart.",
  kind: "person",
  status: "active",
  gate: true,
  attributeCount: 3,
  requiredCount: 2,
  createdAt: Date.parse("2026-11-01T08:00:00Z"),
  attributes: [
    { path: "product", type: "json", required: true, example: null },
    { path: "product.price", type: "number", required: true, example: "500000" },
    { path: "quantity", type: "number", required: false, example: "1" },
  ],
};

const COUNTS = { strict: 1, hidden: 0, item: 0 };
const PAGE: CatalogPage = { events: [ADD_TO_CART], catalogSize: 1, counts: COUNTS, matching: 1, page: 1, pageCount: 1 };

// jsdom has no Web Animations API, which the sheet waits on before it reports itself open.
beforeAll(() => {
  Element.prototype.getAnimations ??= () => [];
});

beforeEach(() => replace.mockClear());

describe("EventCatalog (DHL-FR-01, DHL-FR-02)", () => {
  it("shows each column of an event's row", () => {
    render(<EventCatalog catalog={PAGE} query={DEFAULT_CATALOG_QUERY} openDetail={false} zone={UTC} />);

    const row = screen.getByRole("row", { name: /Add to cart/ });
    expect(within(row).getByText("add_to_cart")).toBeInTheDocument();
    expect(within(row).getByText("A shopper put a product in the cart.")).toBeInTheDocument();
    expect(within(row).getByText("Strict")).toBeInTheDocument();
    expect(within(row).getByText("3")).toBeInTheDocument();
    expect(within(row).getByText("2 must be sent")).toBeInTheDocument();
    expect(within(row).getByText("Coming later")).toBeInTheDocument();
    expect(within(row).getByText("1 Nov 2026")).toBeInTheDocument();
    expect(within(row).queryByText("Hidden from builder")).not.toBeInTheDocument();
  });

  it("marks a hidden business event, and a loose one as accepting all", () => {
    const hidden: CatalogEvent = { ...ADD_TO_CART, kind: "business", status: "inactive", gate: false };
    render(<EventCatalog catalog={{ ...PAGE, events: [hidden] }} query={DEFAULT_CATALOG_QUERY} openDetail={false} zone={UTC} />);

    const row = screen.getByRole("row", { name: /Add to cart/ });
    expect(within(row).getByText("About a product")).toBeInTheDocument();
    expect(within(row).getByText("Hidden from builder")).toBeInTheDocument();
    expect(within(row).getByText("Accepts all")).toBeInTheDocument();
  });

  it("offers the row menu only when asked (CAT-FR-10)", () => {
    const shown = render(<EventCatalog catalog={PAGE} openDetail query={DEFAULT_CATALOG_QUERY} zone={UTC} />);
    expect(screen.queryByRole("button", { name: /More actions/ })).not.toBeInTheDocument();
    shown.unmount();

    render(<EventCatalog catalog={PAGE} openDetail query={DEFAULT_CATALOG_QUERY} rowMenu zone={UTC} />);
    expect(screen.getByRole("button", { name: /More actions for Add to cart/ })).toBeInTheDocument();
  });

  it("opens a read-only sheet with the description and the attribute tree when the row does not open the detail page", async () => {
    render(<EventCatalog catalog={PAGE} openDetail={false} query={DEFAULT_CATALOG_QUERY} zone={UTC} />);

    fireEvent.click(screen.getByRole("button", { name: /Add to cart/ }));

    const sheet = await screen.findByRole("dialog", { name: "Add to cart" });
    expect(within(sheet).getByText("A shopper put a product in the cart.")).toBeInTheDocument();
    const tree = within(sheet).getByRole("list", { name: "Fields" });
    expect(within(tree).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "productjsonMust be sent",
      "product.pricenumberMust be sentExample 500000",
      "quantitynumberExample 1",
    ]);
    expect(within(sheet).queryByRole("link")).not.toBeInTheDocument();
  });

  it("links a row to the event's detail page when it opens the detail page (DHL-FR-02)", () => {
    render(<EventCatalog catalog={PAGE} openDetail query={DEFAULT_CATALOG_QUERY} zone={UTC} />);

    expect(screen.getByRole("link", { name: /Add to cart/ })).toHaveAttribute("href", "/v2/data/events/e-add");
  });

  it("says the catalog is empty, and offers the create control it is given", () => {
    const empty: CatalogPage = { events: [], catalogSize: 0, counts: { strict: 0, hidden: 0, item: 0 }, matching: 0, page: 1, pageCount: 1 };
    const shown = render(<EventCatalog catalog={empty} openDetail={false} query={DEFAULT_CATALOG_QUERY} zone={UTC} />);
    expect(screen.getByText("No events in the catalog yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add event" })).not.toBeInTheDocument();
    expect(screen.getByText("Ask an admin to add the events your shop sends.")).toBeInTheDocument();
    shown.unmount();

    render(<EventCatalog addEvent={<button type="button">Add event</button>} catalog={empty} openDetail query={DEFAULT_CATALOG_QUERY} zone={UTC} />);
    expect(screen.getByRole("button", { name: "Add event" })).toBeInTheDocument();
  });

  it("says no event matches when the search and filters leave nothing", () => {
    const none: CatalogPage = { events: [], catalogSize: 60, counts: COUNTS, matching: 0, page: 1, pageCount: 1 };
    const shown = render(<EventCatalog catalog={none} query={{ ...DEFAULT_CATALOG_QUERY, search: "zzz" }} openDetail={false} zone={UTC} />);
    expect(screen.getByText(/No event matches “zzz”/)).toBeInTheDocument();
    shown.unmount();

    render(<EventCatalog catalog={none} query={{ ...DEFAULT_CATALOG_QUERY, gate: "on" }} openDetail={false} zone={UTC} />);
    expect(screen.getByText("No event matches these filters.")).toBeInTheDocument();
  });

  it("puts the search in the address once typing stops, back on the first page", async () => {
    jest.useFakeTimers();
    try {
      render(<EventCatalog catalog={{ ...PAGE, page: 2, pageCount: 2 }} query={{ ...DEFAULT_CATALOG_QUERY, gate: "on", page: 2 }} openDetail={false} zone={UTC} />);
      const search = screen.getByRole("searchbox", { name: "Search events" });

      fireEvent.change(search, { target: { value: "car" } });
      act(() => void jest.advanceTimersByTime(200));
      fireEvent.change(search, { target: { value: "cart" } });
      act(() => void jest.advanceTimersByTime(200));
      expect(replace).not.toHaveBeenCalled();
      act(() => void jest.advanceTimersByTime(100));

      expect(replace).toHaveBeenCalledTimes(1);
      expect(replace).toHaveBeenCalledWith("/v2/data/events?q=cart&gate=on", { scroll: false });
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps a search typed just before a filter click, and the filter after the wait", () => {
    jest.useFakeTimers();
    try {
      render(<EventCatalog catalog={PAGE} query={DEFAULT_CATALOG_QUERY} openDetail={false} zone={UTC} />);

      fireEvent.change(screen.getByRole("searchbox", { name: "Search events" }), { target: { value: "cart " } });
      act(() => void jest.advanceTimersByTime(100));
      fireEvent.click(within(screen.getByRole("group", { name: "Filter events" })).getByRole("button", { name: /About a product/ }));
      act(() => void jest.advanceTimersByTime(300));

      expect(replace.mock.calls).toEqual([["/v2/data/events?q=cart&kind=business", { scroll: false }]]);
    } finally {
      jest.useRealTimers();
    }
  });

  it("puts a filter in the address at once", () => {
    render(<EventCatalog catalog={PAGE} query={DEFAULT_CATALOG_QUERY} openDetail={false} zone={UTC} />);

    fireEvent.click(within(screen.getByRole("group", { name: "Filter events" })).getByRole("button", { name: /About a product/ }));

    expect(replace).toHaveBeenCalledWith("/v2/data/events?kind=business", { scroll: false });
  });

  it("shows each chip's count, presses the current one, and clears the other filters on a pick (DHL-FR-01)", () => {
    render(<EventCatalog catalog={{ ...PAGE, catalogSize: 11, counts: { strict: 2, hidden: 1, item: 1 } }} query={{ ...DEFAULT_CATALOG_QUERY, gate: "on" }} openDetail={false} zone={UTC} />);
    const chips = within(screen.getByRole("group", { name: "Filter events" }));

    expect(chips.getByRole("button", { name: "All 11" })).toHaveAttribute("aria-pressed", "false");
    expect(chips.getByRole("button", { name: "Strict 2" })).toHaveAttribute("aria-pressed", "true");
    expect(chips.getByRole("button", { name: "Hidden from builder 1" })).toBeInTheDocument();

    fireEvent.click(chips.getByRole("button", { name: "Hidden from builder 1" }));
    expect(replace).toHaveBeenCalledWith("/v2/data/events?status=inactive", { scroll: false });
  });

  it("links the pages of a long result through the address, keeping the search", () => {
    render(
      <EventCatalog catalog={{ ...PAGE, matching: 60, pageCount: 2 }} query={{ ...DEFAULT_CATALOG_QUERY, search: "page" }} openDetail={false} zone={UTC} />,
    );

    expect(screen.getByRole("link", { name: /Next/ })).toHaveAttribute("href", "/v2/data/events?q=page&page=2");
    expect(screen.getByText("50 per page")).toBeInTheDocument();
  });
});

describe("DashboardsPanel (DHL-FR-03)", () => {
  const FLINK = [{ name: "Flink jobs", url: "https://grafana.example.com/dashboards?query=Flink%20jobs" }];

  it.each(["editor", "admin"] as const)("links the Flink jobs dashboard for an %s", (role) => {
    render(<DashboardsPanel dashboards={FLINK} role={role} />);

    const link = screen.getByRole("link", { name: /Flink jobs/ });
    expect(link).toHaveAttribute("href", FLINK[0].url);
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("is hidden from an editor and says No dashboards configured to an admin when none are declared", () => {
    const { container } = render(<DashboardsPanel dashboards={[]} role="editor" />);
    expect(container).toBeEmptyDOMElement();

    render(<DashboardsPanel dashboards={[]} role="admin" />);
    expect(screen.getByText("No dashboards configured")).toBeInTheDocument();
  });
});

describe("SourceKeyList (DHL-FR-04)", () => {
  const KEYS: SourceKeyRow[] = [
    { id: "k-1", appId: "crm", hint: "cdp_sk_Ef56", createdBy: "minh@example.com", createdAt: Date.parse("2026-11-02T10:00:00Z"), status: { kind: "active" } },
    {
      id: "k-2",
      appId: "inventory",
      hint: "cdp_sk_Ab12",
      createdBy: null,
      createdAt: Date.parse("2026-10-01T08:00:00Z"),
      status: { kind: "revoked", at: Date.parse("2026-10-20T09:30:00Z") },
    },
  ];

  it("shows a revoked key as Revoked with the time, and each key's hint and creator", () => {
    render(<SourceKeyList keys={KEYS} zone={UTC} />);

    const revoked = screen.getByRole("row", { name: /inventory/ });
    expect(within(revoked).getByText("Revoked")).toBeInTheDocument();
    expect(within(revoked).getByText(/Oct 20, 2026/)).toBeInTheDocument();
    expect(within(revoked).getByText("Not recorded")).toBeInTheDocument();
    const active = screen.getByRole("row", { name: /crm/ });
    expect(within(active).getByText("Active")).toBeInTheDocument();
    expect(within(active).getByText("cdp_sk_Ef56…")).toBeInTheDocument();
    expect(within(active).getByText("minh@example.com")).toBeInTheDocument();
  });
});
