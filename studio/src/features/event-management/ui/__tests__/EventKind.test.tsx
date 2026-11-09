import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { UserEventPage, UserEventSummary } from "@/app/types";
import ManageEventsView from "../ManageEventsView";
import {
  createUserEventWithFieldsAction,
  deleteUserEventFieldAction,
  getUserEventFieldsAction,
  updateUserEventAction,
  updateUserEventFieldAction,
} from "@/app/actions";

jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh: jest.fn() }) }));
jest.mock("@/app/actions", () => ({
  createUserEventWithFieldsAction: jest.fn(),
  deleteUserEventFieldAction: jest.fn(),
  getUserEventFieldsAction: jest.fn(),
  updateUserEventAction: jest.fn(),
  updateUserEventFieldAction: jest.fn(),
  setUserEventFieldRequiredAction: jest.fn(),
  setUserEventSchemaEnforcementAction: jest.fn(),
  setUserEventStatusAction: jest.fn(),
}));

const event = (name: string, changes: Partial<UserEventSummary> = {}): UserEventSummary => ({
  id: `ue_${name}`,
  name,
  label: name,
  fieldCount: 2,
  enforceSchema: false,
  eventKind: { kind: "person" },
  status: "active",
  ...changes,
});
const page = (...events: UserEventSummary[]): UserEventPage => ({ events, nextCursor: null });
const field = (value: string, dataType = "string") => ({ value, label: value, dataType });

// jsdom has no Web Animations API, which the dialog's scroll area calls.
beforeAll(() => {
  Element.prototype.getAnimations ??= () => [];
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(getUserEventFieldsAction).mockResolvedValue({
    fields: [field("product", "json"), field("product.id"), field("product.price", "number")],
  });
});
afterEach(() => jest.restoreAllMocks());

// A Base UI select item commits a mouse click only after a pointerdown on it.
async function chooseItemKey(path: string) {
  fireEvent.click(screen.getByRole("combobox", { name: "Item key" }));
  const option = await screen.findByRole("option", { name: path });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option);
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Item key" })).toHaveTextContent(path));
}

describe("creating an event with a kind", () => {
  async function openCreate(payload?: string) {
    render(<ManageEventsView initialPage={page()} />);
    fireEvent.click(screen.getByRole("button", { name: "Create Event" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("System Name"), { target: { value: "price_drop" } });
    fireEvent.change(within(dialog).getByLabelText("Display Name"), { target: { value: "Price drop" } });
    if (payload) {
      fireEvent.click(within(dialog).getByRole("tab", { name: "JSON Payload" }));
      fireEvent.change(within(dialog).getByLabelText("Event Attributes JSON"), { target: { value: payload } });
    }
    return dialog;
  }
  const save = () => fireEvent.click(screen.getByRole("button", { name: "Save Event & Attributes" }));

  it("creates a person event by default", async () => {
    jest.mocked(createUserEventWithFieldsAction).mockResolvedValueOnce({ success: true, eventId: "ue_new" });
    const dialog = await openCreate();

    expect(within(dialog).getByRole("radio", { name: /Person/ })).toBeChecked();
    expect(within(dialog).queryByRole("combobox", { name: "Item key" })).not.toBeInTheDocument();
    save();

    await waitFor(() =>
      expect(createUserEventWithFieldsAction).toHaveBeenCalledWith("price_drop", "Price drop", "", { kind: "person" }, []),
    );
  });

  it("does not send a business event without an item key, and shows the error on the item key", async () => {
    const dialog = await openCreate('{"product": {"id": "SKU-1"}}');

    fireEvent.click(within(dialog).getByRole("radio", { name: /Business/ }));
    save();

    const itemKey = within(dialog).getByRole("combobox", { name: "Item key" });
    expect(await within(dialog).findByText("Item key is required for a business event.")).toBeInTheDocument();
    expect(itemKey).toHaveAttribute("aria-invalid", "true");
    expect(itemKey).toHaveAccessibleDescription("Item key is required for a business event.");
    expect(itemKey).toHaveFocus();
    expect(createUserEventWithFieldsAction).not.toHaveBeenCalled();
  });

  it("sends a business event with the item key the admin chose", async () => {
    jest.mocked(createUserEventWithFieldsAction).mockResolvedValueOnce({ success: true, eventId: "ue_new" });
    const dialog = await openCreate('{"product": {"id": "SKU-1"}}');

    fireEvent.click(within(dialog).getByRole("radio", { name: /Business/ }));
    await chooseItemKey("product.id");
    save();

    await waitFor(() =>
      expect(createUserEventWithFieldsAction).toHaveBeenCalledWith(
        "price_drop",
        "Price drop",
        "",
        { kind: "business", itemKey: "product.id" },
        expect.arrayContaining([expect.objectContaining({ fieldPath: "product.id" })]),
      ),
    );
  });

  it("clears the item key when its attribute leaves the draft", async () => {
    const dialog = await openCreate('{"product": {"id": "SKU-1"}}');
    fireEvent.click(within(dialog).getByRole("radio", { name: /Business/ }));
    await chooseItemKey("product.id");

    fireEvent.change(within(dialog).getByLabelText("Event Attributes JSON"), { target: { value: '{"product": {"sku": "SKU-1"}}' } });

    expect(within(dialog).getByRole("combobox", { name: "Item key" })).toHaveTextContent("Choose an attribute");
    save();
    expect(await within(dialog).findByText("Item key is required for a business event.")).toBeInTheDocument();
    expect(createUserEventWithFieldsAction).not.toHaveBeenCalled();
  });

  it("offers no item key until the event has an attribute", async () => {
    const dialog = await openCreate();

    fireEvent.click(within(dialog).getByRole("radio", { name: /Business/ }));

    const itemKey = within(dialog).getByRole("combobox", { name: "Item key" });
    expect(itemKey).toBeDisabled();
    expect(itemKey).toHaveTextContent("Add an attribute first");
  });

  it("keeps the kind and the item key when the server refuses the create", async () => {
    jest.mocked(createUserEventWithFieldsAction).mockResolvedValueOnce({
      error: 'An event with the system name "price_drop" already exists.',
    });
    const dialog = await openCreate('{"product": {"id": "SKU-1"}}');
    fireEvent.click(within(dialog).getByRole("radio", { name: /Business/ }));
    await chooseItemKey("product.id");

    save();

    expect(await within(dialog).findByText(/already exists/)).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /Business/ })).toBeChecked();
    expect(within(dialog).getByRole("combobox", { name: "Item key" })).toHaveTextContent("product.id");
  });
});

