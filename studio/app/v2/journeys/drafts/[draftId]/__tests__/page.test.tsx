/** @jest-environment node */
import type { ReactElement } from "react";
import { renderToReadableStream } from "react-dom/server";

const mockOpenDraft = jest.fn();
jest.mock("../../../../../../src/features/journey-builder/model/server", () => ({
  openDraft: (...args: unknown[]) => mockOpenDraft(...args),
}));
jest.mock("../../../../../../src/features/journeys/model/actions", () => ({ saveDraftAction: jest.fn() }));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }) }));

import V2JourneyBuilderPage from "../page";

async function html(draftId: string): Promise<string> {
  const element: ReactElement = await V2JourneyBuilderPage({ params: Promise.resolve({ draftId }) });
  const errors: unknown[] = [];
  const stream = await renderToReadableStream(element, { onError: (error) => void errors.push(error) });
  await stream.allReady;
  expect(errors).toEqual([]);
  return new Response(stream).text();
}

beforeEach(() => mockOpenDraft.mockReset().mockResolvedValue(null));

describe("/v2/journeys/drafts/[draftId]", () => {
  it("opens the builder on the viewer's own draft", async () => {
    mockOpenDraft.mockResolvedValue({
      id: "CAMP-draft",
      name: "Abandoned cart",
      description: "",
      version: 1,
      root: { type: "setup", id: "start", label: "Start", description: "", triggerEventName: "", next: { type: "end" } },
      savedAt: Date.UTC(2026, 10, 8),
      events: [],
    });

    const page = await html("CAMP-draft");

    expect(mockOpenDraft).toHaveBeenCalledWith("CAMP-draft");
    expect(page).toContain("Journey canvas");
  });

  it("says the journey does not exist when the draft is not the viewer's to open", async () => {
    const page = await html("CAMP-other");

    expect(page).toContain("This journey does not exist.");
    expect(page).not.toContain("Journey canvas");
  });
});
