import { act, render, screen, within } from "@testing-library/react";
import { CART_ROOT, EVENTS } from "../../../journey-builder/model/__fixtures__/cart";
import { parseTimeZone } from "@/shared/lib/time-range";
import type { NodeCompletedRefresh } from "../../model/actions";
import { JourneyCanvasTab } from "../JourneyCanvasTab";

jest.mock("../../model/actions", () => ({ refreshNodeCompletedAction: jest.fn() }));

const T0 = Date.UTC(2026, 10, 14, 9);

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
}

function open(refresh: (id: string) => Promise<NodeCompletedRefresh>, completed: Record<string, number> = { start: 120, waitev: 100 }) {
  return render(<JourneyCanvasTab completed={completed} events={EVENTS} id="CAMP-1" readAt={T0} refresh={refresh} root={CART_ROOT} zone={parseTimeZone("UTC")} />);
}

function card(name: RegExp): HTMLElement {
  const canvas = screen.getByRole("region", { name: "Journey canvas" });
  const match = within(canvas)
    .getAllByRole("listitem")
    .find((item) => name.test(item.textContent ?? ""));
  if (!match) throw new Error(`No card matches ${name}`);
  return match;
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers({ now: T0 });
  setHidden(false);
});
afterEach(() => jest.useRealTimers());

describe("JourneyCanvasTab (JBD-FR-09)", () => {
  it("draws the builder's cards read-only, each with its all-time Completed count, 0 when it has no stats row", () => {
    open(jest.fn());

    expect(card(/Order completed/)).toHaveTextContent("Completed 100");
    expect(card(/Push/)).toHaveTextContent("Completed 0");
    const canvas = screen.getByRole("region", { name: "Journey canvas" });
    expect(within(canvas).queryAllByRole("button")).toEqual([]);
    expect(screen.queryByRole("complementary", { name: "Steps you can add" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Updated just now · refreshes every 5 seconds");
  });

  it("refreshes the counts every 5 seconds", async () => {
    const refresh = jest.fn().mockResolvedValue({ completed: { start: 121, waitev: 104 }, readAt: T0 + 5000 });
    open(refresh);

    await advance(4999);
    expect(refresh).not.toHaveBeenCalled();
    await advance(1);

    expect(refresh).toHaveBeenCalledWith("CAMP-1");
    expect(card(/Order completed/)).toHaveTextContent("Completed 104");
  });

  it("runs no refresh while the browser tab is hidden", async () => {
    const refresh = jest.fn().mockResolvedValue({ completed: {}, readAt: T0 });
    setHidden(true);
    open(refresh);

    await advance(20_000);
    expect(refresh).not.toHaveBeenCalled();

    setHidden(false);
    await advance(5000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("starts the next refresh only after the last one has finished", async () => {
    let finish: (value: NodeCompletedRefresh) => void = () => {};
    const refresh = jest.fn(() => new Promise<NodeCompletedRefresh>((resolve) => (finish = resolve)));
    open(refresh);

    await advance(5000);
    await advance(30_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => finish({ completed: {}, readAt: T0 + 35_000 }));
    await advance(5000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("keeps the last counts and says they could not refresh when a refresh fails", async () => {
    const refresh = jest.fn().mockResolvedValueOnce({ error: "Counts could not refresh." }).mockRejectedValueOnce(new Error("network"));
    open(refresh);

    await advance(5000);
    expect(card(/Order completed/)).toHaveTextContent("Completed 100");
    expect(screen.getByRole("status")).toHaveTextContent("Counts could not refresh. Showing counts from a few seconds ago.");

    await advance(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(card(/Order completed/)).toHaveTextContent("Completed 100");
    expect(screen.getByRole("status")).toHaveTextContent("Showing counts from 1 min ago.");
  });
});
