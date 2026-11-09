import { render, screen } from "@testing-library/react";

jest.mock("../../../../src/features/segments/model/server", () => ({ loadSegmentRows: () => new Promise(() => {}) }));
jest.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
jest.mock("../../../../src/features/segments/model/actions", () => ({ deleteSegmentV2Action: jest.fn() }));
const reach = jest.fn();
jest.mock("../../../../src/widgets/v2-shell/model/viewer", () => ({ viewerReach: () => reach() }));

import V2SegmentsPage from "../page";

async function renderPage(preview: boolean) {
  reach.mockResolvedValue({ role: "editor", preview });
  render(await V2SegmentsPage({ searchParams: Promise.resolve({}) }));
}

describe("/v2/segments (SEG-FR-01)", () => {
  it("offers New segment to a preview viewer", async () => {
    await renderPage(true);

    expect(screen.getByRole("link", { name: /New segment/ })).toHaveAttribute("href", "/v2/segments/new");
    expect(screen.queryByRole("link", { name: /Manage in classic studio/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Segments" })).toBeInTheDocument();
  });

  it("sends a viewer without preview access to the classic studio, and says why", async () => {
    await renderPage(false);

    expect(screen.getByRole("link", { name: /Manage in classic studio/ })).toHaveAttribute("href", "/segments");
    expect(screen.queryByRole("link", { name: /New segment/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Creating and editing segments here is in preview\./)).toBeInTheDocument();
  });

  it("shows the table skeleton while the segments load", async () => {
    await renderPage(true);

    expect(screen.getByLabelText("Loading")).toHaveAttribute("aria-busy", "true");
  });
});
