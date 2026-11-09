import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { UTC } from "@/shared/lib/time-range";
import type { Viewer } from "@/widgets/v2-shell/model/routes";
import type { DraftJourney, PublishedJourney } from "../../model/journeyList";
import { JourneyList } from "../JourneyList";

const mockPush = jest.fn();
const mockActions = {
  pauseJourneyAction: jest.fn(),
  resumeJourneyAction: jest.fn(),
  deleteJourneyAction: jest.fn(),
  deleteDraftAction: jest.fn(),
  duplicateJourneyAction: jest.fn(),
  peopleInJourneyAction: jest.fn(),
};
const mockNotify = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock("../../../journeys/model/actions", () => ({
  pauseJourneyAction: (id: string) => mockActions.pauseJourneyAction(id),
  resumeJourneyAction: (id: string) => mockActions.resumeJourneyAction(id),
  deleteJourneyAction: (id: string) => mockActions.deleteJourneyAction(id),
  deleteDraftAction: (id: string) => mockActions.deleteDraftAction(id),
  duplicateJourneyAction: (id: string) => mockActions.duplicateJourneyAction(id),
  peopleInJourneyAction: (id: string) => mockActions.peopleInJourneyAction(id),
}));
jest.mock("../../../../shared/ui/v2/toast", () => ({ notify: (notice: unknown) => mockNotify(notice) }));

const NOW = Date.UTC(2026, 10, 9, 10);
const DAY = 86_400_000;
const lan: Viewer = { userId: "u-lan", role: "editor" };

const journey = (id: string, fields: Partial<PublishedJourney>): PublishedJourney => ({
  kind: "published",
  id,
  name: id,
  status: "active",
  ownerId: "u-lan",
  ownerEmail: "lan@example.com",
  entries: 0,
  updatedAt: NOW - DAY,
  ...fields,
});

const PUBLISHED = [
  journey("CAMP-mine", { name: "Welcome series", entries: 1200, updatedAt: NOW - 2 * DAY }),
  journey("CAMP-theirs", { name: "Cart abandonment", ownerId: "u-minh", ownerEmail: "minh@example.com", status: "paused", entries: 480 }),
];

// The shape the classic builder stores, one list per user (app/campaign/draftStore.ts).
const DRAFT = {
  id: "CAMP-draft",
  name: "Winback sketch",
  description: "",
  status: "draft",
  root: { id: "setup-1", type: "setup", config: {}, children: [] },
  created_at: "2026-11-09T09:00:00Z",
  updated_at: "2026-11-09T09:00:00Z",
};

const SERVER_DRAFT: DraftJourney = {
  kind: "draft",
  source: "server",
  id: "CAMP-server",
  name: "Price drop alert",
  updatedAt: NOW - 3 * DAY,
  note: "Started blank",
};

function renderList(
  published: readonly PublishedJourney[] = PUBLISHED,
  viewer: Viewer = lan,
  { drafts = [] as readonly DraftJourney[], canBuild = false } = {},
) {
  return render(
    <JourneyList
      canBuild={canBuild}
      createHref={canBuild ? "/v2/journeys/new" : "/campaign/new"}
      drafts={drafts}
      now={NOW}
      published={published}
      viewer={viewer}
      viewerEmail="lan@example.com"
      zone={UTC}
    />,
  );
}

const rowNames = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0].textContent);

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
  localStorage.setItem("auroracy_campaigns:u-lan", JSON.stringify([DRAFT]));
});

