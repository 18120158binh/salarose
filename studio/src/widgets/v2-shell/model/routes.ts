import type { SystemRole } from "@/shared/auth/types";

export type Access = "staff" | "admin";

// SHL-FR-22: where a route is in its release. A preview route opens only to preview viewers, a
// shipped one to every staff user the role allows, and a reserved one to nobody: it has no page.
export type Stage = "preview" | "shipped" | "reserved";

// "menu" is a page the account menu opens, not the sidebar.
export type NavSection = "main" | "data" | "admin" | "menu";

export type NavId =
  | "home"
  | "journeys"
  | "audience"
  | "customers"
  | "events"
  | "monitoring"
  | "tracking"
  | "sources"
  | "dead-letters"
  | "metrics"
  | "datasets"
  | "imports"
  | "privacy"
  | "platform"
  | "settings"
  | "account";

export interface NavEntry {
  readonly id: NavId;
  readonly label: string;
  readonly href: `/v2${string}`;
  readonly section: NavSection;
  readonly access: Access;
  // The classic page that does this job, per role, or null when classic has none. Back to classic
  // opens it, or the classic landing page for null (SHL-FR-08).
  readonly classic: Readonly<Record<SystemRole, string | null>>;
  readonly stage: Stage;
}

// What the shell needs to know about a viewer to decide what they may reach.
export interface Reach {
  readonly role: SystemRole;
  // An admin, or a staff user whose preview flag is set (isPreviewViewer).
  readonly preview: boolean;
}

const BOTH = (path: string | null): Record<SystemRole, string | null> => ({ admin: path, editor: path });

// The studio shell contract's route table, in sidebar order, as the Salarose boards draw it.
export const NAV: readonly NavEntry[] = [
  { id: "home", label: "Home", href: "/v2", section: "main", access: "staff", classic: BOTH("/campaign"), stage: "shipped" },
  { id: "journeys", label: "Journeys", href: "/v2/journeys", section: "main", access: "staff", classic: BOTH("/campaign"), stage: "shipped" },
  { id: "audience", label: "Audience", href: "/v2/segments", section: "main", access: "staff", classic: BOTH("/segments"), stage: "shipped" },
  { id: "customers", label: "Customers", href: "/v2/customers", section: "main", access: "staff", classic: BOTH(null), stage: "shipped" },
  {
    id: "events",
    label: "Events",
    href: "/v2/data/events",
    section: "data",
    access: "staff",
    classic: { admin: "/admin/events", editor: null },
    stage: "shipped",
  },
  { id: "monitoring", label: "Monitoring", href: "/v2/data/monitoring", section: "data", access: "staff", classic: BOTH(null), stage: "preview" },
  { id: "tracking", label: "Tracking setup", href: "/v2/data/tracking", section: "data", access: "staff", classic: BOTH(null), stage: "preview" },
  { id: "sources", label: "Sources", href: "/v2/data/sources", section: "data", access: "admin", classic: BOTH("/admin/source-keys"), stage: "shipped" },
  // Moves into Monitoring as its Dropped data tab when Monitoring ships.
  { id: "dead-letters", label: "Dropped data", href: "/v2/data/dead-letters", section: "data", access: "admin", classic: BOTH(null), stage: "shipped" },
  { id: "metrics", label: "Metrics", href: "/v2/data/metrics", section: "data", access: "staff", classic: BOTH(null), stage: "preview" },
  { id: "datasets", label: "Datasets", href: "/v2/data/datasets", section: "data", access: "staff", classic: BOTH(null), stage: "preview" },
  { id: "imports", label: "Imports", href: "/v2/data/imports", section: "data", access: "staff", classic: BOTH(null), stage: "preview" },
  { id: "privacy", label: "Privacy", href: "/v2/data/privacy", section: "data", access: "admin", classic: BOTH(null), stage: "preview" },
  { id: "platform", label: "Platform", href: "/v2/platform", section: "admin", access: "admin", classic: BOTH("/platform"), stage: "shipped" },
  { id: "settings", label: "Settings", href: "/v2/settings", section: "admin", access: "admin", classic: BOTH(null), stage: "preview" },
  { id: "account", label: "Account", href: "/v2/account", section: "menu", access: "staff", classic: BOTH(null), stage: "preview" },
];

const CLASSIC_HOME = "/campaign";

export function mayOpen(access: Access, role: SystemRole): boolean {
  return access === "staff" || role === "admin";
}

