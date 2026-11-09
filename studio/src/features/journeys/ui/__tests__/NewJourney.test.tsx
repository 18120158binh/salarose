import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { templateByKey } from "../../model/templates";
import { describeFailure, EXAMPLES, NewJourney } from "../NewJourney";

const mockPush = jest.fn();
const mockCreate = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock("../../model/actions", () => ({ createDraftAction: (input: unknown) => mockCreate(input) }));
jest.mock("../../../../shared/ui/v2/toast", () => ({ notify: jest.fn() }));

const CATALOG = [
  { name: "com.acme/add_to_cart", label: "Added to cart" },
  { name: "com.acme/order_completed", label: "Order completed" },
  { name: "purchase", label: "Purchase" },
];

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: async () => body,
  });
}

beforeAll(() => {
  Element.prototype.getAnimations ??= () => [];
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue({ id: "CAMP-0000000000000001", version: 1 });
});

describe("Start blank", () => {
  it("makes a draft with one start step and origin blank, then opens it in the builder", async () => {
    render(<NewJourney aiConfigured={false} catalog={CATALOG} />);

    fireEvent.click(screen.getByRole("button", { name: "Start blank" }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/v2/journeys/drafts/CAMP-0000000000000001"));
    expect(mockCreate).toHaveBeenCalledWith({ name: "New journey", description: "", root: expect.objectContaining({ type: "setup" }), origin: "blank" });
  });
});

describe("Start from a template (JBD-FR-29)", () => {
  it("shows what each template needs", () => {
    render(<NewJourney aiConfigured={false} catalog={CATALOG} />);

    expect(screen.getByText("Added to cart, Order completed", { exact: false })).toBeInTheDocument();
  });

  it("prefills the events the catalog has, names the draft, and makes it with origin template:<key>", async () => {
    render(<NewJourney aiConfigured={false} catalog={CATALOG} />);
    const card = screen.getByRole("heading", { name: "Abandoned cart" }).closest("article")!;
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Use template" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Your event for Added to cart")).toHaveValue("com.acme/add_to_cart");
    expect(within(dialog).getByLabelText("Your event for Order completed")).toHaveValue("com.acme/order_completed");
    fireEvent.change(within(dialog).getByLabelText("Journey name"), { target: { value: "Abandoned cart, Hà Nội" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create draft" }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/v2/journeys/drafts/CAMP-0000000000000001"));
    expect(mockCreate).toHaveBeenCalledWith({
      name: "Abandoned cart, Hà Nội",
      description: "",
      root: templateByKey("cart")!.root,
      origin: "template:cart",
    });
  });

  it("makes the draft with an unmapped event and says publish stays blocked", async () => {
    render(<NewJourney aiConfigured={false} catalog={CATALOG.slice(0, 1)} />);
    const card = screen.getByRole("heading", { name: "Abandoned cart" }).closest("article")!;
    fireEvent.click(within(card as HTMLElement).getByRole("button", { name: "Use template" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Publishing stays blocked until every event is matched/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create draft" }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalled());
    expect(JSON.stringify(mockCreate.mock.calls[0][0].root)).toContain("com.acme/order_completed");
  });
});

describe("Describe it (AIG-FR-06)", () => {
  it("names only push or SMS in its examples", () => {
    for (const example of EXAMPLES) {
      expect(example).toMatch(/push|SMS/);
      expect(example).not.toMatch(/zalo/i);
    }
  });

  it("makes a draft with origin ai from the journey the route returns", async () => {
    const root = { type: "setup", id: "s", label: "Start", description: "", triggerEventName: "com.acme/add_to_cart", next: [] };
    respond(200, root);
    render(<NewJourney aiConfigured catalog={CATALOG} />);

    fireEvent.click(screen.getByRole("button", { name: EXAMPLES[0] }));
    fireEvent.click(screen.getByRole("button", { name: "Build journey" }));

    await waitFor(() => expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ root, origin: "ai" })));
    expect(global.fetch).toHaveBeenCalledWith("/api/generate-journey", expect.objectContaining({ method: "POST", body: JSON.stringify({ prompt: EXAMPLES[0] }) }));
    expect(mockPush).toHaveBeenCalledWith("/v2/journeys/drafts/CAMP-0000000000000001");
  });

  it("shows a refused request inline and makes no draft", async () => {
    respond(429, { error: "Too many AI generation requests. Try again later." }, { "Retry-After": "42" });
    render(<NewJourney aiConfigured catalog={CATALOG} />);

    fireEvent.change(screen.getByLabelText("What should this journey do?"), { target: { value: "Push people who add to cart" } });
    fireEvent.click(screen.getByRole("button", { name: "Build journey" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Too many requests. You can describe up to 10 journeys a minute. Try again in 42 seconds.");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("refuses a description over 2,000 characters before it sends anything", () => {
    render(<NewJourney aiConfigured catalog={CATALOG} />);

    fireEvent.change(screen.getByLabelText("What should this journey do?"), { target: { value: "a".repeat(2164) } });

    expect(screen.getByRole("alert")).toHaveTextContent("Keep it under 2,000 characters. Cut 164 to continue.");
    expect(screen.getByRole("button", { name: "Build journey" })).toBeDisabled();
  });

  it("reads a wait over a minute as the daily limit, and any other failure as could not build", () => {
    expect(describeFailure(429, "10800")).toEqual({ kind: "day" });
    expect(describeFailure(429, "42")).toEqual({ kind: "minute", retryAfter: 42 });
    expect(describeFailure(502, null)).toEqual({ kind: "failed" });
  });
});