describe("journey list (JBD-FR-18)", () => {
  it("lists the viewer's journeys and this browser's drafts under Mine, the default", () => {
    renderList();

    expect(screen.getByRole("button", { name: "Mine" })).toHaveAttribute("aria-pressed", "true");
    expect(rowNames()).toEqual(["Winback sketch", "Welcome series"]);
  });

  it("shows every published journey under All, and not the draft", () => {
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "All" }));

    expect(rowNames()).toEqual(["Cart abandonment", "Welcome series"]);
  });

  it("shows each journey's status, owner, entries in the last 7 days, and last change", () => {
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "All" }));

    const cart = screen.getByRole("row", { name: /Cart abandonment/ });
    expect(within(cart).getByText("Paused")).toBeInTheDocument();
    expect(within(cart).getByText("minh@example.com")).toBeInTheDocument();
    expect(within(cart).getByText("480")).toBeInTheDocument();
    expect(within(cart).getByText("Nov 8, 2026, 10:00 AM")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Entries, last 7 days" })).toBeInTheDocument();
  });

  it("shows a journey without an owner as No owner, and says why", () => {
    renderList([journey("CAMP-orphan", { name: "Browse abandonment", ownerId: null, ownerEmail: null })]);
    fireEvent.click(screen.getByRole("button", { name: "All" }));

    const row = screen.getByRole("row", { name: /Browse abandonment/ });
    expect(within(row).getByText("No owner")).toBeInTheDocument();
    expect(within(row).getByText("The owner's account was removed")).toBeInTheDocument();
  });

  it("opens a browser draft in the classic builder that keeps it", () => {
    renderList();

    const draft = screen.getByRole("row", { name: /Winback sketch/ });
    expect(within(draft).getByText("Draft")).toBeInTheDocument();
    expect(within(draft).getByRole("link", { name: "Winback sketch" })).toHaveAttribute("href", "/campaign/CAMP-draft");
  });

  it("opens the analytics of every published journey, the viewer's and another's", () => {
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "All" }));

    expect(screen.getByRole("link", { name: "Welcome series" })).toHaveAttribute("href", "/v2/journeys/CAMP-mine");
    expect(screen.getByRole("link", { name: "Cart abandonment" })).toHaveAttribute("href", "/v2/journeys/CAMP-theirs");
  });

  it("searches names, filters by status, and sorts by entries", () => {
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "All" }));

    fireEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(rowNames()).toEqual(["Cart abandonment", "Welcome series"]);
    fireEvent.click(screen.getByRole("button", { name: "Entries" }));
    expect(rowNames()).toEqual(["Welcome series", "Cart abandonment"]);

    fireEvent.click(screen.getByRole("button", { name: /^Active/ }));
    expect(rowNames()).toEqual(["Welcome series"]);

    fireEvent.click(screen.getByRole("button", { name: /^Any status/ }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search journeys" }), { target: { value: "CART" } });
    expect(rowNames()).toEqual(["Cart abandonment"]);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search journeys" }), { target: { value: "nothing like it" } });
    expect(screen.getByText("No journey matches the search and filters.")).toBeInTheDocument();
  });

  it("points a viewer who owns nothing to All", () => {
    localStorage.clear();
    renderList([PUBLISHED[1]]);

    expect(screen.getByText("You own no journey. Pick All to see your colleagues' journeys.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show All" }));
    expect(rowNames()).toEqual(["Cart abandonment"]);
  });

  it("offers Create journey when there is no journey at all", () => {
    localStorage.clear();
    renderList([], lan, { canBuild: true });

    expect(screen.getByRole("heading", { name: "No journey yet. Create one to start." })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create journey" })).toHaveAttribute("href", "/v2/journeys/new");
  });

  it("counts each status in its filter and says how many rows show", () => {
    renderList(PUBLISHED, lan, { drafts: [SERVER_DRAFT], canBuild: true });

    expect(screen.getByRole("button", { name: "Draft 2" })).toBeInTheDocument();
    expect(screen.getByText(/Mine shows your journeys and your drafts\./)).toHaveTextContent("Showing 3 journeys");
  });

  it("lists the viewer's server drafts with where they came from, and opens them in the v2 builder", () => {
    renderList(PUBLISHED, lan, { drafts: [SERVER_DRAFT], canBuild: true });

    const row = screen.getByRole("row", { name: /Price drop alert/ });
    expect(within(row).getByText("Started blank")).toBeInTheDocument();
    expect(within(row).getByText("Not published")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: /Price drop alert/ })).toHaveAttribute("href", "/v2/journeys/drafts/CAMP-server");
  });
});

async function openMenu(name: string) {
  fireEvent.click(screen.getByRole("button", { name: `Actions for ${name}` }));
  return within(await screen.findByRole("menu"));
}

