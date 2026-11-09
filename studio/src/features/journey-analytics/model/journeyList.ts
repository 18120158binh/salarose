import type { SqlQuery } from '@/lib/db'
import type { CountRow } from '@/features/home-overview/model/home'
import type { Viewer } from '@/widgets/v2-shell/model/routes'

type Row = Record<string, unknown>

export type PublishedStatus = 'active' | 'paused'
export type JourneyStatus = 'draft' | PublishedStatus

/** An `active` or `paused` row of `campaigns`, with its owner when the owner still exists. */
export type JourneySummary = {
  readonly id: string
  readonly name: string
  readonly status: PublishedStatus
  readonly ownerId: string | null
  readonly ownerEmail: string | null
  /** Epoch ms, or null when the row has no `updated_at`. */
  readonly updatedAt: number | null
}

/** A published journey in the list, with its setup transitions in the last 7 days. */
export type PublishedJourney = JourneySummary & { readonly kind: 'published'; readonly entries: number }

/**
 * A draft of the viewer's: a row of `journey_drafts`, or one the classic builder keeps in this
 * browser. It has no owner row and no numbers.
 */
export type DraftJourney = {
  readonly kind: 'draft'
  readonly source: 'server' | 'browser'
  readonly id: string
  readonly name: string
  readonly updatedAt: number | null
  /** Where the draft came from, as the line under its name says, or null for a browser draft. */
  readonly note: string | null
}

export type JourneyRow = PublishedJourney | DraftJourney

export const OWNER_FILTERS = ['mine', 'all'] as const
export type OwnerFilter = (typeof OWNER_FILTERS)[number]

export const STATUS_FILTERS = ['any', 'draft', 'active', 'paused'] as const
export type StatusFilter = (typeof STATUS_FILTERS)[number]

export const SORTS = ['updated', 'name', 'entries'] as const
export type JourneySort = (typeof SORTS)[number]

export type ListQuery = {
  readonly search: string
  readonly owner: OwnerFilter
  readonly status: StatusFilter
  readonly sort: JourneySort
}

export const DEFAULT_QUERY: ListQuery = { search: '', owner: 'mine', status: 'any', sort: 'updated' }

const PUBLISHED_CAMPAIGNS = `SELECT c.id, c.name, c.status, c.created_user AS owner_id, u.email AS owner_email, c.updated_at
FROM campaigns c
LEFT JOIN system_users u ON u.id = c.created_user
WHERE c.status IN ('active', 'paused')`

/** JBD-FR-18: the `active` and `paused` rows of `campaigns`, with the owner when the owner still exists. */
export function publishedCampaignsQuery(): SqlQuery {
  return { text: PUBLISHED_CAMPAIGNS, values: [] }
}

/** JBD-FR-19: one published campaign. No row means the id names no published campaign. */
export function publishedCampaignQuery(id: string): SqlQuery {
  return { text: `${PUBLISHED_CAMPAIGNS} AND c.id = $1`, values: [id] }
}

const isPublishedStatus = (value: unknown): value is PublishedStatus => value === 'active' || value === 'paused'
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)

function instant(value: unknown): number | null {
  const time = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(time) ? time : null
}

/** A row of the published campaigns query. A row without an id, a name, or a published status is null. */
export function parseJourneySummary(row: Row): JourneySummary | null {
  if (typeof row.id !== 'string' || typeof row.name !== 'string' || !isPublishedStatus(row.status)) return null
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    ownerId: textOrNull(row.owner_id),
    ownerEmail: textOrNull(row.owner_email),
    updatedAt: instant(row.updated_at),
  }
}

/** The published journeys, each with the sum of its setup transition counts over every branch. */
export function publishedJourneys(campaigns: readonly Row[], setupCounts: readonly CountRow[]): PublishedJourney[] {
  const entries = new Map<string, number>()
  for (const count of setupCounts) entries.set(count.campaignId, (entries.get(count.campaignId) ?? 0) + count.n)
  return campaigns.flatMap((row) => {
    const summary = parseJourneySummary(row)
    return summary === null ? [] : [{ ...summary, kind: 'published', entries: entries.get(summary.id) ?? 0 }]
  })
}

/**
 * The viewer's browser drafts as rows. A draft whose id is published already is left out, as the
 * classic list does.
 */
export function draftRows(
  drafts: readonly { id: string; name: string; updated_at: string }[],
  published: readonly PublishedJourney[],
): DraftJourney[] {
  const publishedIds = new Set(published.map((journey) => journey.id))
  return drafts
    .filter((draft) => !publishedIds.has(draft.id))
    .map((draft) => ({ kind: 'draft', source: 'browser', id: draft.id, name: draft.name, updatedAt: instant(draft.updated_at), note: null }))
}

