import { render, screen } from "@testing-library/react";

const mockRequireViewer = jest.fn();
const mockViewerReach = jest.fn();
const mockLoadPublishedJourneys = jest.fn();
const mockListMyDrafts = jest.fn();

jest.mock("../../../../src/widgets/v2-shell/model/viewer", () => ({
  requireViewer: () => mockRequireViewer(),
  viewerReach: () => mockViewerReach(),
}));
jest.mock("../../../../src/features/journey-analytics/model/server", () => ({
  loadPublishedJourneys: (...args: unknown[]) => mockLoadPublishedJourneys(...args),
}));
jest.mock("../../../../src/features/journeys/model/drafts", () => ({ listMyDrafts: (...args: unknown[]) => mockListMyDrafts(...args) }));
jest.mock("../../../../src/features/journeys/model/actions", () => ({}));
jest.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import V2JourneysPage from "../page";

const LAN = { userId: "u-lan", email: "lan@example.com", role: "editor" };

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadPublishedJourneys.mockReturnValue(new Promise(() => {}));
});

describe("/v2/journeys", () => {
  it("sends a visitor without a session to sign in and reads no journey or draft", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });
    mockRequireViewer.mockRejectedValue(redirect);
    mockViewerReach.mockRejectedValue(redirect);

    await expect(V2JourneysPage()).rejects.toBe(redirect);
    expect(mockLoadPublishedJourneys).not.toHaveBeenCalled();
    expect(mockListMyDrafts).not.toHaveBeenCalled();
  });

  it("opens the v2 create page from Create journey for a preview viewer, and shows the skeleton while loading (JBD-FR-23)", async () => {
    mockRequireViewer.mockResolvedValue(LAN);
    mockViewerReach.mockResolvedValue({ role: "editor", preview: true });
    render(await V2JourneysPage());

    expect(screen.getByRole("heading", { level: 1, name: "Journeys" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create journey" })).toHaveAttribute("href", "/v2/journeys/new");
    expect(screen.getByLabelText("Loading")).toHaveAttribute("aria-busy", "true");
  });

  it("keeps Create journey in the classic builder for a viewer the preview does not let through (SHL-FR-22)", async () => {
    mockRequireViewer.mockResolvedValue(LAN);
    mockViewerReach.mockResolvedValue({ role: "editor", preview: false });
    render(await V2JourneysPage());

    expect(screen.getByRole("link", { name: "Create journey" })).toHaveAttribute("href", "/campaign/new");
  });
});