describe("row actions (CMP-FR-07 to CMP-FR-09)", () => {
  it("offers a colleague's journey Open and Duplicate only", async () => {
    renderList(PUBLISHED, lan, { canBuild: true });
    fireEvent.click(screen.getByRole("button", { name: "All" }));

    const menu = await openMenu("Cart abandonment");
    expect(menu.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Open", "Duplicate"]);
  });

  it("pauses the owner's journey in one click, updates the row, and offers Undo, which resumes", async () => {
    mockActions.pauseJourneyAction.mockResolvedValue({ status: "paused" });
    mockActions.resumeJourneyAction.mockResolvedValue({ status: "active" });
    renderList(PUBLISHED, lan, { canBuild: true });

    fireEvent.click((await openMenu("Welcome series")).getByRole("menuitem", { name: "Pause" }));

    await waitFor(() => expect(within(screen.getByRole("row", { name: /Welcome series/ })).getByText("Paused")).toBeInTheDocument());
    expect(mockActions.pauseJourneyAction).toHaveBeenCalledWith("CAMP-mine");
    const notice = mockNotify.mock.calls[0][0];
    expect(notice).toMatchObject({ kind: "action", title: "Paused “Welcome series”. Nobody new enters it.", action: { label: "Undo" } });

    await act(async () => notice.action.onClick());
    await waitFor(() => expect(within(screen.getByRole("row", { name: /Welcome series/ })).getByText("Active")).toBeInTheDocument());
    expect(mockActions.resumeJourneyAction).toHaveBeenCalledWith("CAMP-mine");
  });

  it("keeps the row as it was and says why when a pause is refused", async () => {
    mockActions.pauseJourneyAction.mockResolvedValue({ error: "Only the owner of campaign CAMP-mine or an admin can change it." });
    renderList(PUBLISHED, lan, { canBuild: true });

    fireEvent.click((await openMenu("Welcome series")).getByRole("menuitem", { name: "Pause" }));

    await waitFor(() => expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ kind: "failed" })));
    expect(within(screen.getByRole("row", { name: /Welcome series/ })).getByText("Active")).toBeInTheDocument();
  });

  it("asks before a delete, names the people waiting and that analytics history is kept, then removes the row", async () => {
    mockActions.peopleInJourneyAction.mockResolvedValue({ people: 23 });
    mockActions.deleteJourneyAction.mockResolvedValue({ status: "deleted" });
    renderList(PUBLISHED, lan, { canBuild: true });

    fireEvent.click((await openMenu("Welcome series")).getByRole("menuitem", { name: "Delete" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: "Delete “Welcome series”?" })).toBeInTheDocument();
    expect(await within(dialog).findByText(/in this journey\. They will leave it\./)).toHaveTextContent("23 people are in this journey");
    expect(within(dialog).getByText(/Its analytics history is kept\./)).toBeInTheDocument();
    expect(mockActions.deleteJourneyAction).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete journey" }));

    await waitFor(() => expect(screen.queryByRole("row", { name: /Welcome series/ })).not.toBeInTheDocument());
    expect(mockActions.deleteJourneyAction).toHaveBeenCalledWith("CAMP-mine");
  });

  it("deletes a server draft through the draft action", async () => {
    mockActions.deleteDraftAction.mockResolvedValue({ status: "deleted" });
    renderList(PUBLISHED, lan, { drafts: [SERVER_DRAFT], canBuild: true });

    fireEvent.click((await openMenu("Price drop alert")).getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("This draft was never published, so nobody is in it. Deleting it is final.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete draft" }));

    await waitFor(() => expect(mockActions.deleteDraftAction).toHaveBeenCalledWith("CAMP-server"));
    expect(mockActions.peopleInJourneyAction).not.toHaveBeenCalled();
  });

  it("duplicates a journey and opens the copy in the v2 builder", async () => {
    mockActions.duplicateJourneyAction.mockResolvedValue({ id: "CAMP-COPY", version: 1 });
    renderList(PUBLISHED, lan, { canBuild: true });
    fireEvent.click(screen.getByRole("button", { name: "All" }));

    fireEvent.click((await openMenu("Cart abandonment")).getByRole("menuitem", { name: "Duplicate" }));

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/v2/journeys/drafts/CAMP-COPY"));
  });

  it("offers no Duplicate to a viewer the v2 builder does not let through", async () => {
    renderList(PUBLISHED, lan);

    const menu = await openMenu("Welcome series");
    expect(menu.queryByRole("menuitem", { name: "Duplicate" })).not.toBeInTheDocument();
  });
});

describe("the journey list filters without writing (JBD-FR-24)", () => {
  it("leaves the stored drafts unchanged and calls no endpoint when every filter and sort is used", () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy;
    const before = localStorage.getItem("auroracy_campaigns:u-lan");
    renderList();

    for (const name of ["All", "Mine", /^Draft/, /^Active/, /^Paused/, /^Any status/, "Name", "Entries", "Last change"]) {
      fireEvent.click(screen.getByRole("button", { name }));
    }
    fireEvent.change(screen.getByRole("searchbox", { name: "Search journeys" }), { target: { value: "w" } });

    expect(localStorage.getItem("auroracy_campaigns:u-lan")).toBe(before);
    expect(localStorage.length).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(Object.values(mockActions).every((action) => action.mock.calls.length === 0)).toBe(true);
  });
});
