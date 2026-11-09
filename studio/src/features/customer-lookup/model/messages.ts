import type { SqlQuery } from '@/lib/db'
import { channelName } from '@/features/journey-analytics/model/labels'
import { parseJsonObject } from '@/features/journey-analytics/model/nodes'
import { integer, PAGE_SIZE, text, textOrNull, type Shown } from './queries'

type Row = Record<string, unknown>

/** CUS-FR-13: one engagement transition of the person, a request the journey handed to the sender. */
export type Message = {
  readonly key: string
  readonly campaignId: string
  /** The channel and the title, or the start of the body, such as `Push “Still thinking about it?”`. */
  readonly title: string
  /** Null when no `campaigns` row exists: the journey reads "Deleted journey". */
  readonly journeyName: string | null
  readonly sentAt: number
}

/** How much of a body stands in for a message without a title. */
const BODY_START = 60

/** The newest 50 engagement transitions by event time, with the journey's name when it still exists. */
export function messagesQuery(canonId: string): SqlQuery {
  return {
    text: `SELECT t.campaign_id, t.entry_id, t.node_id, t.branch, t.action_json, t.event_timestamp AS sent_at, c.name AS campaign_name,
  count(*) OVER ()::int AS total
FROM user_campaign_state_transitions t
LEFT JOIN campaigns c ON c.id = t.campaign_id
WHERE t.canon_id = $1 AND t.node_type = 'engagement'
ORDER BY t.event_timestamp DESC, t.campaign_id, t.entry_id, t.node_id, t.branch
LIMIT ${PAGE_SIZE}`,
    values: [canonId],
  }
}

function field(action: Record<string, unknown> | null, key: string): string | null {
  const value = action?.[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function bodyStart(body: string | null): string | null {
  if (body === null) return null
  const flat = body.replace(/\s+/g, ' ')
  return flat.length <= BODY_START ? flat : `${flat.slice(0, BODY_START).trimEnd()}…`
}

/** A transition whose action does not parse still lists, titled with the channel alone. */
export function parseMessages(rows: readonly Row[]): Shown<Message> {
  const total = rows.length === 0 ? 0 : integer(rows[0], 'total')
  return {
    rows: rows.map((row) => {
      const action = parseJsonObject(row.action_json)
      const channel = channelName(field(action, 'type'))
      const content = field(action, 'title') ?? field(action, 'subject') ?? bodyStart(field(action, 'body'))
      const campaignId = text(row, 'campaign_id')
      return {
        key: JSON.stringify([campaignId, text(row, 'entry_id'), text(row, 'node_id'), text(row, 'branch')]),
        campaignId,
        title: content === null ? channel : `${channel} “${content}”`,
        journeyName: textOrNull(row, 'campaign_name'),
        sentAt: integer(row, 'sent_at'),
      }
    }),
    more: Math.max(0, total - rows.length),
  }
}
