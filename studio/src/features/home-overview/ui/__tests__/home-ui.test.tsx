import { render, screen, within } from "@testing-library/react";
import { parseTimeZone } from "@/shared/lib/time-range";
import { withStage } from "@/widgets/v2-shell/model/__fixtures__/stage";
import type { Viewer } from "@/widgets/v2-shell/model/routes";
import type { ActiveJourney, PipelineHealth, RecentJourney } from "../../model/home";
import { HealthStrip } from "../HealthStrip";
import { ContinueList, JourneysTable, ViewAllJourneys } from "../JourneyLists";

const zone = parseTimeZone("Asia/Ho_Chi_Minh");
const now = Date.parse("2026-11-10T09:30:00+07:00");

const health = (overrides: Partial<PipelineHealth> = {}): Promise<PipelineHealth> =>
  Promise.resolve({ lag: 1_800, lastTransitionAt: now - 4_000, dropped: { available: true, value: 0 }, ...overrides });

describe("health strip (HOM-FR-08)", () => {
  const fourDropped = () => health({ dropped: { available: true, value: 4 } });

  it("shows 4 dropped records as a warning, linking an admin to the classic event catalog before the data pages ship", async () => {
    await withStage(["dead-letters", "events"], "reserved", async () => {
      render(await HealthStrip({ health: fourDropped(), viewer: { role: "admin", preview: false }, now, zone }));

      const dropped = screen.getByText("4 dropped records").closest("p")!;
      expect(within(dropped).getByText("Warning:")).toBeInTheDocument();
      expect(within(dropped).getByRole("link", { name: /Open events/ })).toHaveAttribute("href", "/admin/events");
    });
  });

  it("links an admin and an editor to the event catalog view before the dead-letter browser ships", async () => {
    await withStage(["dead-letters"], "reserved", async () => {
      const shown = render(await HealthStrip({ health: fourDropped(), viewer: { role: "admin", preview: false }, now, zone }));
      expect(screen.getByRole("link", { name: /Open events/ })).toHaveAttribute("href", "/v2/data/events");
      shown.unmount();

      render(await HealthStrip({ health: fourDropped(), viewer: { role: "editor", preview: false }, now, zone }));
      expect(screen.getByRole("link", { name: /Open events/ })).toHaveAttribute("href", "/v2/data/events");
    });
  });

  it("links an admin to the dead-letter browser and an editor to the event catalog view once they ship", async () => {
    await withStage(["dead-letters"], "shipped", async () => {
      const shown = render(await HealthStrip({ health: fourDropped(), viewer: { role: "admin", preview: false }, now, zone }));
      expect(screen.getByRole("link", { name: /Open dead letters/ })).toHaveAttribute("href", "/v2/data/dead-letters");
      shown.unmount();

      render(await HealthStrip({ health: fourDropped(), viewer: { role: "editor", preview: false }, now, zone }));
      expect(screen.getByRole("link", { name: /Open events/ })).toHaveAttribute("href", "/v2/data/events");
      expect(screen.queryByRole("link", { name: /dead letters/i })).not.toBeInTheDocument();
    });
  });

  it("reads no journey activity in the last hour, neither good nor bad, when no lag was measured", async () => {
    render(await HealthStrip({ health: health({ lag: null }), viewer: { role: "editor", preview: false }, now, zone }));

    const lag = screen.getByText("No journey activity in the last hour").closest("p")!;
    expect(within(lag).getByText("No data:")).toBeInTheDocument();
  });

  it.each([
    [60_000, "Good:"],
    [60_001, "Warning:"],
    [300_000, "Warning:"],
    [300_001, "Bad:"],
  ])("puts a lag of %i ms in the %s state", async (lag, state) => {
    render(await HealthStrip({ health: health({ lag }), viewer: { role: "editor", preview: false }, now, zone }));
    expect(within(screen.getByText(/at p95/).closest("p")!).getByText(state)).toBeInTheDocument();
  });

  it("shows Not available with the reason when the topic cannot be read", async () => {
    render(
      await HealthStrip({
        health: health({ dropped: { available: false, reason: "Kafka could not be reached." } }),
        viewer: { role: "admin", preview: false },
        now,
        zone,
      }),
    );
    expect(screen.getByText("Dropped records: Not available.")).toBeInTheDocument();
    expect(screen.getByText("Kafka could not be reached.")).toBeInTheDocument();
  });

  it("shows the last journey step as a relative time (HOM-FR-08)", async () => {
    render(await HealthStrip({ health: health({ lastTransitionAt: now - 12 * 60_000 }), viewer: { role: "editor", preview: false }, now, zone }));
    expect(screen.getByText("12 min ago")).toBeInTheDocument();
    expect(screen.getByText(/Last journey step/)).toBeInTheDocument();
  });
});

