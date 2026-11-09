import { render, screen } from "@testing-library/react";

const mockViewerReach = jest.fn();
const mockLoadCatalog = jest.fn();
const mockNotFound = Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });

jest.mock("../../../../../src/widgets/v2-shell/model/viewer", () => ({ viewerReach: () => mockViewerReach() }));
jest.mock("../../../../../src/features/journeys/model/catalog", () => ({ loadCatalogEvents: () => mockLoadCatalog() }));
jest.mock("../../../../../src/features/journeys/model/actions", () => ({ createDraftAction: jest.fn() }));
jest.mock("next/navigation", () => ({
  notFound: () => {
    throw mockNotFound;
  },
  useRouter: () => ({ push: jest.fn() }),
}));

import V2NewJourneyPage from "../page";

const MODEL_ENV = ["OPENAI_API_KEY", "OPENAI_API_BASE", "LLM_MODEL"] as const;

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadCatalog.mockResolvedValue([{ name: "com.acme/add_to_cart", label: "Added to cart" }]);
  for (const name of MODEL_ENV) delete process.env[name];
});

describe("/v2/journeys/new (JBD-FR-29)", () => {
  it("sends a visitor without a session to sign in and reads no catalog", async () => {
    const redirect = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/login;307;" });
    mockViewerReach.mockRejectedValue(redirect);

    await expect(V2NewJourneyPage()).rejects.toBe(redirect);
    expect(mockLoadCatalog).not.toHaveBeenCalled();
  });

  it("is not found for a viewer the preview stage does not let through, before it reads anything (SHL-FR-22)", async () => {
    mockViewerReach.mockResolvedValue({ role: "editor", preview: false });

    await expect(V2NewJourneyPage()).rejects.toBe(mockNotFound);
    expect(mockLoadCatalog).not.toHaveBeenCalled();
  });

  it("offers Start blank, Describe it, and the five templates when a model is configured", async () => {
    mockViewerReach.mockResolvedValue({ role: "editor", preview: true });
    for (const name of MODEL_ENV) process.env[name] = "set";
    render(await V2NewJourneyPage());

    expect(screen.getByRole("heading", { level: 1, name: "Create journey" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start blank" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Describe it" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Use template" })).toHaveLength(5);
  });

  it("leaves out Describe it when no model is configured", async () => {
    mockViewerReach.mockResolvedValue({ role: "admin", preview: true });
    render(await V2NewJourneyPage());

    expect(screen.queryByRole("heading", { name: "Describe it" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start blank" })).toBeInTheDocument();
  });
});
