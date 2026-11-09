import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { notify } from "@/shared/ui/v2/toast";
import {
  addAttributesAction,
  deleteAttributeAction,
  deleteEventAction,
  setAttributeRequiredAction,
  setEventGateAction,
  updateAttributeAction,
} from "../../model/actions";
import type { EventDetailAttribute, FieldUses } from "../../model/eventDetail";
import { EventAttributeTable } from "../EventAttributeTable";
import { RetireOrDeleteCard, StrictCard } from "../EventDetailControls";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("../../model/actions", () => ({
  addAttributesAction: jest.fn(),
  deleteAttributeAction: jest.fn(),
  deleteEventAction: jest.fn(),
  setAttributeRequiredAction: jest.fn(),
  setEventGateAction: jest.fn(),
  setEventStatusAction: jest.fn(),
  updateAttributeAction: jest.fn(),
  updateEventDetailsAction: jest.fn(),
}));
jest.mock("@/shared/ui/v2/toast", () => ({ notify: jest.fn() }));

const ATTRIBUTES: EventDetailAttribute[] = [
  { path: "product", label: "Product", type: "json", required: false, example: null, defaultValue: null },
  { path: "product.price", label: "Price", type: "number", required: true, example: "1290000", defaultValue: null },
  { path: "quantity", label: "Quantity", type: "number", required: false, example: "1", defaultValue: "1" },
];

const PRICE_USES: FieldUses = {
  metrics: [{ id: "m1", displayName: "Cart value, last 30 days" }],
  campaigns: [{ name: "Cart abandonment", status: "active", nodeIds: ["n3"] }],
  segments: [],
};
const USES: Record<string, FieldUses> = { product: PRICE_USES, "product.price": PRICE_USES };

function table(canEdit = true) {
  return render(
    <EventAttributeTable attributes={ATTRIBUTES} canEdit={canEdit} eventId="ue_1" eventLabel="Added to cart" fieldUses={USES} strict={false} />,
  );
}

async function rowMenu(path: string, item: RegExp) {
  fireEvent.click(screen.getByRole("button", { name: `More changes to ${path}` }));
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

beforeAll(() => {
  Element.prototype.getAnimations ??= () => [];
});

beforeEach(() => jest.clearAllMocks());

describe("the Fields card (CAT-FR-10, CAT-FR-20)", () => {
  it("shows an editor the fields with their uses and no change offered", () => {
    table(false);

    expect(document.querySelector(`[data-path="product.price"]`)).toHaveTextContent("Price");
    expect(screen.getAllByText(/In use ·/)).toHaveLength(2);
    expect(document.querySelector(`[data-path="product.price"]`)).toHaveTextContent("Must be sent");
    expect(screen.queryByRole("button", { name: "Add field" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /More changes to/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add field inside/ })).not.toBeInTheDocument();
  });

  it("offers an admin Add field, Add field inside, and each row's changes", () => {
    table();

    expect(screen.getByRole("button", { name: "Add field" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add field inside quantity" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More changes to product.price" })).toBeInTheDocument();
  });
});

describe("Must be sent (CAT-FR-14)", () => {
  it("asks first, and cancelling leaves the field optional", async () => {
    table();

    await rowMenu("quantity", /Make it Must be sent/);
    const dialog = await screen.findByRole("alertdialog", { name: "Make quantity Must be sent?" });
    expect(dialog).toHaveTextContent("any API source with a key");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel, keep it optional" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(setAttributeRequiredAction).not.toHaveBeenCalled();
  });

  it("saves at once when a field becomes optional", async () => {
    jest.mocked(setAttributeRequiredAction).mockResolvedValue({ done: true });
    table();

    await rowMenu("product.price", /Make it optional/);

    await waitFor(() => expect(setAttributeRequiredAction).toHaveBeenCalledWith("ue_1", "product.price", false));
  });
});

describe("breaking changes (CAT-FR-11, CAT-FR-12, CAT-FR-19)", () => {
  it("refuses to delete a field in use without calling the server, and offers the safe way", async () => {
    table();

    await rowMenu("product.price", /Delete field/);
    const dialog = await screen.findByRole("alertdialog", { name: "Price can't be deleted while it's in use" });

    expect(dialog).toHaveTextContent("Cart value, last 30 days");
    expect(dialog).toHaveTextContent("Cart abandonment");
    expect(dialog).toHaveTextContent("THE SAFE WAY");
    expect(deleteAttributeAction).not.toHaveBeenCalled();
  });

  it("asks before deleting a field nothing uses", async () => {
    jest.mocked(deleteAttributeAction).mockResolvedValue({ done: true });
    table();

    await rowMenu("quantity", /Delete field/);
    const dialog = await screen.findByRole("alertdialog", { name: "Delete quantity?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete field" }));

    await waitFor(() => expect(deleteAttributeAction).toHaveBeenCalledWith("ue_1", "quantity"));
  });

  it("shows Safe for a label change and saves it at once", async () => {
    jest.mocked(updateAttributeAction).mockResolvedValue({ done: true });
    table();

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    const dialog = await screen.findByRole("dialog", { name: "Edit the field Price" });
    fireEvent.change(within(dialog).getByLabelText("Label marketers see"), { target: { value: "Unit price" } });
    expect(within(dialog).getByText("Safe change")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateAttributeAction).toHaveBeenCalledWith("ue_1", "product.price", expect.objectContaining({ label: "Unit price", path: "product.price" })),
    );
  });

  it("shows a rename of a field in use as refused and sends nothing", async () => {
    table();

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    const dialog = await screen.findByRole("dialog", { name: "Edit the field Price" });
    fireEvent.change(within(dialog).getByLabelText("Field name in the event"), { target: { value: "cost" } });
    expect(within(dialog).getByText("Breaking, refused")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alertdialog", { name: "Price can't be renamed while it's in use" })).toBeInTheDocument();
    expect(updateAttributeAction).not.toHaveBeenCalled();
  });

  it("shows the server's refusal when a use appeared after the page loaded", async () => {
    jest.mocked(deleteAttributeAction).mockResolvedValue({
      error: 'The attribute "quantity" is in use, so it cannot be deleted. Nothing changed.\n\nSegments:\n- Big carts (SEG-1)',
    });
    table();

    await rowMenu("quantity", /Delete field/);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete field" }));

    const refusal = await screen.findByRole("alertdialog", { name: "Quantity can't be deleted while it's in use" });
    expect(refusal).toHaveTextContent("- Big carts (SEG-1)");
  });

  it("warns before turning a field nothing uses into a group, then adds inside it", async () => {
    jest.mocked(addAttributesAction).mockResolvedValue({ done: true });
    table();

    fireEvent.click(screen.getByRole("button", { name: "Add field inside quantity" }));
    const form = await screen.findByRole("form", { name: "New field" });
    fireEvent.change(within(form).getByLabelText("Field name in the event"), { target: { value: "unit" } });
    expect(form).toHaveTextContent("quantity will become a group of fields");
    fireEvent.click(within(form).getByRole("button", { name: "Make it a group and add field" }));

    await waitFor(() =>
      expect(addAttributesAction).toHaveBeenCalledWith("ue_1", [expect.objectContaining({ path: "quantity.unit", type: "string" })]),
    );
  });

  it("refuses to add inside a field in use", async () => {
    table();

    fireEvent.click(screen.getByRole("button", { name: "Add field inside product.price" }));
    const form = await screen.findByRole("form", { name: "New field" });
    fireEvent.change(within(form).getByLabelText("Field name in the event"), { target: { value: "amount" } });

    expect(form).toHaveTextContent("so it can't become a group");
    expect(within(form).getByRole("button", { name: "Add field" })).toBeDisabled();
  });
});

