/** @jest-environment node */
const mockAssertSession = jest.fn();
const mockLoadNodeCompleted = jest.fn();

jest.mock("@/shared/auth/session", () => ({ assertSession: () => mockAssertSession() }));
jest.mock("../server", () => ({ loadNodeCompleted: (...args: unknown[]) => mockLoadNodeCompleted(...args) }));

import { refreshNodeCompletedAction } from "../actions";

beforeEach(() => {
  mockAssertSession.mockReset().mockResolvedValue({ userId: "u-minh", role: "editor" });
  mockLoadNodeCompleted.mockReset().mockResolvedValue({ start: 12 });
  jest.spyOn(console, "error").mockImplementation(() => {});
});

describe("refreshNodeCompletedAction (JBD-FR-09)", () => {
  it("reads nothing without a session", async () => {
    mockAssertSession.mockRejectedValue(new Error("Unauthorized"));

    await expect(refreshNodeCompletedAction("CAMP-1")).resolves.toEqual({ error: "Counts could not refresh." });
    expect(mockLoadNodeCompleted).not.toHaveBeenCalled();
  });

  it("returns the counts to any staff user, not only the owner", async () => {
    const result = await refreshNodeCompletedAction("CAMP-1");

    expect(result).toEqual({ completed: { start: 12 }, readAt: expect.any(Number) });
    expect(mockLoadNodeCompleted).toHaveBeenCalledWith("CAMP-1");
  });

  it("turns a failed read into a result, so the tab keeps its last counts", async () => {
    mockLoadNodeCompleted.mockRejectedValue(new Error("statement timeout"));

    await expect(refreshNodeCompletedAction("CAMP-1")).resolves.toEqual({ error: "Counts could not refresh." });
  });

  it("refuses an id that is not a string", async () => {
    await expect(refreshNodeCompletedAction(42)).resolves.toEqual({ error: "No journey id." });
    expect(mockLoadNodeCompleted).not.toHaveBeenCalled();
  });
});
