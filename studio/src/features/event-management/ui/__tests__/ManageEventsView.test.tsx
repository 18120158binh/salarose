import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { UserEventPage, UserEventSummary } from "@/app/types";
import ManageEventsView from "../ManageEventsView";
import {
  createUserEventWithFieldsAction,
  getUserEventFieldsAction,
  getUserEventSummariesPageAction,
  setUserEventStatusAction,
  updateUserEventAction,
  updateUserEventFieldAction,
} from "@/app/actions";

const refresh = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
jest.mock("@/app/actions", () => ({
  createUserEventWithFieldsAction: jest.fn(),
  getUserEventFieldsAction: jest.fn(),
  getUserEventSummariesPageAction: jest.fn(),
  updateUserEventAction: jest.fn(),
  updateUserEventFieldAction: jest.fn(),
  setUserEventSchemaEnforcementAction: jest.fn(),
  setUserEventStatusAction: jest.fn(),
}));

const event = (name: string, changes: Partial<UserEventSummary> = {}): UserEventSummary => ({
  id: `ue_${name}`,
  name,
  label: name,
  fieldCount: 1,
  enforceSchema: false,
  eventKind: { kind: "person" },
  status: "active",
  ...changes,
});
const page = (events: UserEventSummary[], nextAfter: string | null = null): UserEventPage => ({
  events,
  nextCursor: nextAfter ? { eventName: nextAfter, id: `ue_${nextAfter}` } : null,
});

// jsdom has no Web Animations API, which the dialog's scroll area calls.
beforeAll(() => {
  Element.prototype.getAnimations ??= () => [];
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(window, "alert").mockImplementation(() => undefined);
  jest.mocked(getUserEventFieldsAction).mockResolvedValue({ fields: [] });
});
afterEach(() => jest.restoreAllMocks());