describe("Strict checking (CAT-FR-13)", () => {
  it("asks first, names the required fields and the 7 days, and stays off when cancelled", async () => {
    render(<StrictCard canEdit id="ue_1" label="Added to cart" monitoringHref={null} on={false} required={["product.price"]} />);

    fireEvent.click(screen.getByRole("switch", { name: "Strict checking" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Turn on Strict checking for Added to cart?" });
    expect(confirm).toHaveTextContent("product.price");
    expect(confirm).toHaveTextContent("kept for 7 days in Monitoring › Dropped data");
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel, keep accepting all" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(setEventGateAction).not.toHaveBeenCalled();
  });

  it("keeps the stored state when the change fails", async () => {
    jest.mocked(setEventGateAction).mockResolvedValue({ error: "Event ue_1 not found." });
    render(<StrictCard canEdit id="ue_1" label="Added to cart" monitoringHref={null} on required={[]} />);

    fireEvent.click(screen.getByRole("switch", { name: "Strict checking" }));

    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "failed", description: "Event ue_1 not found." })));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Strict checking" })).toBeChecked());
  });

  it("shows an editor no switch", () => {
    render(<StrictCard canEdit={false} id="ue_1" label="Added to cart" monitoringHref={null} on required={[]} />);
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });
});

describe("Retire or delete (CAT-FR-08)", () => {
  it("refuses to delete an event with metrics, names them, and offers to hide it", async () => {
    render(
      <RetireOrDeleteCard
        active
        id="ue_1"
        label="Added to cart"
        uses={{ metrics: [{ id: "m1", displayName: "Carts today", measure: "Times performed" }], campaigns: [], segments: [] }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete event…" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Added to cart can't be deleted" });

    expect(dialog).toHaveTextContent("Carts today");
    expect(within(dialog).getByRole("button", { name: "Hide from builder" })).toBeInTheDocument();
    expect(deleteEventAction).not.toHaveBeenCalled();
  });

  it("deletes an event nothing uses after a confirmation", async () => {
    jest.mocked(deleteEventAction).mockResolvedValue({ done: true });
    render(<RetireOrDeleteCard active id="ue_1" label="Added to cart" uses={{ metrics: [], campaigns: [], segments: [] }} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete event…" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete event" }));

    await waitFor(() => expect(deleteEventAction).toHaveBeenCalledWith("ue_1"));
  });
});
