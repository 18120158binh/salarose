import type { SqlQuery } from "@/lib/db";
import type { Span } from "@/shared/lib/time-range";

// The SQL of the home overview. Each statement reads one node type, or one node type and branch,
// per part of a UNION ALL: with IN or OR over several types Postgres leaves the
// (node_type, event_timestamp) and (node_type, transitioned_at) indexes for a scan.

/** The node types whose transitions the home overview counts by event time. */
export type CountedNodeType = "setup" | "engagement" | "watch";

function spanArrays(spans: readonly Span[]): [string[], string[]] {
  return [spans.map((span) => String(span.start)), spans.map((span) => String(span.end))];
}

const BUCKETS = "unnest($1::bigint[], $2::bigint[]) WITH ORDINALITY AS b(lo, hi, i)";

/**
 * Transitions of one node type whose event time falls in each span, per span, campaign, and
 * branch. A span is a bucket, numbered from 1 in the order given. `campaignIds` limits the count
 * to those campaigns. Without it every campaign counts, deleted ones included.
 */
export function eventTimeCounts(nodeType: CountedNodeType, spans: readonly Span[], campaignIds?: readonly string[]): SqlQuery {
  return {
    text: `SELECT b.i::int AS bucket, t.campaign_id, t.branch, count(*) AS n
FROM ${BUCKETS}
JOIN user_campaign_state_transitions t
  ON t.node_type = $3 AND t.event_timestamp >= b.lo AND t.event_timestamp < b.hi
WHERE $4::varchar[] IS NULL OR t.campaign_id = ANY($4::varchar[])
GROUP BY b.i, t.campaign_id, t.branch`,
    values: [...spanArrays(spans), nodeType, campaignIds ? [...campaignIds] : null],
  };
}

// Engine lag of one transition, in milliseconds: write time minus event time, or 0 when negative.
const LAG_MS = "greatest(0, extract(epoch FROM t.transitioned_at) * 1000 - t.event_timestamp)::float8";
const WRITTEN_IN_BUCKET = "t.transitioned_at >= to_timestamp(b.lo / 1000.0) AND t.transitioned_at < to_timestamp(b.hi / 1000.0)";

/**
 * The 95th percentile of engine lag, by the continuous rule, over the transitions written in
 * each span. Only setup and check transitions, and watch transitions on success, complete at the
 * time of their own event, so only they measure the engine. A span with none has no row.
 */
export function engineLagP95(spans: readonly Span[]): SqlQuery {
  return {
    text: `SELECT b.i::int AS bucket, percentile_cont(0.95) WITHIN GROUP (ORDER BY l.lag_ms) AS p95
FROM ${BUCKETS}
CROSS JOIN LATERAL (
  SELECT ${LAG_MS} AS lag_ms FROM user_campaign_state_transitions t
  WHERE t.node_type = 'setup' AND ${WRITTEN_IN_BUCKET}
  UNION ALL
  SELECT ${LAG_MS} FROM user_campaign_state_transitions t
  WHERE t.node_type = 'check' AND ${WRITTEN_IN_BUCKET}
  UNION ALL
  SELECT ${LAG_MS} FROM user_campaign_state_transitions t
  WHERE t.node_type = 'watch' AND t.branch = 'success' AND ${WRITTEN_IN_BUCKET}
) l
GROUP BY b.i`,
    values: spanArrays(spans),
  };
}

/** The newest write time of a setup, check, or watch transition, on any branch. */
export function lastTransition(): SqlQuery {
  return {
    text: `SELECT greatest(
  (SELECT max(transitioned_at) FROM user_campaign_state_transitions WHERE node_type = 'setup'),
  (SELECT max(transitioned_at) FROM user_campaign_state_transitions WHERE node_type = 'check'),
  (SELECT max(transitioned_at) FROM user_campaign_state_transitions WHERE node_type = 'watch')
) AS last_at`,
    values: [],
  };
}

/** Every active journey, with its owner, and the owner's email when the owner still exists. */
export function activeCampaigns(): SqlQuery {
  return {
    text: `SELECT c.id, c.name, c.created_user AS owner_id, u.email AS owner_email
FROM campaigns c
LEFT JOIN system_users u ON u.id = c.created_user
WHERE c.status = 'active'`,
    values: [],
  };
}

/** The viewer's own journeys, newest change first. */
export function ownCampaigns(userId: string, limit: number): SqlQuery {
  return {
    text: `SELECT id, name, status, updated_at
FROM campaigns
WHERE created_user = $1
ORDER BY updated_at DESC, id
LIMIT $2`,
    values: [userId, limit],
  };
}
