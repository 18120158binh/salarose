/** @jest-environment node */
const mockAssertSession = jest.fn();
const mockPreview = jest.fn();
const mockSave = jest.fn();
const mockDelete = jest.fn();

jest.mock("@/shared/auth/session", () => ({ assertSession: () => mockAssertSession() }));
jest.mock("@/shared/auth/preview", () => ({ isPreviewViewer: () => mockPreview() }));
jest.mock("@/lib/db", () => ({
  saveSegment: (...args: unknown[]) => mockSave(...args),
  deleteSegment: (...args: unknown[]) => mockDelete(...args),
}));
jest.mock("next/cache", () => ({ revalidatePath: jest.fn() }));

import { deleteSegmentV2Action, saveSegmentV2Action } from "../actions";

const ID = "SEG-4f1c9a0b2d3e5f67";
const INPUT = {
  id: ID,
  create: true,
  name: "Hà Nội cart builders",
  description: "",
  conditions: { groups: [{ conditions: [{ type: "profile_property", field: "city", op: "IN", value: ["Hà Nội"] }] }] },
};

beforeEach(() => {
  mockAssertSession.mockReset().mockResolvedValue({ userId: "u-lan", role: "editor" });
  mockPreview.mockReset().mockResolvedValue(true);
  mockSave.mockReset().mockResolvedValue({ saved: true, id: ID });
  mockDelete.mockReset().mockResolvedValue(undefined);
  jest.spyOn(console, "error").mockImplementation(() => {});
});

describe("saveSegmentV2Action (SEG-FR-01, SEG-NFR-02)", () => {
  it("saves as the signed-in editor, who needs no admin role", async () => {
    await expect(saveSegmentV2Action(INPUT)).resolves.toEqual({ saved: true, id: ID });
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ id: ID, name: "Hà Nội cart builders" }), "u-lan", []);
  });

  it("returns the active journeys to confirm and writes nothing (SEG-FR-07)", async () => {
    const use = { campaignId: "CAMP-A", campaignName: "Cart rescue", status: "active", kinds: ["entry_trigger"], ownerId: null };
    mockSave.mockResolvedValue({ saved: false, confirm: [use] });

    await expect(saveSegmentV2Action({ ...INPUT, create: false }, ["CAMP-B", 7])).resolves.toEqual({ confirm: [use] });
    expect(mockSave.mock.calls[0][2]).toEqual(["CAMP-B"]);
  });

  it("writes nothing without a session", async () => {
    mockAssertSession.mockRejectedValue(new Error("Unauthorized"));

    await expect(saveSegmentV2Action(INPUT)).resolves.toHaveProperty("error");
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("writes nothing for a viewer without preview access", async () => {
    mockPreview.mockResolvedValue(false);

    await expect(saveSegmentV2Action(INPUT)).resolves.toHaveProperty("error");
    expect(mockSave).not.toHaveBeenCalled();
  });
});

describe("deleteSegmentV2Action (SEG-FR-04)", () => {
  it("deletes by id", async () => {
    await expect(deleteSegmentV2Action(ID)).resolves.toEqual({ deleted: true });
    expect(mockDelete).toHaveBeenCalledWith(ID);
  });

  it("deletes nothing without a session or for a bad id", async () => {
    await expect(deleteSegmentV2Action("nope")).resolves.toHaveProperty("error");
    mockAssertSession.mockRejectedValue(new Error("Unauthorized"));
    await expect(deleteSegmentV2Action(ID)).resolves.toHaveProperty("error");
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
