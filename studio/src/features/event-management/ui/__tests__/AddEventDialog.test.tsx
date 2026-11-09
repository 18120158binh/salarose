import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createEventAction } from "../../model/actions";
import { AddEventDialog } from "../AddEventDialog";

const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
jest.mock("../../model/actions", () => ({ createEventAction: jest.fn() }));

beforeAll(() => {
  Element.prototype.getAnimations ??= () => [];
});

beforeEach(() => jest.clearAllMocks());

async function open() {
  render(<AddEventDialog />);
  fireEvent.click(screen.getByRole("button", { name: /^Add event/ }));
  return screen.findByRole("dialog", { name: "Add event" });
}

function type(dialog: HTMLElement, label: string, value: string) {
  fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
}

function submit(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole("button", { name: "Add event" }));
}

describe("Add event (CAT-FR-18)", () => {
  it("offers no kind and sends none", async () => {
    jest.mocked(createEventAction).mockResolvedValue({ eventId: "ue_1" });
    const dialog = await open();

    expect(within(dialog).queryByRole("radio")).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Business/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("combobox", { name: /kind/i })).not.toBeInTheDocument();

    type(dialog, "Tracking name", "com.acme/add_to_cart");
    type(dialog, "Name marketers see", "Add to cart");
    submit(dialog);

    await waitFor(() => expect(createEventAction).toHaveBeenCalledTimes(1));
    const input = jest.mocked(createEventAction).mock.calls[0][0] as Record<string, unknown>;
    expect(input).not.toHaveProperty("kind");
    expect(input).not.toHaveProperty("itemKey");
  });
});

describe("the tracking name (CAT-FR-02, CAT-FR-21)", () => {
  it("starts with the vendor prefix and shows the saved form as the admin types", async () => {
    const dialog = await open();

    expect(within(dialog).getByLabelText("Tracking name")).toHaveValue("com.acme/");
    type(dialog, "Tracking name", "com.acme/Add To Cart");

    expect(within(dialog).getByText("Saved as", { exact: false })).toHaveTextContent("Saved as com.acme/add_to_cart");
  });
});

describe("stage preview (SHL-FR-22)", () => {
  it("marks the trigger and the dialog with the Preview badge", async () => {
    render(<AddEventDialog />);
    const trigger = screen.getByRole("button", { name: /^Add event/ });
    expect(trigger).toHaveTextContent("Preview");
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Add event" });

    expect(within(dialog).getByText("Preview")).toBeInTheDocument();
  });
});

describe("a sample payload (CAT-FR-03)", () => {
  it("sends one attribute per field, typed from its value", async () => {
    jest.mocked(createEventAction).mockResolvedValue({ eventId: "ue_1" });
    const dialog = await open();
    type(dialog, "Tracking name", "com.acme/add_to_cart");
    type(dialog, "Name marketers see", "Add to cart");

    fireEvent.click(within(dialog).getByRole("tab", { name: "Paste a sample event" }));
    fireEvent.change(await within(dialog).findByRole("textbox", { name: "Sample event" }), {
      target: { value: '{"product": {"id": "SKU-1", "price": 1}}' },
    });
    submit(dialog);

    await waitFor(() => expect(createEventAction).toHaveBeenCalledTimes(1));
    const { attributes } = jest.mocked(createEventAction).mock.calls[0][0] as { attributes: { path: string; type: string }[] };
    expect(attributes.map(({ path, type }) => ({ path, type }))).toEqual([
      { path: "product", type: "json" },
      { path: "product.id", type: "string" },
      { path: "product.price", type: "number" },
    ]);
  });
});

describe("a failed create (CAT-FR-09)", () => {
  it("shows the error and keeps every typed value", async () => {
    jest.mocked(createEventAction).mockResolvedValue({ error: 'An event with the system name "add_to_cart" already exists.' });
    const dialog = await open();
    type(dialog, "Tracking name", "com.acme/add_to_cart");
    type(dialog, "Name marketers see", "Add to cart");
    type(dialog, "What it means (optional)", "A shopper put a product in the cart.");

    submit(dialog);

    expect(await within(dialog).findByRole("alert")).toHaveTextContent('Not added. An event with the system name "add_to_cart" already exists. Everything you typed is kept.');
    expect(within(dialog).getByLabelText("Tracking name")).toHaveValue("com.acme/add_to_cart");
    expect(within(dialog).getByLabelText("Name marketers see")).toHaveValue("Add to cart");
    expect(within(dialog).getByLabelText("What it means (optional)")).toHaveValue("A shopper put a product in the cart.");
    expect(push).not.toHaveBeenCalled();
  });
});

describe("a tracking name the catalog already has (CAT-FR-02)", () => {
  it("names the event and links to it, so the admin can add fields there", async () => {
    jest.mocked(createEventAction).mockResolvedValue({
      error: 'An event with the system name "com.acme/order_completed" already exists.',
      existing: { id: "ue_7", label: "Order completed", name: "com.acme/order_completed" },
    });
    const dialog = await open();
    type(dialog, "Tracking name", "com.acme/order_completed");
    type(dialog, "Name marketers see", "Order completed");

    submit(dialog);

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(
      "Not added. The catalog already has com.acme/order_completed. Change the tracking name, or open Order completed to add fields to it. Everything you typed is kept.",
    );
    expect(within(alert).getByRole("link", { name: "open Order completed" })).toHaveAttribute("href", "/v2/data/events/ue_7");
    expect(within(dialog).getByLabelText("Tracking name")).toHaveValue("com.acme/order_completed");
  });
});

describe("a create that works", () => {
  it("opens the new event's detail page", async () => {
    jest.mocked(createEventAction).mockResolvedValue({ eventId: "ue_42" });
    const dialog = await open();
    type(dialog, "Tracking name", "com.acme/add_to_cart");
    type(dialog, "Name marketers see", "Add to cart");

    submit(dialog);

    await waitFor(() => expect(push).toHaveBeenCalledWith("/v2/data/events/ue_42"));
  });
});
