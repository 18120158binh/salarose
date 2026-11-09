import React from "react";
import { render, screen } from "@testing-library/react";
import CampaignBuilderPageClient from "../CampaignBuilderPageClient";
import type { Campaign } from "@/entities/journey/model/types";
import { saveDrafts } from "../../draftStore";

const header = jest.fn();
const builder = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }) }));
jest.mock("@/shared/ui/Header", () => (props: Record<string, unknown>) => {
  header(props);
  return null;
});
jest.mock("../../components/CampaignBuilder", () => function CampaignBuilderStub(props: { campaign: Campaign | null }) {
  builder(props);
  return <div>{props.campaign ? `Builder: ${props.campaign.name}` : "Builder: new campaign"}</div>;
});
jest.mock("../../../actions", () => ({
  publishCampaignAction: jest.fn(),
  getCampaignNodeStatsAction: jest.fn(async () => ({ stats: {} })),
}));

const noPickers = { userEvents: [] };
const campaign = (id: string, name: string, status: Campaign["status"]): Campaign => ({
  id,
  name,
  description: "",
  status,
  root: { type: "setup", id: "setup-1", label: "Trigger", description: "", triggerEventName: "add_to_cart", next: { type: "end" } },
  created_at: "2026-10-18T00:00:00.000Z",
  updated_at: "2026-10-18T00:00:00.000Z",
});

beforeEach(() => {
  localStorage.clear();
  header.mockClear();
  builder.mockClear();
});

describe("CampaignBuilderPageClient", () => {
  it("opens the published campaign the server loaded", () => {
    render(<CampaignBuilderPageClient userId="u_lan" id="c_lan" dbCampaign={campaign("c_lan", "Cart recovery", "active")} pickers={noPickers} />);

    expect(screen.getByText("Builder: Cart recovery")).toBeInTheDocument();
  });

  it("opens a draft from the browser", () => {
    saveDrafts("u_lan", [campaign("CAMP-0000000000000002", "Draft promo", "draft")]);
    render(<CampaignBuilderPageClient userId="u_lan" id="CAMP-0000000000000002" dbCampaign={null} pickers={noPickers} />);

    expect(screen.getByText("Builder: Draft promo")).toBeInTheDocument();
  });

  it("opens a blank campaign for new", () => {
    render(<CampaignBuilderPageClient userId="u_lan" id="new" dbCampaign={null} pickers={noPickers} />);

    expect(screen.getByText("Builder: new campaign")).toBeInTheDocument();
  });

  // The server returns no campaign for an unknown id or one another editor owns.
  it("says the campaign was not found instead of opening a blank one", () => {
    render(<CampaignBuilderPageClient userId="u_lan" id="CAMP-ffffffffffffffff" dbCampaign={null} pickers={noPickers} />);

    expect(screen.getByText(/campaign not found/i)).toBeInTheDocument();
    expect(screen.getByText(/does not exist, or another user owns it/i)).toBeInTheDocument();
    expect(builder).not.toHaveBeenCalled();
  });

  it("shows the admin link to an admin", () => {
    render(<CampaignBuilderPageClient userId="u_lan" id="new" dbCampaign={null} isAdminUser pickers={noPickers} />);

    expect(header).toHaveBeenLastCalledWith(expect.objectContaining({ isAdminUser: true }));
  });
});