describe("editing an event's kind", () => {
  const openEdit = async (summary: UserEventSummary) => {
    render(<ManageEventsView initialPage={page(summary)} />);
    fireEvent.click(screen.getByRole("button", { name: `Edit ${summary.label}` }));
    return screen.findByRole("dialog");
  };
  const saveEvent = () => fireEvent.click(screen.getByRole("button", { name: "Save event" }));

  it("shows a business event's kind and item key as fixed, and saves them unchanged", async () => {
    jest.mocked(updateUserEventAction).mockResolvedValueOnce({ success: true });
    const dialog = await openEdit(event("price_drop", { eventKind: { kind: "business", itemKey: "product.id" } }));

    expect(within(dialog).getByRole("radio", { name: /Business/ })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /Business/ })).toHaveAttribute("aria-disabled", "true");
    expect(within(dialog).getByRole("radio", { name: /Person/ })).toHaveAttribute("aria-disabled", "true");
    const itemKey = within(dialog).getByRole("combobox", { name: "Item key" });
    expect(itemKey).toBeDisabled();
    expect(itemKey).toHaveTextContent("product.id");
    expect(within(dialog).getByText("Fixed once the event is business.")).toBeInTheDocument();
    expect(getUserEventFieldsAction).not.toHaveBeenCalled();

    saveEvent();

    await waitFor(() =>
      expect(updateUserEventAction).toHaveBeenCalledWith("ue_price_drop", "price_drop", "", {
        kind: "business",
        itemKey: "product.id",
      }),
    );
  });

  it("lets a person event become business only with an item key from its attributes", async () => {
    jest.mocked(updateUserEventAction).mockResolvedValueOnce({ success: true });
    const dialog = await openEdit(event("view_product"));
    await waitFor(() => expect(within(dialog).getByRole("radio", { name: /Business/ })).not.toHaveAttribute("aria-disabled"));

    fireEvent.click(within(dialog).getByRole("radio", { name: /Business/ }));
    saveEvent();

    expect(await within(dialog).findByText("Item key is required for a business event.")).toBeInTheDocument();
    expect(updateUserEventAction).not.toHaveBeenCalled();

    await chooseItemKey("product.id");
    saveEvent();

    await waitFor(() =>
      expect(updateUserEventAction).toHaveBeenCalledWith("ue_view_product", "view_product", "", {
        kind: "business",
        itemKey: "product.id",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByText("Item key: product.id")).toBeInTheDocument();
  });

  it("keeps Business unavailable until the attributes load, and offers Retry when they fail", async () => {
    jest.mocked(getUserEventFieldsAction).mockResolvedValueOnce({ error: "Failed to load event attributes." });
    const dialog = await openEdit(event("view_product"));

    const retry = await within(dialog).findByRole("button", { name: "Retry" });
    expect(within(dialog).getByRole("radio", { name: /Business/ })).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(retry);

    await waitFor(() => expect(within(dialog).getByRole("radio", { name: /Business/ })).not.toHaveAttribute("aria-disabled"));
  });

  it("shows the server's refusal in the dialog and keeps what the admin chose", async () => {
    const refusal = [
      'Can\'t change the kind of "view_product" to business: these campaigns use it. Remove these uses first.',
      "- Spring sale (active), node setup-1",
    ].join("\n");
    jest.mocked(updateUserEventAction).mockResolvedValueOnce({ error: refusal });
    const dialog = await openEdit(event("view_product"));
    await waitFor(() => expect(within(dialog).getByRole("radio", { name: /Business/ })).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(within(dialog).getByRole("radio", { name: /Business/ }));
    await chooseItemKey("product.id");

    saveEvent();

    expect(await within(dialog).findByText(/Spring sale \(active\), node setup-1/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(within(dialog).getByRole("radio", { name: /Business/ })).toBeChecked();
    expect(within(dialog).getByRole("combobox", { name: "Item key" })).toHaveTextContent("product.id");
  });
});

describe("the event list", () => {
  it("shows each event's kind and a business event's item key", () => {
    render(
      <ManageEventsView
        initialPage={page(
          event("price_drop", { eventKind: { kind: "business", itemKey: "product.id" } }),
          event("view_product"),
        )}
      />,
    );

    const rows = screen.getAllByRole("row");
    expect(within(rows[0]).getByRole("columnheader", { name: "Kind" })).toBeInTheDocument();
    expect(within(rows[1]).getByText("Business")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Item key: product.id")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Person")).toBeInTheDocument();
    expect(within(rows[2]).queryByText(/Item key:/)).not.toBeInTheDocument();
  });
});

describe("the item key in the attribute outline (CAT-FR-17)", () => {
  async function expandPriceDrop() {
    render(
      <ManageEventsView
        initialPage={page(event("price_drop", { fieldCount: 3, eventKind: { kind: "business", itemKey: "product.id" } }))}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand price_drop" }));
    await screen.findByRole("button", { name: "Delete product.id" });
  }

  it("marks the item key and locks deleting it and its parent, but not a sibling", async () => {
    jest.spyOn(window, "confirm").mockReturnValue(true);
    await expandPriceDrop();

    expect(screen.getByText("Item key")).toBeInTheDocument();
    const deleteItemKey = screen.getByRole("button", { name: "Delete product.id" });
    const deleteParent = screen.getByRole("button", { name: "Delete product" });
    expect(deleteItemKey).toHaveAttribute("aria-disabled", "true");
    expect(deleteItemKey).toHaveAccessibleDescription("Item key. It cannot be renamed or deleted.");
    expect(deleteParent).toHaveAttribute("aria-disabled", "true");
    expect(deleteParent).toHaveAccessibleDescription("Holds the item key product.id.");
    expect(screen.getByRole("button", { name: "Delete product.price" })).not.toHaveAttribute("aria-disabled");

    fireEvent.click(deleteItemKey);
    fireEvent.click(deleteParent);

    expect(window.confirm).not.toHaveBeenCalled();
    expect(deleteUserEventFieldAction).not.toHaveBeenCalled();
  });

  it("locks renaming the item key and its parent, and still saves a new label", async () => {
    jest.mocked(updateUserEventFieldAction).mockResolvedValueOnce({ success: true });
    await expandPriceDrop();

    fireEvent.click(screen.getByRole("button", { name: "Edit product" }));
    expect(screen.getByLabelText("Attribute key for product")).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: "Edit product.id" }));
    const key = screen.getByLabelText("Attribute key for product.id");
    expect(key).toHaveAttribute("readonly");
    expect(key).toHaveAttribute("aria-disabled", "true");
    expect(key).toHaveAccessibleDescription("Item key. It cannot be renamed or deleted.");
    fireEvent.change(screen.getByLabelText("Display name for product.id"), { target: { value: "SKU" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateUserEventFieldAction).toHaveBeenCalledWith(
        "ue_price_drop",
        "product.id",
        expect.objectContaining({ fieldPath: "product.id", displayName: "SKU" }),
      ),
    );
  });
});
