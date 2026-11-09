import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Segment, SegmentId } from "shared/lib/segments";
import { SegmentsView, type SegmentsViewProps } from "../SegmentsView";

const refresh = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const segment: Segment = {
  id: "SEG-4f1c9a0b2d3e5f67" as SegmentId,
  name: "Hanoi cart builders",
  description: "Hanoi shoppers who keep adding to cart",
  conditions: {
    groups: [
      { conditions: [{ type: "profile_property", field: "city", op: "IN", value: ["Hanoi"] }] },
      {
        conditions: [{
          type: "behavior", event: "add_to_cart", measure: "COUNT",
          window: { value: 7, unit: "DAYS" }, op: ">=", value: 3, metric_id: "m_0123456789abcdef",
        }],
      },
    ],
  },
  updatedAt: null,
  usedBy: [
    { campaignId: "CAMP-A", campaignName: "Cart rescue", status: "active", kinds: ["entry_trigger"], ownerId: null },
    { campaignId: "CAMP-B", campaignName: "VIP push", status: "active", kinds: ["condition"], ownerId: null },
  ],
};

function renderView(props: Partial<SegmentsViewProps> = {}) {
  const saveSegment = jest.fn<ReturnType<SegmentsViewProps["saveSegment"]>, Parameters<SegmentsViewProps["saveSegment"]>>();
  const deleteSegment = jest.fn<ReturnType<SegmentsViewProps["deleteSegment"]>, Parameters<SegmentsViewProps["deleteSegment"]>>();
  render(
    <SegmentsView
      segments={[segment]}
      events={[{ id: "ue_cart", name: "add_to_cart", label: "Add to cart", fields: [] }]}
      saveSegment={saveSegment}
      deleteSegment={deleteSegment}
      {...props}
    />,
  );
  return { saveSegment, deleteSegment };
}

beforeAll(() => {
  // jsdom has no Web Animations API, which the dialog's scroll area calls.
  Element.prototype.getAnimations ??= () => [];
});

beforeEach(() => refresh.mockClear());

describe("SegmentsView", () => {
  it("lists each segment with its name, description, and the campaigns that use it", () => {
    renderView();

    const row = screen.getByRole("row", { name: /Hanoi cart builders/ });
    expect(within(row).getByText("Hanoi shoppers who keep adding to cart")).toBeInTheDocument();
    expect(within(row).getByText("Cart rescue · active")).toBeInTheDocument();
    expect(within(row).getByText("VIP push · active")).toBeInTheDocument();
  });

  it("names both active campaigns when the marketer opens the segment to edit (SEG-FR-07)", async () => {
    renderView();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Cart rescue \(active\), VIP push \(active\)/)).toBeInTheDocument();
    expect(within(dialog).getByRole("region", { name: "Group 2" })).toBeInTheDocument();
  });

  it("confirms an edit that active campaigns use, naming them, and saves with each one confirmed", async () => {
    const { saveSegment } = renderView();
    saveSegment
      .mockResolvedValueOnce({ confirm: segment.usedBy })
      .mockResolvedValueOnce({ success: true, id: segment.id });

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Save segment" }));

    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText(/Cart rescue \(active\), VIP push \(active\)/)).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: "Save change" }));

    await waitFor(() => expect(saveSegment).toHaveBeenCalledTimes(2));
    expect(saveSegment.mock.calls[0][1]).toEqual([]);
    expect(saveSegment.mock.calls[1][1]).toEqual(["CAMP-A", "CAMP-B"]);
    expect(saveSegment.mock.calls[1][0]).toMatchObject({
      id: segment.id,
      conditions: { groups: [
        { conditions: [{ type: "profile_property", field: "city", op: "IN", value: ["Hanoi"] }] },
        { conditions: [{ type: "behavior", event: "add_to_cart", measure: "COUNT", window: { value: 7, unit: "DAYS" }, op: ">=", value: 3 }] },
      ] },
    });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("shows a refused save and keeps what was typed", async () => {
    const { saveSegment } = renderView({ segments: [] });
    saveSegment.mockResolvedValueOnce({ error: "Group 1, condition 1: IN needs a list of at least one value." });

    fireEvent.click(screen.getByRole("button", { name: /New segment/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Da Nang VIPs" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save segment" }));

    expect(await within(dialog).findByText("Group 1, condition 1: IN needs a list of at least one value.")).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("Da Nang VIPs");
  });

  it("sends the id it made when the editor opened with every try of a new segment, so a retry writes one row", async () => {
    const { saveSegment } = renderView({ segments: [] });
    saveSegment.mockResolvedValue({ error: "Failed to save the segment." });

    fireEvent.click(screen.getByRole("button", { name: /New segment/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save segment" }));
    await waitFor(() => expect(saveSegment).toHaveBeenCalledTimes(1));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save segment" }));
    await waitFor(() => expect(saveSegment).toHaveBeenCalledTimes(2));

    const [first, second] = saveSegment.mock.calls.map(([input]) => input as { id: string; create: boolean });
    expect(first).toMatchObject({ id: expect.stringMatching(/^SEG-[0-9a-f]{16}$/), create: true });
    expect(second.id).toBe(first.id);
  });

  it("shows a refused delete that names the campaigns", async () => {
    const { deleteSegment } = renderView();
    deleteSegment.mockResolvedValueOnce({
      error: "The segment cannot be deleted while campaigns use it: Winback (paused).",
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("The segment cannot be deleted while campaigns use it: Winback (paused).")).toBeInTheDocument();
    expect(deleteSegment).toHaveBeenCalledWith(segment.id);
  });
});