const journey = (overrides: Partial<ActiveJourney>): ActiveJourney => ({
  id: "CAMP-x",
  name: "Journey",
  ownerId: null,
  ownerEmail: null,
  entries: 0,
  messages: 0,
  change: 0,
  last7Days: [],
  ...overrides,
});

const lan: Viewer = { userId: "u-lan", role: "editor" };
const admin: Viewer = { userId: "u-admin", role: "admin" };

describe("journeys table (HOM-FR-05, HOM-FR-10)", () => {
  it("opens the viewer's own journey in the classic builder before analytics ships, and shows its numbers", async () => {
    render(
      await JourneysTable({
        viewer: lan,
        journeys: Promise.resolve([
          journey({
            id: "CAMP-cart",
            name: "Cart abandonment",
            ownerId: "u-lan",
            ownerEmail: "lan@example.com",
            entries: 6021,
            messages: 5880,
            change: 1204,
            last7Days: ["04", "05", "06", "07", "08", "09", "10"].map((day, i) => ({ date: `2026-11-${day}`, value: i * 10 })),
          }),
          journey({ id: "CAMP-browse", name: "Browse abandonment", entries: 3410, messages: 2002, change: -890 }),
        ]),
      }),
    );

    expect(screen.getByRole("link", { name: "Cart abandonment" })).toHaveAttribute("href", "/v2/journeys/CAMP-cart");
    const cart = screen.getByRole("link", { name: "Cart abandonment" }).closest("tr")!;
    const browse = screen.getByText("Browse abandonment").closest("tr")!;
    expect(within(browse).getByRole("link", { name: "Browse abandonment" })).toHaveAttribute("href", "/v2/journeys/CAMP-browse");
    expect(within(cart).getByText("+1,204")).toBeInTheDocument();
    expect(within(cart).getByText("6,021")).toBeInTheDocument();
    expect(within(browse).getByText("-890")).toBeInTheDocument();
    expect(within(browse).getByText("No owner")).toBeInTheDocument();
    const trend = within(cart).getByRole("group", { name: "Cart abandonment, entries per period" });
    expect(within(trend).getByRole("row", { name: "Nov 10 60" })).toBeInTheDocument();
  });

  it("opens the analytics for an admin too", async () => {
    render(await JourneysTable({ viewer: admin, journeys: Promise.resolve([journey({ id: "CAMP-browse", name: "Browse abandonment" })]) }));
    expect(screen.getByRole("link", { name: "Browse abandonment" })).toHaveAttribute("href", "/v2/journeys/CAMP-browse");
  });

  it("says no journey is running and offers Create journey in the classic builder", async () => {
    render(await JourneysTable({ viewer: lan, journeys: Promise.resolve([]) }));

    expect(screen.getByText("No journey is running. Publish one to see its numbers here.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Create journey" })).toHaveAttribute("href", "/campaign/new");
  });
});

describe("continue where you left off (HOM-FR-07, HOM-FR-10)", () => {
  const recent: RecentJourney[] = [
    { id: "CAMP-cart", name: "Cart abandonment", status: "active", updatedAt: now - 2 * 3_600_000 },
    { id: "CAMP-welcome", name: "Welcome series", status: "paused", updatedAt: now - 3 * 86_400_000 },
  ];

  it("lists each journey with its status and when it changed, linking to its analytics", async () => {
    render(await ContinueList({ journeys: Promise.resolve(recent), now, zone }));

    expect(screen.getByRole("link", { name: "Cart abandonment" })).toHaveAttribute("href", "/v2/journeys/CAMP-cart");
    const items = screen.getAllByRole("listitem");
    expect(within(items[0]).getByText("Active")).toBeInTheDocument();
    expect(within(items[0]).getByText("2 h ago")).toBeInTheDocument();
    expect(within(items[1]).getByText("Paused")).toBeInTheDocument();
    expect(within(items[1]).getByText("Nov 7, 2026, 9:30 AM")).toBeInTheDocument();
  });

  it("offers Create journey when the viewer owns none", async () => {
    render(await ContinueList({ journeys: Promise.resolve([]), now, zone }));
    expect(screen.getByRole("link", { name: "Create journey" })).toHaveAttribute("href", "/campaign/new");
  });
});

describe("View all (HOM-FR-05)", () => {
  it("opens the v2 journey list, which has shipped", () => {
    render(<ViewAllJourneys viewer={{ role: "editor", preview: false }} />);
    expect(screen.getByRole("link", { name: "View all" })).toHaveAttribute("href", "/v2/journeys");
  });
});
