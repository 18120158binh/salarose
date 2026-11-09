import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import CampaignBuilder from "../CampaignBuilder";
import type { Campaign, CampaignNode } from "@/entities/journey/model/types";

// The canvas is React Flow, which needs a real layout engine. The stub records what the builder
// hands it, so a test can read the node positions and drive a drag.
type CanvasProps = {
  nodes: CampaignNode[];
  onNodeDragStop: (id: string, position: { x: number; y: number }) => void;
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
const position = (id: string) => canvas.nodes.find((node) => node.id === id)?.position;

afterEach(() => {
  jest.useRealTimers();
});

describe("CampaignBuilder", () => {
  // The editable builder only ever holds a draft: Save Draft saves one, and Publish activates it.
  it("shows the status as Draft and offers no status choice", () => {
    const onSave = jest.fn();
    render(<CampaignBuilder campaign={draft} onSave={onSave} onBack={() => {}} pickers={noPickers} />);

    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("Draft")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /save draft/i }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ status: "draft" }), false);
  });

  it("keeps a node moved right after an edit", () => {
    jest.useFakeTimers();
    render(<CampaignBuilder campaign={draft} onSave={() => {}} onBack={() => {}} pickers={noPickers} />);

    fireEvent.click(screen.getByRole("button", { name: "Check" }));
    act(() => canvas.onNodeDragStop("setup-1", { x: 999, y: 555 }));
    act(() => {
      jest.advanceTimersByTime(1000);
    });

    expect(position("setup-1")).toEqual({ x: 999, y: 555 });
  });
});
