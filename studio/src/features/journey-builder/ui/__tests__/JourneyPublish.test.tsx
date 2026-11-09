import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { CART_ROOT, EVENTS } from "../../model/__fixtures__/cart";
import type { SaveDraft } from "../../model/useAutosave";
import { JourneyBuilder, type PublishDraft } from "../JourneyBuilder";

jest.mock("../../../journeys/model/actions", () => ({ saveDraftAction: jest.fn(), publishDraftAction: jest.fn() }));
const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const DRAFT = { id: "CAMP-1", name: "Abandoned cart", description: "", version: 3, root: CART_ROOT, savedAt: Date.UTC(2026, 10, 8, 3, 42), events: EVENTS };

// The cart draft, with the wait naming an event the catalog lacks.
const UNKNOWN_EVENT = JSON.parse(JSON.stringify(CART_ROOT).replace('"com.acme/order_completed"', '"com.acme/refund"'));

function open({ root = CART_ROOT, save = jest.fn(), publish = jest.fn() }: { root?: Record<string, unknown>; save?: SaveDraft; publish?: PublishDraft } = {}) {
  return render(<JourneyBuilder draft={{ ...DRAFT, root }} publish={publish} save={save} />);
}

async function settle(ms = 0) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

function openReview() {
  fireEvent.click(screen.getByRole("button", { name: "Publish" }));
  return screen.getByRole("dialog");
}

// jsdom has no Web Animations API, which the dialog's scroll area calls.
beforeAll(() => {
  Element.prototype.getAnimations ??= () => [];
});

beforeEach(() => {
  jest.useFakeTimers();
  push.mockReset();
});
afterEach(() => jest.useRealTimers());

describe("checklist", () => {
  it("says nothing blocks publishing on a valid journey", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: /^Checklist: nothing blocks publishing/ }));
    const drawer = screen.getByRole("complementary", { name: "Checklist" });
    expect(drawer).toHaveTextContent("Nothing blocks publishing");
    expect(drawer).toHaveTextContent("No problems found.");
  });

  it("lists a blocking problem under its step, and Go to selects that step", () => {
    open({ root: UNKNOWN_EVENT });
    fireEvent.click(screen.getByRole("button", { name: "Checklist: 1 problem blocks publishing, 0 warnings" }));
    const drawer = screen.getByRole("complementary", { name: "Checklist" });
    expect(within(drawer).getByRole("heading", { name: "Wait for com.acme/refund" })).toBeInTheDocument();
    expect(drawer).toHaveTextContent("Blocks");
    expect(drawer).toHaveTextContent("com.acme/refund is not in your events.");

    fireEvent.click(within(drawer).getByRole("button", { name: "Go to" }));
    expect(screen.queryByRole("complementary", { name: "Checklist" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Wait for com.acme\/refund/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("complementary", { name: "Step settings" })).toBeInTheDocument();
  });
});

describe("review and publish", () => {
  it("keeps Publish journey disabled while a blocking problem remains", () => {
    const publish = jest.fn();
    open({ root: UNKNOWN_EVENT, publish });
    const dialog = openReview();
    expect(dialog).toHaveTextContent("Not in your events: com.acme/refund.");
    expect(dialog).toHaveTextContent("Fix the blocking problem first.");
    const confirm = within(dialog).getByRole("button", { name: "Publish journey" });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(publish).not.toHaveBeenCalled();
  });

  it("describes the journey and its passed checks", () => {
    open();
    const dialog = openReview();
    expect(within(dialog).getByRole("heading", { name: "Publish “Abandoned cart”?" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Starts when someone does Added to cart. 7 steps. Sends 1 push and 1 SMS.");
    expect(dialog).toHaveTextContent("Every event the journey uses is in your events: Added to cart, Order completed.");
    expect(dialog).toHaveTextContent("This list is not available yet.");
  });

  it("saves a pending edit first, then publishes the saved version and opens the journey", async () => {
    const order: string[] = [];
    const save = jest.fn<ReturnType<SaveDraft>, Parameters<SaveDraft>>(async () => {
      order.push("save");
      return { status: "saved", version: 4 };
    });
    const publish = jest.fn<ReturnType<PublishDraft>, Parameters<PublishDraft>>(async () => {
      order.push("publish");
      return { status: "published", campaignId: "CAMP-1" };
    });
    open({ save, publish });
    fireEvent.change(screen.getByRole("textbox", { name: "Journey name" }), { target: { value: "Giỏ hàng" } });

    fireEvent.click(within(openReview()).getByRole("button", { name: "Publish journey" }));
    expect(publish).not.toHaveBeenCalled();
    await settle(1000);
    await settle();

    expect(order).toEqual(["save", "publish"]);
    expect(publish).toHaveBeenCalledWith({ draftId: "CAMP-1", version: 4, asNewJourney: false });
    expect(push).toHaveBeenCalledWith("/v2/journeys/CAMP-1");
  });

  it("offers Publish as a new journey on a collision, and opens the new journey", async () => {
    const publish = jest
      .fn<ReturnType<PublishDraft>, Parameters<PublishDraft>>()
      .mockResolvedValueOnce({ status: "collision" })
      .mockResolvedValueOnce({ status: "published", campaignId: "CAMP-2" });
    open({ publish });
    const dialog = openReview();
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish journey" }));
    await settle();

    expect(within(dialog).getByRole("alert")).toHaveTextContent("A journey with this id was published somewhere else.");
    expect(push).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish as a new journey" }));
    await settle();

    expect(publish).toHaveBeenLastCalledWith({ draftId: "CAMP-1", version: 3, asNewJourney: true });
    expect(push).toHaveBeenCalledWith("/v2/journeys/CAMP-2");
  });

  it.each([
    [{ status: "draft_missing" as const }, "This draft no longer exists."],
    [{ status: "stale" as const, version: 5 }, "This draft changed somewhere else."],
    [{ error: "Failed to publish the journey." }, "Failed to publish the journey."],
  ])("shows %j as a refusal and stays on the builder", async (result, message) => {
    open({ publish: jest.fn().mockResolvedValue(result) });
    const dialog = openReview();
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish journey" }));
    await settle();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(message);
    expect(push).not.toHaveBeenCalled();
  });

  it("stops when the pending edit fails to save", async () => {
    const publish = jest.fn();
    open({ save: jest.fn().mockResolvedValue({ error: "down" }), publish });
    fireEvent.change(screen.getByRole("textbox", { name: "Journey name" }), { target: { value: "Giỏ hàng" } });
    const dialog = openReview();
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish journey" }));
    await settle(1000);
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Your last edit is not saved.");
    expect(publish).not.toHaveBeenCalled();
  });
});
