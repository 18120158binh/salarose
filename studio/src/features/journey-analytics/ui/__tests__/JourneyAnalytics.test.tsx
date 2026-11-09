import { act, render, screen, waitFor, within } from "@testing-library/react";
import type { JourneyNode } from "../../model/nodes";
import type { NodeAnalytics, RemovedStep } from "../../model/queries";
import { JourneyAnalytics } from "../JourneyAnalytics";

const node = (id: string, setting: JourneyNode["setting"], parent: [string, string] | null = null): JourneyNode => ({
  id,
  parentId: parent?.[0] ?? null,
  parentBranch: parent?.[1] ?? null,
  branchOrder: [],
  setting,
});

// The node analytics worked example: setup S, watch W under S on next, End E1 under W on success.
const WORKED: NodeAnalytics[] = [
  {
    node: node("S", { type: "setup", trigger: { kind: "event", event: "view_product" } }),
    label: "Start: View product",
    depth: 0,
    entered: 3,
    completed: 3,
    waiting: 0,
    split: [{ branch: "next", entries: 3 }],
  },
  {
    node: node("W", { type: "watch", event: "add_to_cart", delay: false, limit: { value: 1, unit: "DAYS" } }, ["S", "next"]),
    label: "Wait for Add to cart, 1 day",
    depth: 1,
    entered: 3,
    completed: 2,
    waiting: 1,
    split: [
      { branch: "success", entries: 1 },
      { branch: "timeout", entries: 1 },
    ],
  },
  { node: node("E1", { type: "end" }, ["W", "success"]), label: "End", depth: 2, entered: 1, completed: 1, waiting: 0, split: [] },
];

const REMOVED: RemovedStep[] = [{ nodeId: "W-success-end-old", nodeType: "end", label: "Removed step (end)", entries: 4 }];

const cells = (row: HTMLElement) => within(row).getAllByRole("cell").map((cell) => cell.textContent);

describe("JourneyAnalytics", () => {
  it("lists each step in tree order with Entered, Waiting, Completed, the rate, and the split (JBD-FR-19)", () => {
    render(<JourneyAnalytics rangeLabel="Last 7 days" removed={[]} steps={WORKED} />);

    const table = screen.getByRole("table", { name: "Steps" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map(cells)).toEqual([
      ["Start: View product", "3", "0", "3", "100%", "Next3"],
      ["Wait for Add to cart, 1 day", "3", "1", "2", "67%", "Success1Timeout1"],
      ["End", "1", "0", "1", "100%", "No branches"],
    ]);
  });

  it("says which numbers are not available and shows none of them (JBD-FR-43)", () => {
    render(<JourneyAnalytics rangeLabel="Last 7 days" removed={[]} steps={WORKED} />);

    expect(screen.getByText(/messages delivered, opened or clicked, revenue, and goal conversion\./)).toHaveTextContent(
      "Not available: messages delivered, opened or clicked, revenue, and goal conversion.",
    );
  });

  it("names each step by its label, never its id (JBD-FR-22)", () => {
    render(<JourneyAnalytics rangeLabel="Last 7 days" removed={[]} steps={WORKED} />);

    const graph = screen.getByRole("region", { name: "Journey graph" });
    expect(
      within(graph).getByRole("group", { name: "Wait for Add to cart, 1 day: entered 3, waiting 1, completed 2; split Success 1, Timeout 1" }),
    ).toBeInTheDocument();
    expect(within(graph).getByRole("group", { name: "End: entered 1, waiting 0, completed 1; no branches" })).toBeInTheDocument();
    expect(within(graph).queryByText("W")).toBeNull();
  });

  it("shows a step's branch split when the keyboard focuses it in the graph (JBD-FR-19)", async () => {
    render(<JourneyAnalytics rangeLabel="Last 7 days" removed={[]} steps={WORKED} />);
    // Only the table shows the watch's timeout branch until the graph's step has focus.
    expect(screen.getAllByText("Timeout")).toHaveLength(1);

    act(() => screen.getByRole("group", { name: /^Wait for Add to cart/ }).focus());

    await waitFor(() => expect(screen.getAllByText("Timeout")).toHaveLength(2));
  });

  it("says no step entered instead of a rate when nobody entered", () => {
    const idle = WORKED.map((step) => ({ ...step, entered: 0, completed: 0, waiting: 0 }));
    render(<JourneyAnalytics rangeLabel="Today" removed={[]} steps={idle} />);

    const rows = within(screen.getByRole("table", { name: "Steps" })).getAllByRole("row").slice(1);
    expect(cells(rows[0])[4]).toBe("No entries");
  });

  it("lists removed steps apart from the current steps, with their count in the range (JBD-FR-21)", () => {
    render(<JourneyAnalytics rangeLabel="All time" removed={REMOVED} steps={WORKED} />);

    const removed = screen.getByText("Removed steps (1)").closest("details")!;
    expect(removed).not.toHaveAttribute("open");
    expect(removed).toHaveTextContent("Removed step (end)");
    expect(removed).toHaveTextContent("W-success-end-old");
    expect(removed).toHaveTextContent("4 completed, all time");
    expect(within(screen.getByRole("table", { name: "Steps" })).queryByText("Removed step (end)")).toBeNull();
  });

  it("says the journey has no steps, and still lists its removed steps", () => {
    render(<JourneyAnalytics rangeLabel="All time" removed={REMOVED} steps={[]} />);

    expect(screen.getByText("This journey has no published steps.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("Removed steps (1)")).toBeInTheDocument();
  });
});