describe("the status badge (CAT-FR-07)", () => {
  it("shows each event's stored status", () => {
    render(<ManageEventsView initialPage={page([event("add_to_cart"), event("view_item", { status: "draft" })])} />);

    const rows = screen.getAllByRole("row");
    expect(within(rows[1]).getByText("Active")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Draft")).toBeInTheDocument();
  });
});

describe("creating an event", () => {
  function fillAndSubmit() {
    fireEvent.click(screen.getByRole("button", { name: "Create Event" }));
    fireEvent.change(screen.getByLabelText("System Name"), { target: { value: "Add To Cart" } });
    fireEvent.change(screen.getByLabelText("Display Name"), { target: { value: "Add to cart" } });
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Product added" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Event & Attributes" }));
  }

  it("keeps what the admin typed and shows the error when the create fails (CAT-FR-09)", async () => {
    jest.mocked(createUserEventWithFieldsAction).mockResolvedValueOnce({
      error: 'An event with the system name "add_to_cart" already exists.',
    });
    render(<ManageEventsView initialPage={page([])} />);

    fillAndSubmit();

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already exists");
    expect(screen.getByLabelText("System Name")).toHaveValue("add_to_cart");
    expect(screen.getByLabelText("Display Name")).toHaveValue("Add to cart");
    expect(screen.getByLabelText("Description")).toHaveValue("Product added");
    expect(window.alert).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("re-enables the form and shows an error when the call itself fails", async () => {
    jest.mocked(createUserEventWithFieldsAction).mockRejectedValueOnce(new Error("Failed to find Server Action"));
    render(<ManageEventsView initialPage={page([])} />);

    fillAndSubmit();

    expect(await within(await screen.findByRole("dialog")).findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save Event & Attributes" })).not.toBeDisabled();
    expect(screen.getByLabelText("Display Name")).toHaveValue("Add to cart");
  });

  it("clears the form and refreshes the list after a create succeeds", async () => {
    jest.mocked(createUserEventWithFieldsAction).mockResolvedValueOnce({ success: true, eventId: "ue_new" });
    render(<ManageEventsView initialPage={page([])} />);

    fillAndSubmit();

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

describe("rejected calls (CAT-KI-12)", () => {
  it("replaces the loading skeleton with a retry when loading the attributes fails", async () => {
    jest.mocked(getUserEventFieldsAction).mockRejectedValueOnce(new Error("Failed to fetch"));
    render(<ManageEventsView initialPage={page([event("add_to_cart")])} />);

    fireEvent.click(screen.getByRole("button", { name: "Expand add_to_cart" }));

    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("stops loading and shows an error when Load more fails", async () => {
    jest.mocked(getUserEventSummariesPageAction).mockRejectedValueOnce(new Error("Failed to fetch"));
    render(<ManageEventsView initialPage={page([event("a")], "a")} />);

    fireEvent.click(screen.getByRole("button", { name: "Load more events" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more events" })).not.toBeDisabled();
  });
});

describe("refreshing the list (CAT-KI-11)", () => {
  it("keeps the events loaded with Load more when the first page refreshes", async () => {
    jest.mocked(getUserEventSummariesPageAction).mockResolvedValueOnce({ page: page([event("c")], null) });
    const { rerender } = render(<ManageEventsView initialPage={page([event("a"), event("b")], "b")} />);

    fireEvent.click(screen.getByRole("button", { name: "Load more events" }));
    expect(await screen.findByText("c")).toBeInTheDocument();

    rerender(<ManageEventsView initialPage={page([event("a"), event("b")], "b")} />);

    expect(screen.getByText("c")).toBeInTheDocument();
  });
});

describe("editing an event (CAT-FR-05)", () => {
  it("saves a new display name and description", async () => {
    jest.mocked(updateUserEventAction).mockResolvedValueOnce({ success: true });
    render(
      <ManageEventsView initialPage={page([event("add_to_cart", { label: "Add to cart", description: "Old" })])} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit Add to cart" }));
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Added to cart" } });
    fireEvent.change(screen.getByLabelText("Event description"), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: "Save event" }));

    await waitFor(() => expect(updateUserEventAction).toHaveBeenCalledWith("ue_add_to_cart", "Added to cart", "New", { kind: "person" }));
    expect(await screen.findByText("Added to cart")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it("shows the system name but does not let it change", () => {
    render(<ManageEventsView initialPage={page([event("add_to_cart", { label: "Add to cart" })])} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit Add to cart" }));

    expect(screen.getByLabelText("System name")).toHaveAttribute("readonly");
  });
});

describe("editing an attribute's default value (CAT-FR-06)", () => {
  it("saves the default value with the attribute", async () => {
    jest.mocked(getUserEventFieldsAction).mockResolvedValue({
      fields: [{ value: "currency", label: "Currency", dataType: "string", exampleValue: "VND", defaultValue: "VND" }],
    });
    jest.mocked(updateUserEventFieldAction).mockResolvedValueOnce({ success: true });
    render(<ManageEventsView initialPage={page([event("add_to_cart")])} />);

    fireEvent.click(screen.getByRole("button", { name: "Expand add_to_cart" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit currency" }));
    const input = screen.getByLabelText("Default value for currency");
    expect(input).toHaveValue("VND");
    fireEvent.change(input, { target: { value: "USD" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(updateUserEventFieldAction).toHaveBeenCalledWith("ue_add_to_cart", "currency", {
        fieldPath: "currency",
        displayName: "Currency",
        dataType: "string",
        exampleValue: "VND",
        defaultValue: "USD",
      }),
    );
  });
});

describe("switching an event's status (CAT-FR-05)", () => {
  it("deactivates an active event and shows the new status", async () => {
    jest.mocked(setUserEventStatusAction).mockResolvedValueOnce({ success: true });
    render(<ManageEventsView initialPage={page([event("add_to_cart", { label: "Add to cart" })])} />);

    fireEvent.click(screen.getByRole("switch", { name: "Add to cart is active" }));

    await waitFor(() => expect(setUserEventStatusAction).toHaveBeenCalledWith("ue_add_to_cart", "inactive"));
    expect(await screen.findByText("Inactive")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Add to cart is active" })).not.toBeChecked();
  });

  it("keeps the status and shows the error when the change fails", async () => {
    jest.mocked(setUserEventStatusAction).mockRejectedValueOnce(new Error("Failed to fetch"));
    render(<ManageEventsView initialPage={page([event("add_to_cart", { label: "Add to cart", status: "inactive" })])} />);

    fireEvent.click(screen.getByRole("switch", { name: "Add to cart is active" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Inactive")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Add to cart is active" })).not.toBeChecked();
  });
});
