import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import NodeEditor from "../NodeEditor";
import { getUserEventsAction } from "../../../actions";
import type { CampaignNode } from "@/entities/journey/model/types";

jest.mock("../../../actions", () => ({
  getUserEventsAction: jest.fn(async () => []),
}));

// The builder loads the catalog once and passes it down.
const noPickers = { userEvents: [] };

function setupNode(eventId: string, eventName: string, row: { field: string; op: string; value: number }): CampaignNode {
  return {
    id: "setup-node",
    type: "setup",
    subType: "setup",
    label: "Entry",
    position: { x: 0, y: 0 },
    config: {
      eventId,
      triggerEventName: eventName,
      filters: { groups: [{ conditions: [{ type: "event_property", ...row }] }] },
    },
  };
}

async function operatorLabels(currentOperatorLabel: string): Promise<string[]> {
  fireEvent.click(screen.getByText(currentOperatorLabel));
  const listbox = await screen.findByRole("listbox");
  return within(listbox).getAllByRole("option").map((option) => option.textContent ?? "");
}

describe("NodeEditor setup business events", () => {
  it.each([
    ["be_price_drop", "price_drop", "price"],
    ["be_back_in_stock", "back_in_stock", "quantity"],
  ])("offers numeric operators for %s %s", async (eventId, eventName, field) => {
    render(
      <NodeEditor
        node={setupNode(eventId, eventName, { field, op: "=", value: 100 })}
        onUpdate={() => {}}
        onClose={() => {}}
        onDeleteNode={() => {}}
        pickers={noPickers}
      />,
    );
    const conditionsTab = screen.getByRole("tab", { name: "Conditions" });
    fireEvent.pointerDown(conditionsTab);
    fireEvent.click(conditionsTab);

    expect(await operatorLabels("equals")).toEqual([
      "equals",
      "does not equal",
      "is at least",
      "is more than",
      "is at most",
      "is less than",
    ]);
  });
});

const canvasNode = (node: Pick<CampaignNode, "id" | "type" | "subType" | "config">): CampaignNode => ({
  label: node.id,
  position: { x: 0, y: 0 },
  ...node,
});

// JBD-FR-10: each node type opens its own editor. An End node has nothing to configure.
describe("NodeEditor for an End node", () => {
  it("opens the End editor, not the engagement editor", () => {
    render(
      <NodeEditor
        node={canvasNode({ id: "check-yes-end", type: "end", subType: "custom-list", config: { description: "Journey ends" } })}
        onUpdate={() => {}}
        onClose={() => {}}
        onDeleteNode={() => {}}
        pickers={noPickers}
      />,
    );

    expect(screen.getByText(/the journey ends here/i)).toBeInTheDocument();
    expect(screen.queryByText("Channel node")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply Predicate" })).toBeNull();
  });
});

// The outbox sends a webhook with the node's method: GET, POST, PUT, PATCH, or DELETE.
describe("NodeEditor for a webhook", () => {
  const webhook = (config: Record<string, unknown>) =>
    canvasNode({ id: "hook", type: "engagement", subType: "webhook", config: { url: "https://example.com/hook", payload: "{}", ...config } });

  it("offers the five methods and applies the one picked", async () => {
    const onUpdate = jest.fn();
    render(<NodeEditor node={webhook({ method: "POST" })} onUpdate={onUpdate} onClose={() => {}} onDeleteNode={() => {}} pickers={noPickers} />);

    fireEvent.click(screen.getByRole("combobox", { name: "HTTP Method" }));
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getAllByRole("option").map((option) => option.textContent)).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE"]);
    const put = within(listbox).getByRole("option", { name: "PUT" });
    fireEvent.pointerDown(put);
    fireEvent.click(put);
    fireEvent.click(screen.getByRole("button", { name: "Apply Predicate" }));

    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ method: "PUT" }), "hook");
  });

  it("shows POST for a webhook saved without a method", () => {
    render(<NodeEditor node={webhook({})} onUpdate={() => {}} onClose={() => {}} onDeleteNode={() => {}} pickers={noPickers} />);

    expect(screen.getByRole("combobox", { name: "HTTP Method" })).toHaveTextContent("POST");
  });
});

// JBD-KI-18: a drag or a realign hands the editor a new node object with the same id.
describe("NodeEditor while the node changes on the canvas", () => {
  const push = canvasNode({ id: "push-1", type: "engagement", subType: "push", config: { title: "Hi", body: "Come back" } });
  const editor = (node: CampaignNode) => (
    <NodeEditor node={node} onUpdate={() => {}} onClose={() => {}} onDeleteNode={() => {}} pickers={noPickers} />
  );

  it("keeps edits that are not applied yet when the node moves", () => {
    const { rerender } = render(editor(push));
    fireEvent.change(screen.getByPlaceholderText("Enter node name"), { target: { value: "Win back" } });
    fireEvent.change(screen.getByDisplayValue("Come back"), { target: { value: "We miss you" } });

    rerender(editor({ ...push, position: { x: 320, y: 72 } }));

    expect(screen.getByPlaceholderText("Enter node name")).toHaveValue("Win back");
    expect(screen.getByDisplayValue("We miss you")).toBeInTheDocument();
  });

  it("reads the catalog from the builder, not the database", () => {
    render(editor(push));

    expect(getUserEventsAction).not.toHaveBeenCalled();
  });
});
