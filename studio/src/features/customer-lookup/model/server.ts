import 'server-only'
import { readOnly } from '@/lib/db'
import { referencedNames } from '@/features/journey-analytics/model/labels'
import {
  assembleWaitingSteps,
  campaignNodesQuery,
  nameLookup,
  namesQuery,
  nodesByCampaign,
  parseWaitingRows,
  waitingStepsQuery,
} from '@/features/journey-analytics/model/queries'
import { requireViewer } from '@/widgets/v2-shell/model/viewer'
import { assembleEntries, entryCampaignIds, type Entry } from './entries'
import { messagesQuery, parseMessages, type Message } from './messages'
import {
  entriesQuery,
  identitiesQuery,
  metricsQuery,
  parseIdentities,
  parseMetricRows,
  parsePerson,
  parseSearchRows,
  personQuery,
  searchQuery,
  type Identity,
  type MetricRow,
  type PersonSummary,
  type Shown,
} from './queries'
import { searchText } from './search'

// CUS-NFR-01 and CUS-NFR-02 ask for 1 and 2 seconds at p95. The bound only stops a runaway read,
// so that one region fails on its own.
const STATEMENT_TIMEOUT_MS = 5000

// CUS-FR-09: every staff user may search and open any profile, so the only check is the session.
// Nothing here logs the search text or a person's ids (CUS-NFR-03).

/** CUS-FR-01: every person the trimmed text names, newest last seen first. Empty text finds none. */
export async function searchCustomers(query: string): Promise<PersonSummary[]> {
  await requireViewer()
  const search = searchText(query)
  if (search === null) return []
  return readOnly(STATEMENT_TIMEOUT_MS, async (run) => parseSearchRows(await run(searchQuery(search))))
}

/** Null when the person id appears in no identity, transition, or metric. */
export async function loadPerson(canonId: string): Promise<PersonSummary | null> {
  await requireViewer()
  return readOnly(STATEMENT_TIMEOUT_MS, async (run) => parsePerson(await run(personQuery(canonId)), canonId))
}

export async function loadIdentities(canonId: string): Promise<Shown<Identity>> {
  await requireViewer()
  return readOnly(STATEMENT_TIMEOUT_MS, async (run) => parseIdentities(await run(identitiesQuery(canonId))))
}

export async function loadEntries(canonId: string): Promise<Shown<Entry>> {
  await requireViewer()
  return readOnly(STATEMENT_TIMEOUT_MS, async (run) => {
    const rows = await run(entriesQuery(canonId))
    if (rows.length === 0) return { rows: [], more: 0 }
    const nodes = nodesByCampaign(await run(campaignNodesQuery(entryCampaignIds(rows))))
    const names = nameLookup(await run(namesQuery(referencedNames([...nodes.values()].flat()))))
    const waiting = assembleWaitingSteps(parseWaitingRows(await run(waitingStepsQuery(canonId))), nodes, names)
    return assembleEntries(rows, nodes, waiting, names)
  })
}

export async function loadMetrics(canonId: string): Promise<MetricRow[]> {
  await requireViewer()
  return readOnly(STATEMENT_TIMEOUT_MS, async (run) => parseMetricRows(await run(metricsQuery(canonId))))
}

/** CUS-FR-13: the newest 50 messages journeys sent the person, with the count of the rest. */
export async function loadMessages(canonId: string): Promise<Shown<Message>> {
  await requireViewer()
  return readOnly(STATEMENT_TIMEOUT_MS, async (run) => parseMessages(await run(messagesQuery(canonId))))
}
