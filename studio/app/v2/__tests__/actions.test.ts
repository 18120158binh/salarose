const mockAssertSession = jest.fn();
const mockRun = jest.fn();

jest.mock("@/shared/auth/session", () => ({ assertSession: () => mockAssertSession() }));
jest.mock("@/lib/db", () => ({
  readOnly: async (_timeoutMs: number, work: (run: typeof mockRun) => Promise<unknown>) => work(mockRun),
}));

import { searchPaletteNames } from "../actions";

beforeEach(() => {
  mockAssertSession.mockReset().mockResolvedValue({ userId: "u-lan", role: "editor" });
  mockRun.mockReset();
  jest.spyOn(console, "error").mockImplementation(() => {});
});

describe("searchPaletteNames (SHL-FR-07, SHL-FR-11)", () => {
  it("returns the journeys and segments whose name holds the text", async () => {
    mockRun
      .mockResolvedValueOnce([{ id: "CAMP-4f1c9a0b2d3e5f67", name: "Cart abandonment" }])
      .mockResolvedValueOnce([{ id: "SEG-4f1c9a0b2d3e5f67", name: "Cart builders" }]);

    await expect(searchPaletteNames(" CART ")).resolves.toEqual({
      status: "found",
      journeys: [{ id: "CAMP-4f1c9a0b2d3e5f67", name: "Cart abandonment" }],
      segments: [{ id: "SEG-4f1c9a0b2d3e5f67", name: "Cart builders" }],
    });
    expect(mockRun.mock.calls.map(([query]) => query.values[0])).toEqual(["%CART%", "%CART%"]);
  });

  it("reads nothing for empty text", async () => {
    await expect(searchPaletteNames("  ")).resolves.toEqual({ status: "found", journeys: [], segments: [] });
    await expect(searchPaletteNames(42)).resolves.toEqual({ status: "found", journeys: [], segments: [] });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("reads nothing without a session", async () => {
    mockAssertSession.mockRejectedValue(new Error("Unauthorized"));

    await expect(searchPaletteNames("cart")).resolves.toEqual({ status: "failed" });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("reports a failed read without its error text", async () => {
    mockRun.mockRejectedValue(new Error("connection refused"));

    await expect(searchPaletteNames("cart")).resolves.toEqual({ status: "failed" });
  });
});
