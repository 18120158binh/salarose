import type { SqlQuery } from '@/lib/db'
import { metricLabel, metricValue, parseBuckets, parseMetricFunction, type MetricLabel, type MetricValue } from './metrics'
import type { SearchText } from './search'

type Row = Record<string, unknown>

/** CUS-FR-05, CUS-FR-06: each profile table shows this many rows and counts the rest. */
export const PAGE_SIZE = 50

/** A slice of a longer list: the rows shown and how many more exist. */
export type Shown<T> = { readonly rows: readonly T[]; readonly more: number }

export type PersonSummary = {
  readonly canonId: string
  /** The user id of the identity with the newest `updated_at` among those with one. */
  readonly newestUserId: string | null
  readonly devices: number
  readonly firstSeen: number | null
  readonly lastSeen: number | null
}

export type Identity = {
  readonly deviceId: string
  readonly userId: string | null
  readonly firstSeen: number | null
  readonly lastSeen: number | null
}

export type MetricRow = {
  readonly metricId: string
  readonly label: MetricLabel
  readonly asOf: number
  /** A PAUSED definition is not updated, so its stored value shows marked "Not updating". */
  readonly paused: boolean
  readonly value: MetricValue
}

const epochMs = (column: string) => `(extract(epoch FROM ${column}) * 1000)::bigint`

// The newest user id walks idx_ig_canon_latest. The aggregates read idx_ig_canon.
function summarySql(canon: string): string {
  return `SELECT
  (SELECT count(*)::int FROM identity_graph g WHERE g.canon_id = ${canon}) AS devices,
  (SELECT ${epochMs('min(g.created_at)')} FROM identity_graph g WHERE g.canon_id = ${canon}) AS first_seen,
  (SELECT ${epochMs('max(g.updated_at)')} FROM identity_graph g WHERE g.canon_id = ${canon}) AS last_seen,
  (SELECT g.user_id FROM identity_graph g WHERE g.canon_id = ${canon} AND g.user_id IS NOT NULL
   ORDER BY g.updated_at DESC NULLS LAST, g.domain_userid DESC LIMIT 1) AS newest_user_id`
}

/**
 * CUS-FR-01, CUS-FR-11. Each match reads one index: the primary key for the device id,
 * idx_ig_user_latest for the user id and its contact forms, idx_ig_canon for a person id in identity_graph, and the primary keys of
 * user_campaign_state_transitions and user_metrics, which start with canon_id.
 */
export function searchQuery(search: SearchText): SqlQuery {
  return {
    text: `WITH hits AS (
  SELECT canon_id FROM identity_graph WHERE domain_userid = $1
  UNION SELECT canon_id FROM identity_graph WHERE user_id = ANY($2::varchar[])
  UNION (SELECT canon_id FROM identity_graph WHERE canon_id = $1 LIMIT 1)
  UNION (SELECT canon_id FROM user_campaign_state_transitions WHERE canon_id = $1 LIMIT 1)
  UNION (SELECT canon_id FROM user_metrics WHERE canon_id = $1 LIMIT 1)
)
SELECT h.canon_id, s.devices, s.first_seen, s.last_seen, s.newest_user_id
FROM hits h CROSS JOIN LATERAL (${summarySql('h.canon_id')}) s
WHERE h.canon_id <> ''
ORDER BY s.last_seen DESC NULLS LAST, h.canon_id`,
    values: [search.exact, search.userIds],
  }
}

export function personQuery(canonId: string): SqlQuery {
  return {
    text: `SELECT s.*,
  EXISTS (SELECT 1 FROM user_campaign_state_transitions WHERE canon_id = $1) AS has_entries,
  EXISTS (SELECT 1 FROM user_metrics WHERE canon_id = $1) AS has_metrics
FROM (${summarySql('$1')}) s`,
    values: [canonId],
  }
}

export function identitiesQuery(canonId: string): SqlQuery {
  return {
    text: `SELECT domain_userid, user_id, ${epochMs('created_at')} AS first_seen, ${epochMs('updated_at')} AS last_seen,
  count(*) OVER ()::int AS total
FROM identity_graph WHERE canon_id = $1
ORDER BY updated_at DESC NULLS LAST, domain_userid
LIMIT ${PAGE_SIZE}`,
    values: [canonId],
  }
}

/**
 * CUS-FR-06. The newest 50 entries by the time each entered, with the transitions at each entry's
 * latest event time, so that the last step's ties are broken in code against the journey's tree.
 */
