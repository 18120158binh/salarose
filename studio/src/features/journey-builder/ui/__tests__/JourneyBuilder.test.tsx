import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { CART_ROOT, EVENTS } from "../../model/__fixtures__/cart";
import type { SaveDraft } from "../../model/useAutosave";
import { JourneyBuilder } from "../JourneyBuilder";

jest.mock("../../../journeys/model/actions", () => ({ saveDraftAction: jest.fn() }));
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));

const DRAFT = { id: "CAMP-1", name: "Abandoned cart", description: "", version: 3, root: CART_ROOT, savedAt: Date.UTC(2026, 10, 8, 3, 42), events: EVENTS };

function open(save: SaveDraft) {
  return render(<JourneyBuilder draft={DRAFT} save={save} />);
}

async function settle(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe("JourneyBuilder", () => {
  it("draws the draft's steps as cards with their labels", () => {
    open(jest.fn());
    expect(screen.getByRole("button", { name: /^Wait for Order completed/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Push “Bạn quên giỏ hàng\?”/ })).toBeInTheDocument();
  });

  it("adds a palette step as a card and opens its panel", () => {
    open(jest.fn());
    const canvas = screen.getByRole("region", { name: "Journey canvas" });
    const before = within(canvas).getAllByRole("button", { name: /^SMS/ }).length;
    fireEvent.click(within(screen.getByRole("complementary", { name: "Steps you can add" })).getByRole("button", { name: "SMS" }));
    expect(within(canvas).getAllByRole("button", { name: /^SMS/ })).toHaveLength(before + 1);
    expect(screen.getByRole("complementary", { name: "Step settings" })).toBeInTheDocument();
  });

  it("autosaves one second after the last edit, then shows Saved", async () => {
    let resolve: (value: { status: "saved"; version: number }) => void = () => {};
    const save = jest.fn<ReturnType<SaveDraft>, Parameters<SaveDraft>>(() => new Promise<{ status: "saved"; version: number }>((r) => (resolve = r)));
    open(save);

    fireEvent.click(document.getElementById("step-sms")!);
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Đặt ngay" } });
    await settle(900);
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Đặt ngay nhé" } });
    await settle(1000);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({ id: "CAMP-1", version: 3, name: "Abandoned cart" });
    expect(JSON.stringify(save.mock.calls[0][0].root)).toContain("Đặt ngay nhé");
    expect(screen.getByRole("status")).toHaveTextContent("Saving");

    await act(async () => resolve({ status: "saved", version: 4 }));
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });

  it("shows Not saved with Retry when a save fails, and retries", async () => {
    const save = jest.fn<ReturnType<SaveDraft>, Parameters<SaveDraft>>().mockResolvedValueOnce({ error: "down" }).mockResolvedValue({ status: "saved", version: 4 });
    open(save);
    fireEvent.change(screen.getByRole("textbox", { name: "Journey name" }), { target: { value: "Giỏ hàng" } });
    await settle(1000);
    expect(screen.getByRole("status")).toHaveTextContent("Not saved.");

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle(1000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });

  it("offers Load latest and Keep mine when another tab saved first", async () => {
    const save = jest.fn<ReturnType<SaveDraft>, Parameters<SaveDraft>>().mockResolvedValue({
      status: "conflict",
      draft: { ...DRAFT, name: "Theirs", origin: "blank", version: 5, updatedAt: "2026-11-08T03:50:00Z" },
    });
    open(save);
    fireEvent.change(screen.getByRole("textbox", { name: "Journey name" }), { target: { value: "Mine" } });
    await settle(1000);

    expect(screen.getByRole("alert")).toHaveTextContent("This draft changed somewhere else.");
    await settle(5000);
    expect(save).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Load latest" }));
    expect(screen.getByRole("textbox", { name: "Journey name" })).toHaveValue("Theirs");
  });

  it("says Studio was updated when the save action is gone", async () => {
    const save = jest.fn<ReturnType<SaveDraft>, Parameters<SaveDraft>>().mockRejectedValue(new Error('Server Action "abc" was not found on the server.'));
    open(save);
    fireEvent.change(screen.getByRole("textbox", { name: "Journey name" }), { target: { value: "Mine" } });
    await settle(1000);
    expect(screen.getByRole("alert")).toHaveTextContent("Studio was updated. Reload to keep editing.");
  });

  it("removes a one-path step without asking", () => {
    open(jest.fn());
    fireEvent.click(screen.getByRole("button", { name: /^Wait 1 day/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove step" }));
    expect(screen.queryByRole("button", { name: /^Wait 1 day/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
});
