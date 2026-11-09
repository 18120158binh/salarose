import { act, renderHook } from "@testing-library/react";
import { STATS_REFRESH_MS, useNodeStats, type NodeStatsResult } from "../useNodeStats";

// JBD-FR-09 and the failure handling in docs/internal/features/journey-builder.md: the counts
// refresh every 5 seconds, and a failed refresh keeps the last counts.
const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
};

// Settles the pending promise callbacks inside act.
const flush = () => act(async () => {});
const tick = (ms: number) => act(async () => {
  jest.advanceTimersByTime(ms);
});

beforeEach(() => {
  jest.useFakeTimers();
  setHidden(false);
});

afterEach(() => {
  jest.useRealTimers();
  setHidden(false);
});

describe("useNodeStats", () => {
  it("keeps the last counts and reports the failure when a refresh fails", async () => {
    const load = jest.fn<Promise<NodeStatsResult>, [string]>()
      .mockResolvedValueOnce({ stats: { "setup-1": 4 } })
      .mockResolvedValueOnce({ error: "Node counts could not load." })
      .mockResolvedValueOnce({ stats: { "setup-1": 5 } });
    const { result } = renderHook(() => useNodeStats("c_1", load));
    await flush();
    expect(result.current).toEqual({ stats: { "setup-1": 4 }, failed: false });

    await tick(STATS_REFRESH_MS);
    expect(result.current).toEqual({ stats: { "setup-1": 4 }, failed: true });

    await tick(STATS_REFRESH_MS);
    expect(result.current).toEqual({ stats: { "setup-1": 5 }, failed: false });
  });

  it("keeps the last counts when the request itself rejects", async () => {
    const load = jest.fn<Promise<NodeStatsResult>, [string]>()
      .mockResolvedValueOnce({ stats: { "setup-1": 4 } })
      .mockRejectedValueOnce(new Error("network"));
    const { result } = renderHook(() => useNodeStats("c_1", load));
    await flush();
    await tick(STATS_REFRESH_MS);

    expect(result.current).toEqual({ stats: { "setup-1": 4 }, failed: true });
  });

  it("does not poll while the tab is hidden", async () => {
    const load = jest.fn<Promise<NodeStatsResult>, [string]>().mockResolvedValue({ stats: {} });
    renderHook(() => useNodeStats("c_1", load));
    await flush();
    setHidden(true);

    await tick(STATS_REFRESH_MS * 3);
    expect(load).toHaveBeenCalledTimes(1);

    setHidden(false);
    await tick(STATS_REFRESH_MS);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not start a request while the last one is still running", async () => {
    let finish: (result: NodeStatsResult) => void = () => {};
    const load = jest.fn<Promise<NodeStatsResult>, [string]>(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    renderHook(() => useNodeStats("c_1", load));
    await tick(STATS_REFRESH_MS * 3);
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => finish({ stats: {} }));
    await tick(STATS_REFRESH_MS);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("loads nothing for a new campaign", async () => {
    const load = jest.fn<Promise<NodeStatsResult>, [string]>();
    const { result } = renderHook(() => useNodeStats(null, load));
    await tick(STATS_REFRESH_MS * 2);

    expect(load).not.toHaveBeenCalled();
    expect(result.current).toEqual({ stats: {}, failed: false });
  });
});