export function entriesQuery(canonId: string): SqlQuery {
  return {
    text: `WITH t AS (
  SELECT campaign_id, entry_id, node_id, node_type, event_timestamp, transitioned_at
  FROM user_campaign_state_transitions WHERE canon_id = $1
),
entries AS (
  SELECT campaign_id, entry_id,
    coalesce(min(event_timestamp) FILTER (WHERE node_type = 'setup'), min(event_timestamp)) AS entered,
    max(event_timestamp) AS last_at,
    count(*) OVER ()::int AS total
  FROM t GROUP BY campaign_id, entry_id
  ORDER BY entered DESC, campaign_id, entry_id
  LIMIT ${PAGE_SIZE}
)
SELECT e.campaign_id, e.entry_id, e.entered, e.total, c.name AS campaign_name, c.created_user,
  t.node_id, t.node_type, ${epochMs('t.transitioned_at')} AS written_at
FROM entries e
JOIN t ON t.campaign_id = e.campaign_id AND t.entry_id = e.entry_id AND t.event_timestamp = e.last_at
LEFT JOIN campaigns c ON c.id = e.campaign_id
ORDER BY e.entered DESC, e.campaign_id, e.entry_id, t.node_id`,
    values: [canonId],
  }
}

export function metricsQuery(canonId: string): SqlQuery {
  return {
    text: `SELECT m.metric_id, m.series_clock, m.buckets, d.event_name, e.display_name AS event_display_name,
  d.agg_operator, d.agg_field, d.retention_ms, d.processing_mode
FROM user_metrics m JOIN user_metric_definitions d ON d.id = m.metric_id
LEFT JOIN user_events e ON e.event_name = d.event_name
WHERE m.canon_id = $1
ORDER BY m.series_clock DESC, m.metric_id`,
    values: [canonId],
  }
}

export function text(row: Row, column: string): string {
  const value = row[column]
  if (typeof value !== 'string') throw new Error(`Expected text in ${column}, got ${typeof value}.`)
  return value
}

export function textOrNull(row: Row, column: string): string | null {
  return row[column] === null || row[column] === undefined ? null : text(row, column)
}

// node-postgres returns bigint columns as strings.
export function integerOrNull(row: Row, column: string): number | null {
  const value = row[column]
  if (value === null || value === undefined) return null
  const number = typeof value === 'number' ? value : typeof value === 'string' || typeof value === 'bigint' ? Number(value) : NaN
  if (!Number.isSafeInteger(number)) throw new Error(`Expected an integer in ${column}, got ${String(value)}.`)
  return number
}

export function integer(row: Row, column: string): number {
  const value = integerOrNull(row, column)
  if (value === null) throw new Error(`Expected an integer in ${column}, got null.`)
  return value
}

export function parseSummary(row: Row, canonId: string): PersonSummary {
  return {
    canonId,
    newestUserId: textOrNull(row, 'newest_user_id'),
    devices: integer(row, 'devices'),
    firstSeen: integerOrNull(row, 'first_seen'),
    lastSeen: integerOrNull(row, 'last_seen'),
  }
}

export function parseSearchRows(rows: readonly Row[]): PersonSummary[] {
  return rows.map((row) => parseSummary(row, text(row, 'canon_id')))
}

/** Null when the person id appears nowhere: no identity, no transition, no metric. */
export function parsePerson(rows: readonly Row[], canonId: string): PersonSummary | null {
  const [row] = rows
  if (row === undefined) return null
  const summary = parseSummary(row, canonId)
  return summary.devices > 0 || row.has_entries === true || row.has_metrics === true ? summary : null
}

export function parseIdentities(rows: readonly Row[]): Shown<Identity> {
  const total = rows.length === 0 ? 0 : integer(rows[0], 'total')
  return {
    rows: rows.map((row) => ({
      deviceId: text(row, 'domain_userid'),
      userId: textOrNull(row, 'user_id'),
      firstSeen: integerOrNull(row, 'first_seen'),
      lastSeen: integerOrNull(row, 'last_seen'),
    })),
    more: Math.max(0, total - rows.length),
  }
}

// node-postgres parses jsonb. A driver that hands back the text gets it parsed here.
function json(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/** A series whose buckets do not parse reads "Not available". The other rows still show. */
export function parseMetricRows(rows: readonly Row[]): MetricRow[] {
  return rows.map((row) => {
    const fn = parseMetricFunction(row.agg_operator)
    const asOf = integer(row, 'series_clock')
    const buckets = parseBuckets(json(row.buckets))
    return {
      metricId: text(row, 'metric_id'),
      label: metricLabel(text(row, 'event_name'), textOrNull(row, 'event_display_name'), fn, textOrNull(row, 'agg_field')?.trim() || null, integer(row, 'retention_ms')),
      asOf,
      paused: row.processing_mode === 'PAUSED',
      value: buckets === null ? { kind: 'not-available' } : metricValue(fn, buckets, asOf),
    }
  })
}
