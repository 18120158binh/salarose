/** @jest-environment node */
const mockRequireViewer = jest.fn();
const mockViewerReach = jest.fn();
const mockGetMyDraft = jest.fn();
const mockGetUserEvents = jest.fn();

jest.mock("server-only", () => ({}));
jest.mock("../../../../widgets/v2-shell/model/viewer", () => ({
  requireViewer: () => mockRequireViewer(),
  viewerReach: () => mockViewerReach(),
}));
jest.mock("../../../journeys/model/drafts", () => ({ getMyDraft: (...args: unknown[]) => mockGetMyDraft(...args) }));
jest.mock("@/lib/db", () => ({ getUserEvents: () => mockGetUserEvents() }));

import { openDraft } from "../server";

const LAN = { userId: "u-lan", email: "lan@example.com", role: "editor" };
const STORED = { id: "CAMP-1", name: "Cart", description: "", origin: "blank", version: 2, updatedAt: "2026-11-08T03:42:00.000Z", root: { type: "setup" } };

beforeEach(() => {
  mockRequireViewer.mockReset().mockResolvedValue(LAN);
  mockViewerReach.mockReset().mockResolvedValue({ role: "editor", preview: true });
  mockGetMyDraft.mockReset().mockResolvedValue(STORED);
  mockGetUserEvents.mockReset().mockResolvedValue([{ id: "e1", name: "com.acme/add_to_cart", label: "Added to cart", fields: [] }]);
});

describe("openDraft", () => {
  it("sends a visitor without a session to sign in and reads no draft", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });
    mockRequireViewer.mockRejectedValue(redirect);
    await expect(openDraft("CAMP-1")).rejects.toBe(redirect);
    expect(mockGetMyDraft).not.toHaveBeenCalled();
  });

  it("opens nothing for a viewer without preview access, while the builder is at stage preview", async () => {
    mockViewerReach.mockResolvedValue({ role: "editor", preview: false });
    expect(await openDraft("CAMP-1")).toBeNull();
    expect(mockGetMyDraft).not.toHaveBeenCalled();
  });

  it("reads the draft as the signed-in viewer, so another user's draft reads as none", async () => {
    mockGetMyDraft.mockResolvedValue(null);
    expect(await openDraft("CAMP-1")).toBeNull();
    expect(mockGetMyDraft).toHaveBeenCalledWith("u-lan", "CAMP-1");
  });

  it("returns the draft with the catalog's events", async () => {
    expect(await openDraft("CAMP-1")).toMatchObject({
      id: "CAMP-1",
      version: 2,
      savedAt: Date.parse(STORED.updatedAt),
      events: [{ name: "com.acme/add_to_cart", label: "Added to cart" }],
    });
  });

  it("still opens the draft when the catalog fails to load", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {});
    mockGetUserEvents.mockRejectedValue(new Error("down"));
    expect(await openDraft("CAMP-1")).toMatchObject({ events: [] });
  });
});
