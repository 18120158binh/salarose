/** @jest-environment node */

// SEG-NFR-02: the segment actions need a session and nothing more, so a staff user who is not an
// admin manages segments, and a request without a session changes nothing.
import type { AdminSession } from "@/shared/auth/types";

let mockSession: AdminSession | null = null;
const mockSaveSegment = jest.fn();
const mockDeleteSegment = jest.fn();

jest.mock("server-only", () => ({}));
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));
jest.mock("@/shared/auth/session", () => ({
  assertSession: async () => {
    if (!mockSession) throw new Error("Unauthorized");
    return mockSession;
  },
  assertAdmin: async () => {
    throw new Error("Only admin users can do this.");
  },
}));
jest.mock("@/lib/db", () => ({
  saveSegment: (...args: unknown[]) => mockSaveSegment(...args),
  deleteSegment: (...args: unknown[]) => mockDeleteSegment(...args),
}));

import { deleteSegmentAction, saveSegmentAction } from "@/app/actions";

const segment = {
  name: "Hanoi shoppers",
  description: "",
  conditions: { groups: [{ conditions: [{ type: "profile_property", field: "city", op: "IN", value: ["Hanoi"] }] }] },
};

beforeEach(() => {
  mockSaveSegment.mockReset();
  mockDeleteSegment.mockReset();
});

it("saves a segment for a staff user who is not an admin", async () => {
  mockSession = { userId: "u2", email: "marketer@example.com", role: "editor" };
  mockSaveSegment.mockResolvedValue({ saved: true, id: "SEG-0123456789abcdef" });

  expect(await saveSegmentAction(segment)).toEqual({ success: true, id: "SEG-0123456789abcdef" });
  expect(mockSaveSegment).toHaveBeenCalledWith(expect.objectContaining({ name: "Hanoi shoppers" }), "u2", []);
});

it("deletes a segment for a staff user who is not an admin", async () => {
  mockSession = { userId: "u2", email: "marketer@example.com", role: "editor" };

  expect(await deleteSegmentAction("SEG-0123456789abcdef")).toEqual({ success: true });
});

it("changes nothing without a session", async () => {
  mockSession = null;

  expect(await saveSegmentAction(segment)).toEqual({ error: "Failed to save the segment." });
  expect(mockSaveSegment).not.toHaveBeenCalled();
});
