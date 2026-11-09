import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import CampaignList from "../CampaignList";
import type { Campaign, CampaignTreeNode } from "@/entities/journey/model/types";

jest.mock("../../../actions", () => ({
  getUserEventsAction: jest.fn(async () => []),
}));

const end = { type: "end", goalId: "goal_default" } as const;

function campaign(id: string, name: string, status: Campaign["status"], next: CampaignTreeNode = end): Campaign {
  return {
    id,
    name,
    description: "",
    status,
    root: {
      type: "setup",
      id: "setup-1",
      label: "Trigger",
      description: "Define journey settings",
      triggerType: "user",
      triggerEventName: "add_to_cart",
      next,
    },
    created_at: "2026-10-18T00:00:00.000Z",
    updated_at: "2026-10-18T00:00:00.000Z",
  };
}

function renderList(campaigns: Campaign[]) {
  const handlers = { onEdit: jest.fn(), onCreate: jest.fn(), onDelete: jest.fn(), onToggleStatus: jest.fn(), onClone: jest.fn() };
  render(<CampaignList campaigns={campaigns} {...handlers} />);
  return handlers;
}

const summaryOf = (name: string) =>
  within(screen.getByRole("list", { name: `Journey summary of ${name}` }))
    .getAllByRole("listitem")
    .map((item) => item.textContent);

// CMP-FR-17: publish derives metric definitions, so the list offers no way to edit one.
describe("metric definitions", () => {
  it("offers no control to create, edit, or delete a metric definition", () => {
    renderList([campaign("c_lan", "Cart recovery", "active")]);

    expect(screen.getAllByRole("button").map((button) => button.textContent)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/propert|metric/i)]),
    );
  });
});

describe("delete", () => {
  it("asks for confirmation and deletes nothing when the user cancels", async () => {
    const { onDelete } = renderList([campaign("c_lan", "Cart recovery", "active")]);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Cart recovery");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("deletes the campaign once the user confirms", async () => {
    const { onDelete } = renderList([campaign("c_lan", "Cart recovery", "active")]);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith("c_lan");
  });
});

it("labels the button of a paused campaign as a resume", () => {
  const { onToggleStatus } = renderList([campaign("c_lan", "Cart recovery", "paused")]);

  expect(screen.queryByRole("button", { name: "Set Draft" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));

  expect(onToggleStatus).toHaveBeenCalledWith("c_lan");
});

it("clones a campaign from the list", () => {
  const { onClone } = renderList([campaign("c_lan", "Cart recovery", "active"), campaign("c_minh", "Browse reminder", "paused")]);

  const cloneButtons = screen.getAllByRole("button", { name: "Clone" });
  expect(cloneButtons).toHaveLength(2);
  fireEvent.click(cloneButtons[1]);

  expect(onClone).toHaveBeenCalledWith("c_minh");
});

describe("card summary", () => {
  it("counts every step, flags delays and multi-branch paths, and shows the first channel", () => {
    // setup -> segment
    //   yes -> check (multi-branch)
    //     branch_0 -> delay watch -> sms
    //     else -> end
    //   no -> [watch -> email, end]
    const journey: CampaignTreeNode = {
      type: "segment",
      id: "segment-1",
      label: "Big spenders",
      conditions: {
        groups: [{ conditions: [{ type: "behavior", event: "purchase", measure: "SUM", attribute: "order.total", window: { value: 30, unit: "DAYS" }, op: ">=", value: 100 }] }],
      },
      next: {
        type: "YesOrNoPath",
        yes: {
          type: "check",
          id: "check-1",
          label: "Which tier?",
          next: {
            type: "MultiBranchPath",
            branches: [
              {
                branchKey: "branch_0",
                priority: 0,
                next: {
                  type: "watch",
                  id: "watch-1",
                  label: "Wait a day",
                  timeLimitValue: 1,
                  timeLimitUnit: "days",
                  next: {
                    type: "DelayPath",
                    next: { type: "engagement", id: "sms-1", label: "Tier SMS", action: { type: "sms" }, next: end },
                  },
                },
              },
              { branchKey: "else", priority: 1, next: end },
            ],
          },
        },
        no: [
          {
            type: "watch",
            id: "watch-2",
            label: "Bought?",
            eventName: "purchase",
            timeLimitValue: 2,
            timeLimitUnit: "hours",
            next: {
              type: "SuccessPath",
              success: { type: "engagement", id: "email-1", label: "Thanks", action: { type: "email" }, next: end },
            },
          },
          end,
        ],
      },
    };
    renderList([campaign("c_lan", "Cart recovery", "active", journey)]);

    expect(summaryOf("Cart recovery")).toEqual([
      "Trigger: add_to_cart",
      "Checks: 1",
      "Watches: 2",
      "Segments: 1",
      "Has delays",
      "Has multi-branch paths",
      "Channel: sms",
    ]);
  });

  it("shows no flags and no channel for a journey without them", () => {
    renderList([campaign("c_lan", "Cart recovery", "draft")]);

    expect(summaryOf("Cart recovery")).toEqual([
      "Trigger: add_to_cart",
      "Checks: 0",
      "Watches: 0",
      "Segments: 0",
      "Channel: None",
    ]);
  });
});