function originNote(origin: string, published: readonly PublishedJourney[], templateName: (key: string) => string | undefined): string {
  if (origin === 'blank') return 'Started blank'
  if (origin === 'ai') return 'Described with AI'
  if (origin === 'browser') return 'Moved from this browser'
  if (origin.startsWith('template:')) {
    const name = templateName(origin.slice('template:'.length))
    return name === undefined ? 'From a template' : `From template ${name}`
  }
  if (origin.startsWith('duplicate:')) {
    const source = published.find((journey) => journey.id === origin.slice('duplicate:'.length))
    return source === undefined ? 'Duplicated from a journey' : `Duplicated from ${source.name}`
  }
  return ''
}

/** The viewer's drafts in `journey_drafts` as rows, each with the note on where it came from. */
export function serverDraftRows(
  drafts: readonly { id: string; name: string; origin: string; updatedAt: string }[],
  published: readonly PublishedJourney[],
  templateName: (key: string) => string | undefined,
): DraftJourney[] {
  return drafts.map((draft) => ({
    kind: 'draft',
    source: 'server',
    id: draft.id,
    name: draft.name,
    updatedAt: instant(draft.updatedAt),
    note: originNote(draft.origin, published, templateName) || null,
  }))
}

export function statusOf(row: JourneyRow): JourneyStatus {
  return row.kind === 'draft' ? 'draft' : row.status
}

/**
 * A browser draft belongs to the viewer, so it counts as Mine and never shows under All. An admin's
 * Mine also holds the journeys whose owner was deleted, as the classic list does.
 */
function passesOwner(row: JourneyRow, owner: OwnerFilter, viewer: Viewer): boolean {
  if (row.kind === 'draft') return owner === 'mine'
  return owner === 'all' || row.ownerId === viewer.userId || (viewer.role === 'admin' && row.ownerId === null)
}

const byName = (a: JourneyRow, b: JourneyRow): number => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id)

// Newest first. A row with no time sorts last.
const byUpdated = (a: JourneyRow, b: JourneyRow): number => (b.updatedAt ?? -Infinity) - (a.updatedAt ?? -Infinity) || byName(a, b)

// Most entries first. A draft has no entries, so it sorts after every published journey.
const entriesOf = (row: JourneyRow): number => (row.kind === 'draft' ? -1 : row.entries)
const byEntries = (a: JourneyRow, b: JourneyRow): number => entriesOf(b) - entriesOf(a) || byUpdated(a, b)

const COMPARE: Record<JourneySort, (a: JourneyRow, b: JourneyRow) => number> = {
  updated: byUpdated,
  name: byName,
  entries: byEntries,
}

// The rows the owner filter and the search leave, before the status filter.
function pool(rows: readonly JourneyRow[], query: ListQuery, viewer: Viewer): JourneyRow[] {
  const needle = query.search.trim().toLowerCase()
  return rows.filter((row) => passesOwner(row, query.owner, viewer) && (needle === '' || row.name.toLowerCase().includes(needle)))
}

/** JBD-FR-18: the rows the search, the filters, and the sort leave, in order. */
export function visibleJourneys(rows: readonly JourneyRow[], query: ListQuery, viewer: Viewer): JourneyRow[] {
  return pool(rows, query, viewer)
    .filter((row) => query.status === 'any' || statusOf(row) === query.status)
    .sort(COMPARE[query.sort])
}

/** How many rows each status filter would leave under the current owner filter and search. */
export function statusCounts(rows: readonly JourneyRow[], query: ListQuery, viewer: Viewer): Record<StatusFilter, number> {
  const counts: Record<StatusFilter, number> = { any: 0, draft: 0, active: 0, paused: 0 }
  for (const row of pool(rows, query, viewer)) {
    counts.any += 1
    counts[statusOf(row)] += 1
  }
  return counts
}

export type RowAction = 'open' | 'duplicate' | 'pause' | 'resume' | 'delete'

/** CMP-FR-07: the owner or an admin manages a published journey. */
export function managesJourney(journey: { readonly ownerId: string | null }, viewer: Viewer): boolean {
  return viewer.role === 'admin' || journey.ownerId === viewer.userId
}

/**
 * CMP-FR-07 to CMP-FR-09, JBD-FR-23: the actions a row's menu offers, in order. An action the viewer
 * may not take is absent. Duplicate makes a draft only the v2 builder opens, so it needs that
 * builder (`canBuild`). The classic builder owns a browser draft, so the menu only opens it.
 */
export function rowActions(row: JourneyRow, viewer: Viewer, canBuild: boolean): RowAction[] {
  if (row.kind === 'draft') return row.source === 'server' ? ['open', 'delete'] : ['open']
  const actions: RowAction[] = canBuild ? ['open', 'duplicate'] : ['open']
  if (!managesJourney(row, viewer)) return actions
  return [...actions, row.status === 'active' ? 'pause' : 'resume', 'delete']
}
