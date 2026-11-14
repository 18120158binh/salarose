import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { UserEventDef } from "shared/types";
import { newBehaviorCondition, newProfileCondition, type SegmentDraft } from "../../model/segmentDraft";
import type { JourneyUse } from "../../model/segmentList";
import { SegmentEditor } from "../SegmentEditor";

const save = jest.fn();
jest.mock("../../model/actions", () => ({
  saveSegmentV2Action: (...args: unknown[]) => save(...args),
  deleteSegmentV2Action: jest.fn(),
}));
const router = { refresh: jest.fn(), push: jest.fn() };
jest.mock("next/navigation", () => ({ useRouter: () => router }));

const ID = "SEG-4f1c9a0b2d3e5f67" as SegmentDraft["id"];
const EVENTS: UserEventDef[] = [{ id: "1", name: "com.acme/add_to_cart", label: "Added to cart", fields: [] }];
const EVENTS_WITH_FIELDS: UserEventDef[] = [{
  ...EVENTS[0],
  fields: [{ value: "product.price", label: "Product price", dataType: "number" }],
}];
const ACTIVE = { campaignId: "CAMP-A", campaignName: "Cart abandonment – Hà Nội", status: "active", kinds: ["entry_trigger"] } as const;
const USED: JourneyUse[] = [
  { ...ACTIVE, kinds: ["entry_trigger"], href: "/v2/journeys/CAMP-A" },
  { campaignId: "CAMP-B", campaignName: "Weekend flash sale", status: "paused", kinds: ["condition"], href: null },
];

function draft(threshold: string): SegmentDraft {
  return {
    id: ID,
    create: false,
    name: "Hà Nội cart builders",
    description: "",
    groups: [[{ ...newProfileCondition(), value: "Hà Nội" }], [{ ...newBehaviorCondition("com.acme/add_to_cart"), value: threshold }]],
  };
}

function renderEditor(threshold = "2") {
  render(<SegmentEditor details={null} events={EVENTS} initial={draft(threshold)} usedBy={USED} />);
}

beforeEach(() => {
  save.mockReset();
  router.refresh.mockReset();
  router.push.mockReset();
});

describe("SegmentEditor", () => {
  it("names every journey that uses the segment before a save (SEG-FR-07)", () => {
    renderEditor();

    expect(screen.getByText(/A change applies to the next evaluation/)).toHaveTextContent(
      "Cart abandonment – Hà Nội (Active) and Weekend flash sale (Paused).",
    );
  });

  it("refuses a missing number of times, names the place, marks the field, and keeps the typed values (SEG-FR-43)", () => {
    renderEditor("");

    fireEvent.click(screen.getByRole("button", { name: "Save segment" }));

    expect(screen.getByText("Group 2, condition 1 needs a number of times. Fill it in, or remove the condition. Nothing you typed was lost.")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Group 2" })).getByRole("textbox", { name: "Threshold" })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("textbox", { name: "Value" })).toHaveValue("Hà Nội");
    expect(save).not.toHaveBeenCalled();
  });

  it("asks to confirm the active journeys the server returns, then saves with them (SEG-FR-07)", async () => {
    save.mockResolvedValueOnce({ confirm: [{ ...ACTIVE, kinds: ["entry_trigger"], ownerId: null }] }).mockResolvedValueOnce({ saved: true, id: ID });
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "Save segment" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Cart abandonment – Hà Nội")).toBeInTheDocument();
    expect(within(dialog).getByText("Nothing is saved until you confirm.")).toBeInTheDocument();

    const saveChange = within(dialog).getByRole("button", { name: "Save change" });
    await waitFor(() => expect(saveChange).toBeEnabled());
    fireEvent.click(saveChange);

    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(save.mock.calls[1][1]).toEqual(["CAMP-A"]);
  });

  it("shows no size count before membership is stored (SEG-FR-08)", () => {
    renderEditor();

    expect(screen.getByText("Size shows once membership is stored.")).toBeInTheDocument();
  });

  it("adds a filter, focuses its field, and returns focus to + filter on removal (SEG-FR-11)", async () => {
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "filter" }));
    const field = screen.getByRole("combobox", { name: "Filter 1 field" });
    await waitFor(() => expect(field).toHaveFocus());
    expect(screen.getByText("WHERE")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Remove filter 1" }));
    expect(screen.queryByRole("combobox", { name: "Filter 1 field" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "filter" })).toHaveFocus());
  });

  it("refuses a filter with no value, names it, marks it, and keeps the typed values (SEG-FR-43)", () => {
    const initial = draft("2");
    initial.groups[1][0] = { ...newBehaviorCondition("com.acme/add_to_cart"), filters: [{ field: "product.price", op: ">", value: "" }] };
    render(<SegmentEditor details={null} events={EVENTS_WITH_FIELDS} initial={initial} usedBy={USED} />);

    fireEvent.click(screen.getByRole("button", { name: "Save segment" }));

    expect(screen.getByText("Group 2, condition 1, filter 1 needs a value. Fill it in, or remove the filter. Nothing you typed was lost.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Filter 1 value" })).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Needs a value")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Filter 1 field" })).toHaveTextContent("Product price");
    expect(save).not.toHaveBeenCalled();
  });

  it("sends the filters with the save", async () => {
    save.mockResolvedValue({ saved: true, id: ID });
    const initial = draft("2");
    initial.groups[1][0] = { ...newBehaviorCondition("com.acme/add_to_cart"), filters: [{ field: "product.price", op: ">", value: "500000" }] };
    render(<SegmentEditor details={null} events={EVENTS_WITH_FIELDS} initial={initial} usedBy={USED} />);

    fireEvent.click(screen.getByRole("button", { name: "Save segment" }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][0].conditions.groups[1].conditions[0].filters).toEqual({
      groups: [{ conditions: [{ type: "event_property", field: "product.price", op: ">", value: 500000 }] }],
    });
  });

  it("keeps a server refusal on the page with every typed value", async () => {
    save.mockResolvedValue({ error: "Group 2, condition 1: the event com.acme/x is not in the catalog." });
    renderEditor();

    fireEvent.click(screen.getByRole("button", { name: "Save segment" }));

    expect(await screen.findByText(/is not in the catalog\. Nothing you typed was lost\./)).toBeInTheDocument();
    expect(screen.getByDisplayValue("Hà Nội cart builders")).toBeInTheDocument();
  });
});
