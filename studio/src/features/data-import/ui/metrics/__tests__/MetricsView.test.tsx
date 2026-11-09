import { fireEvent, render, screen, within } from "@testing-library/react";
import type { TimeZone } from "@/shared/lib/time-range";
import type { DatasetMetric, EventMetric, MetricDataset } from "../../../model/metrics";

jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh: jest.fn(), push: jest.fn() }) }));
jest.mock("../../../model/metricsActions", () => ({
  archiveDatasetMetricAction: jest.fn(),
  unarchiveDatasetMetricAction: jest.fn(),
  createDatasetMetricAction: jest.fn(),
  updateDatasetMetricAction: jest.fn(),
}));

import { MetricsView } from "../MetricsView";

const ORDERS: MetricDataset = {
  id: "d1",
  name: "orders",
  displayName: "Orders",
  eventTimeColumn: "created_at",
  columns: [{ name: "total", displayName: "Order total", type: "number", pii: false, aliases: [] }],
};

const base = { source: "dataset" as const, dataset: { id: "d1", name: "orders", displayName: "Orders" }, filters: [], createdBy: "lan@example.com", createdAt: null };
const SPEND: DatasetMetric = { ...base, id: "a", name: "spend_90d", displayName: "Spend, last 90 days", function: "SUM", column: "total", windowDays: 90, archivedAt: null, state: "live", uses: [{ kind: "segment", id: "SEG-1", name: "Big spenders" }] };
const AOV: DatasetMetric = { ...base, id: "b", name: "aov_365d", displayName: "Average order value", function: "AVG", column: "total", windowDays: 365, archivedAt: null, state: "live", uses: [] };
const CHANNELS: DatasetMetric = { ...base, id: "c", name: "channels", displayName: "Sales channels used", function: "COUNT", column: null, windowDays: 180, archivedAt: 1, state: "archived", uses: [] };
const CART: EventMetric = {
  source: "event",
  id: "m_3f9c1a2b7d4e5f60",
  displayName: "Added to cart, count",
  eventName: "com.acme/add_to_cart",
  eventDisplayName: "Added to cart",
  aggOperator: "COUNT",
  aggField: null,
  hasFilters: false,
  retentionDays: 30,
  state: "paused",
  createdBy: null,
  uses: [],
};

function renderView() {
  render(<MetricsView datasets={[ORDERS]} metrics={[SPEND, AOV, CART, CHANNELS]} zone={"UTC" as TimeZone} />);
}

describe("MetricsView (CMP-FR-22, CMP-FR-23, DIM-FR-18)", () => {
  it("hides archived metrics until the viewer asks for them", () => {
    renderView();
    expect(screen.queryByText("Sales channels used")).toBeNull();
    expect(screen.getByText("Showing 3 of 4 metrics, live first")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Show archived"));

    expect(screen.getByText("Sales channels used")).toBeInTheDocument();
  });

  it("filters by source kind and search", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: /Events/ }));
    expect(screen.getByText("Added to cart, count")).toBeInTheDocument();
    expect(screen.queryByText("Average order value")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    fireEvent.change(screen.getByPlaceholderText("Search, like spend"), { target: { value: "zzz" } });
    expect(screen.getByText('No metric matches "zzz".')).toBeInTheDocument();
  });

  it("shows the calculation in words and names each use", () => {
    renderView();
    const row = screen.getByText("Spend, last 90 days").closest("tr");
    if (!row) throw new Error("no row");
    expect(within(row).getByText("Sum of Order total")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "Segment Big spenders" })).toBeInTheDocument();
    expect(within(row).getByText("Not available")).toBeInTheDocument();
  });

  it("counts the tiles from the rows", () => {
    renderView();
    const paused = screen.getByRole("region", { name: "Paused or archived" });
    expect(within(paused).getByText("2")).toBeInTheDocument();
    expect(within(paused).getByText("1 paused event metrics · 1 archived")).toBeInTheDocument();
  });
});
