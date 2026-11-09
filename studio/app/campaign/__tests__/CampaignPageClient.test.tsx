import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import CampaignPageClient from "../CampaignPageClient";
import { deleteCampaignAction } from "../../actions";
import type { Campaign } from "@/entities/journey/model/types";

const refresh = jest.fn();

const push = jest.fn();

jest.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));
jest.mock("@/shared/ui/Header", () => () => null);
jest.mock("../../actions", () => ({
  publishCampaignAction: jest.fn(async () => ({ success: true })),
  deleteCampaignAction: jest.fn(async () => ({ success: true })),
  toggleCampaignStatusAction: jest.fn(async () => ({ success: true })),
  getUserEventsAction: jest.fn(async () => []),
}));

const cartRecovery: Campaign = {
  id: "c_lan",
  name: "Cart recovery",
  description: "",
  status: "active",
  root: {
    type: "setup",
    id: "setup-1",
    label: "Trigger",
    description: "Define journey settings",
    triggerType: "user",
    triggerEventName: "add_to_cart",
    next: { type: "end", goalId: "goal_default" },
  },
  created_at: "2026-10-18T00:00:00.000Z",
  updated_at: "2026-10-18T00:00:00.000Z",
};

async function deleteAndConfirm() {
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" }));
}

it("keeps a campaign whose delete was refused and shows why", async () => {
  jest.mocked(deleteCampaignAction).mockResolvedValueOnce({
    error: "Only the owner of campaign c_lan or an admin can change it.",
  });
  const alert = jest.spyOn(window, "alert").mockImplementation(() => undefined);
  render(<CampaignPageClient userId="user_lan" dbCampaigns={[cartRecovery]} />);

  await deleteAndConfirm();

  await waitFor(() => expect(alert).toHaveBeenCalledWith("Only the owner of campaign c_lan or an admin can change it."));
  expect(screen.getByText("Cart recovery")).toBeInTheDocument();
  expect(refresh).not.toHaveBeenCalled();
  alert.mockRestore();
});

it("shows a failed delete as one sentence", async () => {
  jest.mocked(deleteCampaignAction).mockResolvedValueOnce({ error: "Failed to delete campaign." });
  const alert = jest.spyOn(window, "alert").mockImplementation(() => undefined);
  render(<CampaignPageClient userId="user_lan" dbCampaigns={[cartRecovery]} />);

  await deleteAndConfirm();

  await waitFor(() => expect(alert).toHaveBeenCalledWith("Failed to delete campaign."));
  alert.mockRestore();
});

describe("drafts in the browser", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  // Clones cartRecovery into a draft, which the page keeps in the browser for the signed-in user.
  async function cloneAs(userId: string) {
    const { unmount } = render(<CampaignPageClient userId={userId} dbCampaigns={[cartRecovery]} />);
    fireEvent.click(await screen.findByRole("button", { name: "Clone" }));
    unmount();
  }

  it("shows a user the drafts they saved on this browser", async () => {
    await cloneAs("user_minh");

    render(<CampaignPageClient userId="user_minh" dbCampaigns={[]} />);

    expect(await screen.findByText("Copy of Cart recovery")).toBeInTheDocument();
  });

  it("does not show a draft that another user saved on this browser", async () => {
    await cloneAs("user_minh");

    render(<CampaignPageClient userId="user_lan" dbCampaigns={[]} />);

    expect(await screen.findByText("No campaigns found")).toBeInTheDocument();
    expect(screen.queryByText("Copy of Cart recovery")).not.toBeInTheDocument();
  });

  it("does not show drafts saved before drafts were kept per user, since their author is unknown", async () => {
    localStorage.setItem(
      "auroracy_campaigns",
      JSON.stringify([{ ...cartRecovery, id: "CAMP-0001", name: "Shared old draft", status: "draft" }]),
    );

    render(<CampaignPageClient userId="user_lan" dbCampaigns={[]} />);

    expect(await screen.findByText("No campaigns found")).toBeInTheDocument();
    expect(screen.queryByText("Shared old draft")).not.toBeInTheDocument();
  });
});
