import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Connection } from "@xyflow/react";
import CampaignBuilder from "../CampaignBuilder";
import type { Campaign, CampaignConnection, CampaignNode } from "@/entities/journey/model/types";

// The canvas is React Flow, which needs a real layout engine. The stub records what the builder
// hands it, so a test can read the graph and drive the canvas callbacks.
type CanvasProps = {
  nodes: CampaignNode[];
  connections: CampaignConnection[];
  onSelectNode: (id: string) => void;
  onAddNodeBetween: (fromId: string, toId: string) => void;
  onConnect: (params: Connection) => void;
};
let canvas: CanvasProps;
jest.mock("../Canvas", () => (props: CanvasProps) => {
  canvas = props;
  return null;
});

const draft: Campaign = {
  id: "CAMP-0000000000000001",
  name: "Cart recovery",
  description: "",
  status: "draft",
  root: {
    type: "setup",
    id: "setup-1",
    label: "Trigger",
    description: "Define journey settings",
    triggerEventName: "add_to_cart",
    next: { type: "end" },
  },
  created_at: "2026-10-18T00:00:00.000Z",
  updated_at: "2026-10-18T00:00:00.000Z",
};

const noPickers = { userEvents: [] };
const nodeIds = () => canvas.nodes.map((node) => node.id);

function renderBuilder() {
  render(<CampaignBuilder campaign={draft} onSave={() => {}} onBack={() => {}} pickers={noPickers} />);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(1000);
});

afterEach(() => {
  jest.useRealTimers();
});

// These pin what the canvas holds after each edit, so moving the edits out of the builder keeps them.
describe("CampaignBuilder graph edits", () => {
  it("adds a check from the palette in place of the main path's End, with a Yes and a No End", () => {
    renderBuilder();

    fireEvent.click(screen.getByRole("button", { name: "Check" }));

    expect(nodeIds()).toEqual(["setup-1", "node_1000", "end_yes_1000", "end_no_1000"]);
    expect(canvas.connections).toEqual([
      { from: "setup-1", to: "node_1000", type: "required" },
      { from: "node_1000", to: "end_yes_1000", type: "required" },
      { from: "node_1000", to: "end_no_1000", type: "undefined" },
    ]);
  });

  it("inserts a channel on an edge, keeping the edge's kind and the downstream on Yes", () => {
    renderBuilder();
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    jest.setSystemTime(2000);

    act(() => canvas.onAddNodeBetween("node_1000", "end_no_1000"));
    const [, insertPalette] = screen.getAllByRole("button", { name: "Email" });
    fireEvent.click(insertPalette);

    expect(nodeIds()).toEqual(["setup-1", "node_1000", "end_yes_1000", "end_no_1000", "node_2000"]);
    expect(canvas.connections).toEqual([
      { from: "setup-1", to: "node_1000", type: "required" },
      { from: "node_1000", to: "end_yes_1000", type: "required" },
      { from: "node_1000", to: "node_2000", type: "undefined" },
      { from: "node_2000", to: "end_no_1000", type: "required" },
    ]);
  });

  it("deletes a node with everything below it", () => {
    renderBuilder();
    fireEvent.click(screen.getByRole("button", { name: "Check" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete Node" }));

    expect(nodeIds()).toEqual(["setup-1"]);
    expect(canvas.connections).toEqual([]);
  });

  it("refuses an edge into a node that has a parent", () => {
    renderBuilder();
    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    const before = canvas.connections;

    act(() => canvas.onConnect({ source: "node_1000", target: "end_yes_1000", sourceHandle: "no", targetHandle: null }));

    expect(canvas.connections).toEqual(before);
  });
});