// SHL-FR-22: the stage lets a viewer through. It never widens the role (mayOpen).
export function stageLets(stage: Stage, preview: boolean): boolean {
  return stage === "shipped" || (stage === "preview" && preview);
}

export function mayReach(entry: Pick<NavEntry, "access" | "stage">, viewer: Reach): boolean {
  return mayOpen(entry.access, viewer.role) && stageLets(entry.stage, viewer.preview);
}

// SHL-FR-04, SHL-FR-22: the viewer never sees an entry they may not open.
export function navFor(viewer: Reach): NavEntry[] {
  return NAV.filter((entry) => mayReach(entry, viewer));
}

// The entry whose route holds the path. Home matches only itself, so it never swallows a sub-page.
export function entryFor(pathname: string): NavEntry | null {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  let best: NavEntry | null = null;
  for (const entry of NAV) {
    const holds = entry.href === "/v2" ? path === "/v2" : path === entry.href || path.startsWith(`${entry.href}/`);
    if (holds && (best === null || entry.href.length > best.href.length)) best = entry;
  }
  return best;
}

// A journey's analytics page maps to its classic builder only for its owner or an admin. That rule
// needs the journey's owner, which the shell does not load, so the page names its classic page to
// the shell (ClassicPage), and this route table gives the journey list for anyone else.
export function classicHref(pathname: string, role: SystemRole): string {
  return entryFor(pathname)?.classic[role] ?? CLASSIC_HOME;
}

function entry(id: NavId): NavEntry {
  const found = NAV.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`No route table entry ${id}`);
  return found;
}

export function stageOf(id: NavId): Stage {
  return entry(id).stage;
}

// Where a link to a v2 page goes today: the page when the viewer may reach it, and otherwise the
// classic page that does its job for the role, or no link when classic has none (SHL-FR-01). A
// role that may not open the page gets no link (SHL-FR-04).
export function liveHref(id: NavId, viewer: Reach): string | null {
  const page = entry(id);
  if (!mayOpen(page.access, viewer.role)) return null;
  return stageLets(page.stage, viewer.preview) ? page.href : page.classic[viewer.role];
}

// Journey analytics, /v2/journeys/[id], sits under the Journeys entry and has its own stage.
export const JOURNEY_ANALYTICS: { stage: Stage } = { stage: "shipped" };

// Creating, editing, and deleting a segment in v2 (/v2/segments/new, /v2/segments/[id]) sit under
// the Audience entry, which lists segments to everyone, and have their own stage (SEG-FR-01).
export const SEGMENT_EDITOR: { stage: Stage } = { stage: "preview" };

// Create journey, /v2/journeys/new, sits under the Journeys entry and has its own stage. Until it
// ships, Create journey opens the classic builder for a viewer it does not let through.
export const JOURNEY_NEW = { stage: "preview", href: "/v2/journeys/new" } as const satisfies { stage: Stage; href: string };

/** The v2 builder of a server draft, which lane U3 owns. Every link to a draft goes through here. */
export function journeyDraftHref(draftId: string): string {
  return `/v2/journeys/drafts/${encodeURIComponent(draftId)}`;
}

// The builder opens a draft at /v2/journeys/drafts/[draftId] and has its own stage.
export const JOURNEY_BUILDER: { stage: Stage } = { stage: "preview" };

export type Viewer = { readonly userId: string; readonly role: SystemRole };

/** A link to a journey the viewer owns: its analytics, or the classic builder until analytics ships. */
export function ownJourneyHref(id: string): string {
  const encoded = encodeURIComponent(id);
  return JOURNEY_ANALYTICS.stage === "shipped" ? `/v2/journeys/${encoded}` : `/campaign/${encoded}`;
}

type OwnedJourney = { readonly id: string; readonly ownerId: string | null };

/** The classic builder refuses anyone but the journey's owner or an admin, so they get no link (JBD-FR-23). */
export function classicBuilderHref(journey: OwnedJourney, viewer: Viewer): string | null {
  const opens = viewer.role === "admin" || journey.ownerId === viewer.userId;
  return opens ? `/campaign/${encodeURIComponent(journey.id)}` : null;
}

/** A link to a published journey: its analytics for anyone, or before that ships, the classic builder. */
export function journeyHref(journey: OwnedJourney, viewer: Viewer): string | null {
  return JOURNEY_ANALYTICS.stage === "shipped" ? ownJourneyHref(journey.id) : classicBuilderHref(journey, viewer);
}
