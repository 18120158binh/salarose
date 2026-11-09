import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import {
  type UserEventDef,
  type UserEventFieldDef,
  type UserEventPage,
  type UserEventPageCursor,
  type UserEventUsage,
  type UserEventUsageCampaign,
} from "../types/index";
import type { Campaign, CampaignTreeNode } from "../types/campaigns";
import {
  activeMetricRetentions,
  addMetricWindow,
  attributeValuesCondition,
  behaviorConditionsIn,
  metricDisplayName,
  metricMeasure,
  metricValueType,
  type MetricReferenceRow,
} from "./metricDefinitions";
import {
  DuplicateEventNameError,
  type EventKind,
  parseEventAttributePath,
  parseEventAttributeType,
  parseEventStatus,
  parseEventSystemName,
  parseNewEventAttributes,
} from "./eventCatalog";
import {
  behaviorConditions,
  newSegmentId,
  parseBehaviorCondition,
  parseSegmentConditions,
  parseUsingCampaignStatus,
  segmentUsesOfNodeRow,
  SEGMENT_USE_KINDS,
  type BehaviorCondition,
  type EventPropertyCondition,
  type Segment,
  type SegmentId,
  type SegmentInput,
  type SegmentUse,
} from "./segments";
import { UserFacingError } from "./userFacingError";

let pool: Pool | null = null;
let isInitialized = false;
let initPromise: Promise<void> | null = null;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set. Copy studio/.env.example to studio/.env.local.");
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

// infra/db/schema.sql is the only source of the schema, and every environment applies it before
// studio starts (decision 0019). Studio only checks that the tables it reads exist. A table that studio starts to read goes in REQUIRED_TABLES once schema.sql creates it.
const REQUIRED_TABLES = [
  "system_users",
  "system_user_id_tokens",
  "campaigns",
  "campaign_nodes",
  "campaign_node_stats",
  "user_events",
  "user_event_fields",
  "user_metric_definitions",
  "segments",
  "journey_drafts",
  "journey_publishes",
  "ingestion_source_keys",
  "import_record_types",
  "import_record_type_versions",
  "import_metric_definitions",
  "import_source_scopes",
  "import_runs",
  "import_metric_passes",
  "pii_access_log",
  "person_tombstones",
  "user_campaign_state_transitions",
  "event_volume",
];

export async function ensureDbInitialized() {
  if (isInitialized) return;
  if (initPromise) return initPromise;

  const pending = (async () => {
    const p = getPool();
    const missing = await p.query<{ name: string }>(
      "SELECT name FROM unnest($1::text[]) WITH ORDINALITY AS t(name, position) WHERE to_regclass(name) IS NULL ORDER BY position",
      [REQUIRED_TABLES],
    );
    if (missing.rows.length > 0) {
      const names = missing.rows.map((row) => row.name).join(", ");
      throw new Error(`Postgres has no ${names}. Apply infra/db/schema.sql before starting studio.`);
    }

    isInitialized = true;
  })();
  initPromise = pending;
  pending.catch(() => {
    if (initPromise === pending) initPromise = null;
  });
  return pending;
}

export interface SystemUser {
  id: string;
  email: string;
  role: string;
}

// A system user with the session epoch its session cookies must carry. A cookie signed at a
// lower epoch is no longer valid.
export interface SystemUserAccount extends SystemUser {
  session_epoch: number;
}

// The provider account a sign-in proves, and what its ID token says about the person.
export interface SignInAccount {
  issuer: string;
  subject: string;
  email: string;
  role: string;
}

// Creates the user for a provider account at its first sign-in, or updates the role and email of
// the user that has it. One statement keyed by the account, so a retried or concurrent
// sign-in converges on one row. The id of a new row is never used when the account exists.
export async function upsertSystemUserFromSignIn(account: SignInAccount): Promise<SystemUserAccount> {
  await ensureDbInitialized();
  const res = await getPool().query(
    `INSERT INTO system_users (id, email, role, oidc_issuer, oidc_subject) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (oidc_issuer, oidc_subject) DO UPDATE SET email = EXCLUDED.email, role = EXCLUDED.role
     RETURNING id, email, role, session_epoch`,
    [`user_${randomUUID()}`, account.email, account.role, account.issuer, account.subject],
  );
  return res.rows[0];
}

export async function getAdminUserById(id: string): Promise<SystemUserAccount | null> {
  await ensureDbInitialized();
  const res = await getPool().query("SELECT id, email, role, session_epoch FROM system_users WHERE id = $1", [id]);
  return res.rows[0] || null;
}

// The preview flag of a staff user. A missing user has none.
export async function getSystemUserPreview(id: string): Promise<boolean> {
  await ensureDbInitialized();
  const res = await getPool().query("SELECT preview FROM system_users WHERE id = $1", [id]);
  return res.rows[0]?.preview === true;
}

// Ends every session of a user by raising the epoch their session cookies must carry. Only a
// cookie at or above the current epoch raises it, so a repeated or stale sign-out does not end
// sessions signed in after it.
export async function endSystemUserSessions(id: string, cookieEpoch: number): Promise<void> {
  await ensureDbInitialized();
  await getPool().query(
    "UPDATE system_users SET session_epoch = session_epoch + 1 WHERE id = $1 AND session_epoch <= $2",
    [id, cookieEpoch],
  );
}

// Keeps the ID token of a user's sign-in at this session epoch, for the provider sign-out. A later
// sign-in replaces it, so the table holds at most one row per user.
export async function saveSystemUserIdToken(id: string, sessionEpoch: number, idToken: string): Promise<void> {
  await ensureDbInitialized();
  await getPool().query(
    `INSERT INTO system_user_id_tokens (user_id, session_epoch, id_token) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET session_epoch = EXCLUDED.session_epoch, id_token = EXCLUDED.id_token,
       created_at = CURRENT_TIMESTAMP`,
    [id, sessionEpoch, idToken],
  );
}

// Removes and returns the ID token stored at this session epoch. A token from another epoch
// belongs to another sign-in and stays.
export async function takeSystemUserIdToken(id: string, sessionEpoch: number): Promise<string | null> {
  await ensureDbInitialized();
  const res = await getPool().query(
    "DELETE FROM system_user_id_tokens WHERE user_id = $1 AND session_epoch = $2 RETURNING id_token",
    [id, sessionEpoch],
  );
  return res.rows[0]?.id_token ?? null;
}

export interface DbCampaignNode {
  campaign_id: string;
  node_id: string;
  node_type: string;
  parent_node_id: string | null;
  parent_branch: string | null;
  trigger_json: string | null;
  conditions_json: string | null;
  paths_json: string | null;
  action_json: string | null;
  goal_id: string | null;
}

// The campaigns the actor can manage from the list: their own, and for an admin also the
// campaigns with no owner, which nobody else can manage.
export async function getCampaigns(actor: CampaignActor): Promise<Campaign[]> {
  await ensureDbInitialized();
  const res = await getPool().query(
    "SELECT * FROM campaigns WHERE created_user = $1 OR ($2 AND created_user IS NULL) ORDER BY created_at DESC",
    [actor.userId, actor.isAdmin],
  );
  return res.rows.flatMap((row) => {
    const campaign = parseCampaignRow(row);
    if (!campaign) console.warn(`Leaving campaign ${String(row.id)} out of the list: its row does not parse.`);
    return campaign ? [campaign] : [];
  });
}

// The statuses a campaign row can have. A draft is never stored.
type StoredCampaignStatus = "active" | "paused";

function parseStoredStatus(value: unknown): StoredCampaignStatus | null {
  return value === "active" || value === "paused" ? value : null;
}

// pg returns a TIMESTAMP WITH TIME ZONE column as a Date.
function timestampText(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return typeof value === "string" ? value : null;
}

// A campaigns row as the list shows it. The status column is free text, so a row written by
// hand or by an older writer can hold any status. The journey in root is checked only for a
// setup node at its top, which the list's summary starts from; publish and resume parse it all.
function parseCampaignRow(row: Record<string, unknown>): Campaign | null {
  const { id, name, description, root, created_user } = row;
  const status = parseStoredStatus(row.status);
  const createdAt = timestampText(row.created_at);
  const updatedAt = timestampText(row.updated_at);
  if (typeof id !== "string" || typeof name !== "string" || !status || !createdAt || !updatedAt) return null;
  if (description !== null && typeof description !== "string") return null;
  if (created_user !== null && typeof created_user !== "string") return null;
  if (typeof root !== "object" || root === null || (root as { type?: unknown }).type !== "setup") return null;
  return {
    id,
    name,
    description: description ?? "",
    status,
    root: root as CampaignTreeNode,
    created_at: createdAt,
    updated_at: updatedAt,
    ownerless: created_user === null,
  };
}

// One campaign, for its owner or an admin. Anyone else gets null, as for an id that does not
// exist, so the builder does not reveal another user's campaign.
export async function getCampaign(id: string, actor: CampaignActor): Promise<Campaign | null> {
  await ensureDbInitialized();
  const res = await getPool().query("SELECT * FROM campaigns WHERE id = $1", [id]);
  const row = res.rows[0];
  if (!row || (!actor.isAdmin && row.created_user !== actor.userId)) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    status: row.status as "active" | "paused",
    root: row.root,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ownerless: row.created_user === null,
  };
}

// The users on each node of a campaign. The counts are returned only to the owner or an admin,
// the callers who may pause, resume, or delete it. Anyone else gets no rows.
export async function getCampaignNodeStats(
  campaignId: string,
  actor: CampaignActor,
): Promise<Record<string, number>> {
  await ensureDbInitialized();
  const pool = getPool();
  
  // Return early if not initialized (e.g. build time)
  if (!pool) return {};

  const result = await pool.query(`
    SELECT s.node_id, s.user_count
    FROM campaign_node_stats s
    JOIN campaigns c ON c.id = s.campaign_id
    WHERE s.campaign_id = $1 AND (c.created_user = $2 OR $3)
  `, [campaignId, actor.userId, actor.isAdmin]);

  const stats: Record<string, number> = {};
  for (const row of result.rows) {
    stats[row.node_id] = parseInt(row.user_count, 10);
  }
  return stats;
}

export function collectMetricIdsFromPredicate(
  predicate: unknown,
  metricIds: Set<string> = new Set(),
): Set<string> {
  if (!predicate || typeof predicate !== "object") return metricIds;

  const node = predicate as {
    type?: string;
    left?: unknown;
    expressions?: unknown[];
  };
  if (
    node.type === "comparison"
    && typeof node.left === "string"
    && node.left.length > 0
  ) {
    metricIds.add(node.left);
  }
  if (
    (node.type === "and" || node.type === "or")
    && Array.isArray(node.expressions)
  ) {
    node.expressions.forEach((expression) =>
      collectMetricIdsFromPredicate(expression, metricIds));
  }
  return metricIds;
}

interface EventMetricMetadata {
  eventName: string;
  eventLabel: string;
  // The catalog's default value of each attribute path that has one.
  defaultValues: Record<string, string>;
  fieldLabels: Map<string, string>;
  fieldTypes: Map<string, string>;
}

function unqualifiedFieldName(field: string): string {
  const parts = field.split(".");
  return parts[parts.length - 1];
}

async function loadEventMetricMetadata(
  client: PoolClient,
  eventId: string,
): Promise<EventMetricMetadata> {
  const eventResult = await client.query(
    `SELECT event_name, display_name
     FROM user_events
     WHERE id = $1
     LIMIT 1`,
    [eventId],
  );
  if (eventResult.rows.length === 0) {
    throw new UserFacingError(`Unknown metrics user_event_id: ${eventId}`);
  }

  const fieldResult = await client.query(
    `SELECT field_path, display_name, default_value, data_type
     FROM user_event_fields
     WHERE user_event_id = $1`,
    [eventId],
  );
  const defaultValues: Record<string, string> = {};
  const fieldLabels = new Map<string, string>();
  const fieldTypes = new Map<string, string>();
  for (const row of fieldResult.rows) {
    const fieldPath = String(row.field_path);
    const fieldName = unqualifiedFieldName(fieldPath);
    const fieldLabel = String(row.display_name || fieldName);
    fieldLabels.set(fieldPath, fieldLabel);
    fieldLabels.set(fieldName, fieldLabel);
    fieldTypes.set(fieldPath, String(row.data_type));
    fieldTypes.set(fieldName, String(row.data_type));
    if (row.default_value !== null && row.default_value !== "") {
      defaultValues[fieldPath] = String(row.default_value);
    }
  }

  return {
    eventName: String(eventResult.rows[0].event_name),
    eventLabel: String(
      eventResult.rows[0].display_name || eventResult.rows[0].event_name,
    ),
    defaultValues,
    fieldLabels,
    fieldTypes,
  };
}

// The catalog type of a metric's attribute, by its path or else by its last segment.
function catalogFieldType(metadata: EventMetricMetadata, field: string | null): string | null {
  if (!field) return null;
  return metadata.fieldTypes.get(field)
    ?? metadata.fieldTypes.get(unqualifiedFieldName(field))
    ?? null;
}

// Serializes every transaction that reads metric references and then writes from them, so that
// each one sees the references of every transaction that took the lock before it. Postgres
// releases the lock at commit or rollback.
async function lockMetricDefinitions(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('user_metric_definitions'))");
}

// Every campaign node row that can reference a metric: one with conditions, or with the
// branches of a multi-branch check, which may hold behavior conditions.
async function loadMetricReferences(client: PoolClient): Promise<MetricReferenceRow[]> {
  const result = await client.query(`
    SELECT campaign_nodes.campaign_id, campaign_nodes.node_id,
           campaign_nodes.conditions_json, campaign_nodes.paths_json, campaigns.status
    FROM campaign_nodes
    JOIN campaigns ON campaigns.id = campaign_nodes.campaign_id
    WHERE campaign_nodes.conditions_json IS NOT NULL OR campaign_nodes.paths_json IS NOT NULL
  `);
  return result.rows;
}

// Step 4 of publish: a definition that a behavior condition of an active campaign or of any segment
// names is LIVE and keeps the longest of those conditions' windows. Any other definition is PAUSED
// and keeps its retention period.
async function syncMetricProcessingModes(client: PoolClient): Promise<void> {
  await lockMetricDefinitions(client);
  const retentions = activeMetricRetentions(await loadMetricReferences(client));
  await addSegmentRetentions(client, retentions);
  const liveIds = [...retentions.keys()];
  const retained = [...retentions].filter((entry): entry is [string, number] => entry[1] !== null);

  await client.query(`
    UPDATE user_metric_definitions
    SET processing_mode = CASE
          WHEN id = ANY($1::text[]) THEN 'LIVE'
          ELSE 'PAUSED'
        END,
        updated_at = CURRENT_TIMESTAMP
    WHERE processing_mode IN ('LIVE', 'PAUSED')
      AND processing_mode IS DISTINCT FROM CASE
        WHEN id = ANY($1::text[]) THEN 'LIVE'
        ELSE 'PAUSED'
      END
  `, [liveIds]);
  await client.query(`
    UPDATE user_metric_definitions
    SET retention_ms = live.retention_ms, updated_at = CURRENT_TIMESTAMP
    FROM unnest($1::text[], $2::bigint[]) AS live(id, retention_ms)
    WHERE user_metric_definitions.id = live.id
      AND user_metric_definitions.retention_ms IS DISTINCT FROM live.retention_ms
  `, [retained.map(([id]) => id), retained.map(([, ms]) => ms)]);
}

// The campaign fields that publishing writes. The status is always `active`.
export type PublishedCampaign = Pick<Campaign, "id" | "name" | "description" | "root">;

// The staff user changing a campaign. CMP-FR-07: the owner or an admin may pause, resume, or
// delete it.
export interface CampaignActor {
  userId: string;
  isAdmin: boolean;
}

export function campaignActor(session: { userId: string; role: string }): CampaignActor {
  return { userId: session.userId, isAdmin: session.role === "admin" };
}

// Builds a campaign's node rows from its journey. Studio passes flattenCampaignTree, so the
// rows written always describe the tree stored in campaigns.root.
export type CampaignNodeBuilder = (campaignId: string, root: CampaignTreeNode) => DbCampaignNode[];

// Builds a campaign's node rows from the journey stored in campaigns.root, which is unchecked
// JSON until the builder parses it.
export type StoredCampaignNodeBuilder = (campaignId: string, storedRoot: unknown) => DbCampaignNode[];

// A campaign row locked for a change. The status is the stored text, which may be any value.
interface LockedCampaign {
  status: string;
  root: unknown;
}

// Locks the campaign row for the rest of the transaction, checks that the actor may change it,
// and returns its stored status and journey.
async function lockCampaignForChange(
  client: PoolClient,
  campaignId: string,
  actor: CampaignActor,
): Promise<LockedCampaign> {
  const result = await client.query(
    "SELECT created_user, status, root FROM campaigns WHERE id = $1 FOR UPDATE",
    [campaignId],
  );
  if (result.rows.length === 0) {
    throw new UserFacingError(`Campaign ${campaignId} not found.`);
  }
  const campaign = result.rows[0];
  if (!actor.isAdmin && campaign.created_user !== actor.userId) {
    throw new UserFacingError(`Only the owner of campaign ${campaignId} or an admin can change it.`);
  }
  return { status: String(campaign.status), root: campaign.root };
}

// Pause takes an active campaign to paused, and resume takes a paused one to active.
function assertStatusChange(campaignId: string, stored: string, next: StoredCampaignStatus): void {
  if (next === "paused" && parseStoredStatus(stored) !== "active") {
    throw new UserFacingError(`Only an active campaign can be paused. Campaign ${campaignId} is ${stored}.`);
  }
  if (next === "active" && parseStoredStatus(stored) !== "paused") {
    throw new UserFacingError(`Only a paused campaign can be resumed. Campaign ${campaignId} is ${stored}.`);
  }
}

// Each publish gives the campaign's graph a version above every version before it, so the
// state machine can tell a trigger decided against an older graph, such as one for a node that
// was deleted and then published again under the same id. Call it after the campaign row is
// locked, so that two publishes of one campaign take their versions in commit order.
async function nextGraphVersion(client: PoolClient): Promise<string> {
  const result = await client.query<{ version: string }>(
    "SELECT nextval('campaign_graph_version_seq') AS version",
  );
  return result.rows[0].version;
}

// A resume writes the stored journey again, the graph that was published, so it keeps that
// graph's version. Triggers and watch timeouts decided before the pause then still apply.
async function publishedGraphVersion(client: PoolClient, campaignId: string): Promise<string> {
  const result = await client.query<{ graph_version: string }>(
    "SELECT graph_version FROM campaign_nodes WHERE campaign_id = $1 LIMIT 1",
    [campaignId],
  );
  return result.rows[0]?.graph_version ?? (await nextGraphVersion(client));
}

// Step 2 of publish: parses each behavior condition of the node rows, creates its metric
// definition when missing, and writes the condition back with its metric id. A definition the
// journey creates names the journey's owner as its creator. The campaign row is written first.
async function deriveCampaignMetricDefinitions(
  client: PoolClient,
  campaignId: string,
  nodes: DbCampaignNode[],
): Promise<void> {
  const owner = await client.query("SELECT created_user FROM campaigns WHERE id = $1", [campaignId]);
  const createdBy = typeof owner.rows[0]?.created_user === "string" ? owner.rows[0].created_user : null;
  for (const node of nodes) {
    const conditions: unknown = node.conditions_json == null ? null : JSON.parse(node.conditions_json);
    const paths: unknown = node.paths_json == null ? null : JSON.parse(node.paths_json);
    const behaviors = behaviorConditionsIn(conditions, paths);
    if (behaviors.length === 0) continue;
    const place = `Node ${node.node_id}`;
    for (const raw of behaviors) {
      const condition = parseBehaviorCondition(raw, place);
      await deriveMetricDefinition(client, condition, createdBy, place);
      for (const key of Object.keys(raw)) delete raw[key];
      Object.assign(raw, condition);
    }
    if (conditions != null) node.conditions_json = JSON.stringify(conditions);
    if (paths != null) node.paths_json = JSON.stringify(paths);
  }
}

async function replaceCampaignNodes(
  client: PoolClient,
  campaignId: string,
  nodes: DbCampaignNode[],
  graphVersion: string,
): Promise<void> {
  // Lock before the definitions are written, so that a concurrent segment save or delete waits
  // for this campaign's references.
  await lockMetricDefinitions(client);
  await deriveCampaignMetricDefinitions(client, campaignId, nodes);

  await client.query("DELETE FROM campaign_nodes WHERE campaign_id = $1", [campaignId]);
  // CDC delivers each row on its own. Every row carries the size of the save, so the state
  // machine can tell when the whole save has arrived and apply it as one change, and the
  // version of the graph.
  for (const node of nodes) {
    await client.query(
      `INSERT INTO campaign_nodes (
        campaign_id, node_id, node_type, parent_node_id, parent_branch, trigger_json, conditions_json, paths_json, action_json, goal_id, campaign_node_count, graph_version
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        campaignId,
        node.node_id,
        node.node_type,
        node.parent_node_id,
        node.parent_branch,
        node.trigger_json,
        node.conditions_json,
        node.paths_json,
        node.action_json,
        node.goal_id,
        nodes.length,
        graphVersion,
      ]
    );
  }
}

export type TransactionClient = PoolClient;

// Runs work in one transaction on one connection. Any throw rolls back everything it wrote.
export async function inTransaction<T>(work: (client: TransactionClient) => Promise<T>): Promise<T> {
  await ensureDbInitialized();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Steps 2 to 4 of publish, after the transaction wrote the campaign row: create the metric
// definitions, replace the node rows under a new graph version, and refresh processing modes.
export async function writePublishedGraph(client: TransactionClient, campaignId: string, nodes: DbCampaignNode[]): Promise<void> {
  await replaceCampaignNodes(client, campaignId, nodes, await nextGraphVersion(client));
  await syncMetricProcessingModes(client);
}

export async function publishCampaign(
  campaign: PublishedCampaign,
  ownerId: string,
  buildNodes: CampaignNodeBuilder,
): Promise<void> {
  await inTransaction(async (client) => {
    // 1. Insert the campaign, or update it when the caller already owns that id. The WHERE
    // makes the upsert update nothing when another user owns the row.
    const upsert = await client.query(
      `INSERT INTO campaigns (id, name, description, status, root, created_user, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (id)
       DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, status = EXCLUDED.status,
         root = EXCLUDED.root, updated_at = NOW()
       WHERE campaigns.created_user = EXCLUDED.created_user`,
      [campaign.id, campaign.name, campaign.description, "active", JSON.stringify(campaign.root), ownerId]
    );
    if (upsert.rowCount === 0) {
      throw new UserFacingError(`Campaign ${campaign.id} belongs to another user.`);
    }

    await writePublishedGraph(client, campaign.id, buildNodes(campaign.id, campaign.root));
  });
}

export async function deleteCampaign(campaignId: string, actor: CampaignActor): Promise<void> {
  await ensureDbInitialized();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockCampaignForChange(client, campaignId, actor);
    await client.query("DELETE FROM campaigns WHERE id = $1", [campaignId]);
    await syncMetricProcessingModes(client);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function updateCampaignStatus(
  campaignId: string,
  status: StoredCampaignStatus,
  actor: CampaignActor,
  buildNodes: StoredCampaignNodeBuilder,
): Promise<void> {
  await ensureDbInitialized();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const stored = await lockCampaignForChange(client, campaignId, actor);
    assertStatusChange(campaignId, stored.status, status);

    // 1. Update status in the campaigns table
    await client.query(
      "UPDATE campaigns SET status = $1, updated_at = NOW() WHERE id = $2",
      [status, campaignId]
    );

    // 2. Resume republishes: rebuild the node rows from the stored journey
    if (status === "active") {
      await replaceCampaignNodes(
        client,
        campaignId,
        buildNodes(campaignId, stored.root),
        await publishedGraphVersion(client, campaignId),
      );
    }

    // 3. Refresh processing_mode for all metrics based on active campaign references
    await syncMetricProcessingModes(client);

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ─── User Events & Fields ───

function normalizeEventAttributePath(fieldPath: string): string {
  return fieldPath.trim();
}

const DEFAULT_USER_EVENT_PAGE_SIZE = 25;
const MAX_USER_EVENT_PAGE_SIZE = 100;

export async function getUserEventSummariesPage(
  cursor: UserEventPageCursor | null = null,
  requestedPageSize = DEFAULT_USER_EVENT_PAGE_SIZE,
): Promise<UserEventPage> {
  await ensureDbInitialized();
  const pageSize = Math.min(
    Math.max(1, Math.trunc(requestedPageSize)),
    MAX_USER_EVENT_PAGE_SIZE,
  );
  const result = await getPool().query(
    `SELECT
       ue.id,
       ue.event_name,
       ue.display_name,
       ue.description,
       ue.enforce_schema,
       ue.status,
       ue.kind,
       ue.item_key,
       (
         SELECT COUNT(*)::integer
         FROM user_event_fields uef
         WHERE uef.user_event_id = ue.id
       ) AS field_count
     FROM user_events ue
     WHERE $1::text IS NULL
        OR ue.event_name > $1
        OR (ue.event_name = $1 AND ue.id > $2)
     ORDER BY ue.event_name, ue.id
     LIMIT $3`,
    [cursor?.eventName ?? null, cursor?.id ?? null, pageSize + 1],
  );
  const hasMore = result.rows.length > pageSize;
  const pageRows = hasMore ? result.rows.slice(0, pageSize) : result.rows;
  const events = pageRows.flatMap((row) => {
    const eventKind = storedEventKind(row);
    if (!eventKind) {
      console.warn(`Skipping event ${String(row.id)} in the catalog list: its kind or item key is not valid.`);
      return [];
    }
    return [{
      id: String(row.id),
      name: String(row.event_name),
      label: String(row.display_name || row.event_name),
      description: row.description ? String(row.description) : undefined,
      fieldCount: Number(row.field_count),
      enforceSchema: row.enforce_schema === true,
      eventKind,
      status: String(row.status ?? "active"),
    }];
  });
  // The cursor follows the last row read, so a skipped row does not end the paging early.
  const lastRow = pageRows.at(-1);

  return {
    events,
    nextCursor:
      hasMore && lastRow
        ? { eventName: String(lastRow.event_name), id: String(lastRow.id) }
        : null,
  };
}

// The kind and item key columns of a user_events row. Their CHECK constraints allow only a person
// row without an item key or a business row with one, so null means the row broke them.
function storedEventKind(row: { kind?: unknown; item_key?: unknown }): EventKind | null {
  if (row.kind === "person") return { kind: "person" };
  if (row.kind === "business" && typeof row.item_key === "string" && row.item_key) {
    return { kind: "business", itemKey: row.item_key };
  }
  return null;
}

export async function getUserEventFields(
  userEventId: string,
): Promise<UserEventFieldDef[]> {
  await ensureDbInitialized();
  const result = await getPool().query(
    `SELECT
       field_path,
       display_name,
       data_type,
       example_value,
       default_value,
       required
     FROM user_event_fields
     WHERE user_event_id = $1
     ORDER BY field_path`,
    [userEventId],
  );

  return result.rows.map((row) => ({
    value: normalizeEventAttributePath(String(row.field_path)),
    label: String(row.display_name || row.field_path),
    dataType: row.data_type ? String(row.data_type) : undefined,
    exampleValue:
      row.example_value === null ? undefined : String(row.example_value),
    defaultValue:
      row.default_value === null ? undefined : String(row.default_value),
    required: row.required === true,
  }));
}

export async function getUserEvents(): Promise<UserEventDef[]> {
  await ensureDbInitialized();
  const res = await getPool().query(`
    SELECT
      ue.id AS event_id,
      ue.event_name,
      ue.display_name AS event_label,
      ue.description,
      uef.field_path,
      uef.display_name AS field_label,
      uef.data_type,
      uef.example_value,
      uef.default_value
    FROM user_events ue
    LEFT JOIN user_event_fields uef ON ue.id = uef.user_event_id
    WHERE ue.status = 'active'
    ORDER BY ue.event_name, uef.display_name
  `);

  const eventsMap = new Map<string, UserEventDef>();
  
  for (const row of res.rows) {
    if (!eventsMap.has(row.event_id)) {
      eventsMap.set(row.event_id, {
        id: row.event_id,
        name: row.event_name,
        label: row.event_label || row.event_name,
        description: row.description,
        fields: []
      });
    }
    
    if (row.field_path) {
      const fieldPath = normalizeEventAttributePath(row.field_path);
      eventsMap.get(row.event_id)!.fields.push({
        value: fieldPath,
        label: row.field_label || row.field_path,
        dataType: row.data_type,
        exampleValue: row.example_value,
        defaultValue: row.default_value
      });
    }
  }

  return Array.from(eventsMap.values());
}

// infra/db/schema.sql names this constraint so the error can be recognized here.
const USER_EVENT_NAME_CONSTRAINT = "user_events_event_name_key";

function isDuplicateEventName(error: unknown): boolean {
  return (
    typeof error === "object"
    && error !== null
    && (error as { code?: unknown }).code === "23505"
    && (error as { constraint?: unknown }).constraint === USER_EVENT_NAME_CONSTRAINT
  );
}

function duplicateEventNameError(eventName: string): Error {
  return new DuplicateEventNameError(eventName);
}

// The event with this exact system name, with the label the catalog shows, or null.
export async function findUserEventByName(eventName: string): Promise<{ id: string; label: string } | null> {
  await ensureDbInitialized();
  const result = await getPool().query(
    `SELECT id, COALESCE(NULLIF(display_name, ''), event_name) AS label FROM user_events WHERE event_name = $1`,
    [eventName],
  );
  const row = result.rows[0];
  return row ? { id: String(row.id), label: String(row.label) } : null;
}

function userEventNotFoundError(id: string): Error {
  return new UserFacingError(`Event ${id} not found.`);
}

async function assertUserEventExists(db: Pool | PoolClient, id: string): Promise<void> {
  const result = await db.query(`SELECT 1 FROM user_events WHERE id = $1`, [id]);
  if (result.rowCount === 0) throw userEventNotFoundError(id);
}

export async function createUserEvent(rawEventName: string, display_name: string, description?: string): Promise<string> {
  const event_name = parseEventSystemName(rawEventName);
  await ensureDbInitialized();
  const id = `ue_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  try {
    await getPool().query(
      `INSERT INTO user_events (id, event_name, display_name, description) VALUES ($1, $2, $3, $4)`,
      [id, event_name, display_name, description || null]
    );
  } catch (error) {
    throw isDuplicateEventName(error) ? duplicateEventNameError(event_name) : error;
  }
  return id;
}

// Changes an event's display name, description, and kind. Its system name stays: tracking sends
// it. A person event may become business; a business event keeps its kind and item key.
export async function updateUserEvent(
  id: string,
  rawDisplayName: string,
  rawDescription: string,
  eventKind: EventKind,
): Promise<void> {
  const displayName = rawDisplayName.trim();
  if (!displayName) throw new UserFacingError("The display name is required.");
  await ensureDbInitialized();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Publishes and attribute renames and deletes take this lock before they read, so none can add
    // a use or remove the item key between the checks and the update. It comes before any row
    // lock: holding one first could deadlock with a publish's foreign key lock on this row.
    await lockMetricDefinitions(client);
    const result = await client.query(`SELECT event_name, kind, item_key FROM user_events WHERE id = $1`, [id]);
    if (result.rowCount === 0) throw userEventNotFoundError(id);
    const storedKind = storedEventKind(result.rows[0]);
    if (!storedKind) throw new Error(`Event ${id} has a kind or item key that its CHECK constraints refuse.`);
    await refuseEventKindChange(client, id, String(result.rows[0].event_name), storedKind, eventKind);
    await client.query(
      `UPDATE user_events SET display_name = $1, description = $2, kind = $3, item_key = $4 WHERE id = $5`,
      [displayName, rawDescription.trim() || null, ...eventKindColumns(eventKind), id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Changes only the display name and the description. Studio v2 offers no kind change.
export async function updateUserEventDetails(id: string, rawDisplayName: string, rawDescription: string): Promise<void> {
  const displayName = rawDisplayName.trim();
  if (!displayName) throw new UserFacingError("The display name is required.");
  await ensureDbInitialized();
  const result = await getPool().query(`UPDATE user_events SET display_name = $1, description = $2 WHERE id = $3`, [
    displayName,
    rawDescription.trim() || null,
    id,
  ]);
  if (result.rowCount === 0) throw userEventNotFoundError(id);
}

// CAT-FR-16 and CAT-FR-17: only a change from person to business is allowed, to an item key that
// is one of the event's attributes, and only while no published campaign uses the event.
async function refuseEventKindChange(
  client: PoolClient,
  eventId: string,
  eventName: string,
  stored: EventKind,
  requested: EventKind,
): Promise<void> {
  switch (stored.kind) {
    case "business":
      if (requested.kind === "business" && requested.itemKey === stored.itemKey) return;
      throw new UserFacingError("The kind and the item key of a business event are fixed.");
    case "person": {
      if (requested.kind === "person") return;
      const attribute = await client.query(
        `SELECT 1 FROM user_event_fields WHERE user_event_id = $1 AND field_path = $2`,
        [eventId, requested.itemKey],
      );
      if (attribute.rowCount === 0) throw notAnAttributeError(requested.itemKey);
      const campaigns = campaignsWithNodes(await findEventCampaignUses(client, eventId, eventName));
      if (campaigns.length === 0) return;
      throw new UserFacingError(
        [
          `Can't change the kind of "${eventName}" to business: these campaigns use it. Remove these uses first.`,
          ...campaigns.map(campaignUseLine),
        ].join("\n"),
      );
    }
    default: {
      const unknownKind: never = stored;
      throw new Error(`Unknown event kind ${JSON.stringify(unknownKind)}`);
    }
  }
}

function eventKindColumns(eventKind: EventKind): [string, string | null] {
  switch (eventKind.kind) {
    case "person":
      return ["person", null];
    case "business":
      return ["business", eventKind.itemKey];
    default: {
      const unknownKind: never = eventKind;
      throw new Error(`Unknown event kind ${JSON.stringify(unknownKind)}`);
    }
  }
}

function notAnAttributeError(itemKey: string): Error {
  return new UserFacingError(`The item key "${itemKey}" is not one of the event's attributes.`);
}

export async function createUserEventField(
  user_event_id: string,
  field_path: string,
  display_name: string,
  data_type: string,
  example_value?: string,
): Promise<void> {
  const rawFieldPath = parseEventAttributePath(field_path);
  const dataType = parseEventAttributeType(data_type);
  await ensureDbInitialized();
  const pool = getPool();
  const parentSeparatorIndex = rawFieldPath.lastIndexOf(".");
  const rawParentFieldPath =
    parentSeparatorIndex > 0
      ? rawFieldPath.slice(0, parentSeparatorIndex)
      : "";
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await assertUserEventExists(client, user_event_id);

    if (rawParentFieldPath) {
      await client.query(
        `UPDATE user_event_fields
         SET data_type = 'json', example_value = NULL
         WHERE user_event_id = $1 AND field_path = $2`,
        [user_event_id, rawParentFieldPath],
      );
    }

    await client.query(
      `INSERT INTO user_event_fields (user_event_id, field_path, display_name, data_type, example_value) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_event_id, field_path) DO UPDATE SET display_name = EXCLUDED.display_name, data_type = EXCLUDED.data_type, example_value = EXCLUDED.example_value`,
      [user_event_id, rawFieldPath, display_name, dataType, example_value || null],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Adds attributes to an existing event in one transaction. A path the event already has is
// refused by name, never overwritten. Every parent becomes json, as adding a child does: one
// the event has is changed, one in the batch is added as json, and a missing one is created.
export async function addUserEventFields(
  userEventId: string,
  rawFields: { field_path: string; display_name: string; data_type: string; example_value?: string }[],
): Promise<void> {
  const parsed = parseNewEventAttributes(rawFields);
  if (parsed.length === 0) throw new UserFacingError("Add at least one attribute.");
  const paths = parsed.map((field) => field.field_path);
  const parents = new Set<string>();
  for (const keys of paths.map((path) => path.split("."))) {
    for (let depth = 1; depth < keys.length; depth++) parents.add(keys.slice(0, depth).join("."));
  }
  const fields = parsed.map((field) =>
    parents.has(field.field_path) ? { ...field, data_type: "json" as const, example_value: undefined } : field,
  );
  const outsideBatch = [...parents].filter((parent) => !paths.includes(parent));
  await ensureDbInitialized();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await assertUserEventExists(client, userEventId);
    const taken = await client.query(
      `SELECT field_path FROM user_event_fields WHERE user_event_id = $1 AND field_path = ANY($2::text[]) ORDER BY field_path LIMIT 1`,
      [userEventId, paths],
    );
    if (taken.rows.length > 0) {
      throw new UserFacingError(`An attribute with the path "${String(taken.rows[0].field_path)}" already exists.`);
    }
    const missing: typeof fields = [];
    if (outsideBatch.length > 0) {
      const becomeGroups = await client.query(
        `SELECT field_path FROM user_event_fields
         WHERE user_event_id = $1 AND field_path = ANY($2::text[]) AND data_type <> 'json'
         ORDER BY field_path`,
        [userEventId, outsideBatch],
      );
      for (const row of becomeGroups.rows) {
        await refuseChangeOfUsedAttribute(client, userEventId, String(row.field_path), "turned into a group");
      }
      const updated = await client.query(
        `UPDATE user_event_fields SET data_type = 'json', example_value = NULL
         WHERE user_event_id = $1 AND field_path = ANY($2::text[])
         RETURNING field_path`,
        [userEventId, outsideBatch],
      );
      const present = new Set(updated.rows.map((row) => String(row.field_path)));
      for (const parent of outsideBatch.filter((path) => !present.has(path))) {
        missing.push({ field_path: parent, display_name: parent.slice(parent.lastIndexOf(".") + 1), data_type: "json" });
      }
    }
    const inserts = [...missing, ...fields].sort((a, b) => a.field_path.localeCompare(b.field_path));
    for (const field of inserts) {
      await client.query(
        `INSERT INTO user_event_fields (user_event_id, field_path, display_name, data_type, example_value) VALUES ($1, $2, $3, $4, $5)`,
        [userEventId, field.field_path, field.display_name, field.data_type, field.example_value || null],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function updateUserEventField(
  user_event_id: string,
  original_field_path: string,
  field_path: string,
  display_name: string,
  data_type: string,
  example_value?: string,
  default_value?: string,
): Promise<void> {
  const rawOriginal = parseEventAttributePath(original_field_path);
  const rawNew = parseEventAttributePath(field_path);
  const dataType = parseEventAttributeType(data_type);
  if (rawNew.startsWith(`${rawOriginal}.`)) {
    throw new UserFacingError(`The attribute "${rawOriginal}" cannot move inside itself.`);
  }
  await ensureDbInitialized();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const storedType = await client.query(
      `SELECT data_type FROM user_event_fields WHERE user_event_id = $1 AND field_path = $2`,
      [user_event_id, rawOriginal],
    );
    if (storedType.rows.length > 0 && String(storedType.rows[0].data_type) !== dataType) {
      await refuseChangeOfUsedAttribute(client, user_event_id, rawOriginal, "retyped");
    }
    if (rawNew !== rawOriginal) {
      await refuseChangeOfUsedAttribute(client, user_event_id, rawOriginal, "renamed");
      // The unique key on the path would also refuse it, but with a message the admin cannot read.
      const taken = await client.query(
        `SELECT field_path FROM user_event_fields
         WHERE user_event_id = $1 AND (field_path = $2 OR LEFT(field_path, LENGTH($2) + 1) = $2 || '.')
         LIMIT 1`,
        [user_event_id, rawNew],
      );
      if (taken.rows.length > 0) {
        throw new UserFacingError(`An attribute with the path "${rawNew}" already exists.`);
      }
    } else {
      await assertUserEventExists(client, user_event_id);
    }
    await client.query(
      `UPDATE user_event_fields
       SET field_path = $1 || SUBSTRING(field_path FROM LENGTH($2) + 1)
       WHERE user_event_id = $3
         AND LEFT(field_path, LENGTH($2) + 1) = $2 || '.'`,
      [rawNew, rawOriginal, user_event_id]
    );
    await client.query(
      `UPDATE user_event_fields
       SET field_path = $1, display_name = $2, data_type = $3, example_value = $4, default_value = $5
       WHERE user_event_id = $6 AND field_path = $7`,
      [rawNew, display_name, dataType, example_value || null, default_value || null, user_event_id, rawOriginal]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function createUserEventWithFields(
  event_name: string,
  display_name: string,
  description: string | undefined,
  eventKind: EventKind,
  rawFields: { field_path: string; display_name: string; data_type: string; example_value?: string }[]
): Promise<string> {
  const eventName = parseEventSystemName(event_name);
  const fields = parseNewEventAttributes(rawFields);
  if (eventKind.kind === "business" && !fields.some((field) => field.field_path === eventKind.itemKey)) {
    throw notAnAttributeError(eventKind.itemKey);
  }
  await ensureDbInitialized();
  const pool = getPool();
  const client = await pool.connect();
  
  try {
    await client.query("BEGIN");
    
    const id = `ue_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    try {
      await client.query(
        `INSERT INTO user_events (id, event_name, display_name, description, kind, item_key) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, eventName, display_name, description || null, ...eventKindColumns(eventKind)]
      );
    } catch (error) {
      throw isDuplicateEventName(error) ? duplicateEventNameError(eventName) : error;
    }

    for (const field of fields) {
      await client.query(
        `INSERT INTO user_event_fields (user_event_id, field_path, display_name, data_type, example_value) VALUES ($1, $2, $3, $4, $5)`,
        [id, field.field_path, field.display_name, field.data_type, field.example_value || null]
      );
    }

    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

type JsonObject = Record<string, unknown>;

function jsonObject(text: string | null): JsonObject | null {
  if (text == null) return null;
  const value: unknown = JSON.parse(text);
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

// The fields of the entries in a list of groups.
function groupFields(list: unknown): string[] {
  if (typeof list !== "object" || list === null) return [];
  const groups = (list as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group) => {
    const conditions = (group as { conditions?: unknown } | null)?.conditions;
    return Array.isArray(conditions)
      ? conditions
        .map((condition) => (condition as { field?: unknown } | null)?.field)
        .filter((field): field is string => typeof field === "string")
      : [];
  });
}

// Whether a node row's trigger fires on the event. Throws when the JSON does not parse.
function triggerNamesEvent(row: CampaignConditionRow, eventName: string): boolean {
  const trigger = jsonObject(row.trigger_json);
  return trigger?.kind === "event" && trigger.event === eventName;
}

// The fields that a node row's trigger filters, and its branches filter, compare on its trigger
// event. Throws when the JSON does not parse.
function triggerFields(row: CampaignConditionRow): string[] {
  const paths = jsonObject(row.paths_json);
  const branches = Array.isArray(paths?.branches) ? paths.branches : [];
  return [
    jsonObject(row.trigger_json)?.filters,
    ...branches.map((branch) => (branch as { filters?: unknown } | null)?.filters),
  ].flatMap(groupFields);
}

// The behavior conditions of a node row on the event. Throws when the JSON does not parse.
function behaviorConditionsOn(row: CampaignConditionRow, eventName: string): JsonObject[] {
  return behaviorConditionsIn(jsonObject(row.conditions_json), jsonObject(row.paths_json))
    .filter((condition) => condition.event === eventName);
}

// The attributes that the behavior conditions on the event measure or filter.
function behaviorFields(row: CampaignConditionRow, eventName: string): string[] {
  return behaviorConditionsOn(row, eventName).flatMap((condition) => [
    ...(typeof condition.attribute === "string" ? [condition.attribute] : []),
    ...groupFields(condition.filters),
  ]);
}

async function loadUserEventName(db: Pool | PoolClient, id: string): Promise<string> {
  const result = await db.query(`SELECT event_name FROM user_events WHERE id = $1`, [id]);
  if (result.rowCount === 0) throw userEventNotFoundError(id);
  return String(result.rows[0].event_name);
}

interface CampaignConditionRow {
  campaign_id: string;
  campaign_name: string;
  campaign_status: string;
  node_id: string;
  trigger_json: string | null;
  conditions_json: string | null;
  paths_json: string | null;
}

// The node rows of every published campaign that can name an event or an attribute.
async function loadCampaignConditionRows(db: Pool | PoolClient): Promise<CampaignConditionRow[]> {
  const result = await db.query(
    `SELECT campaigns.id AS campaign_id, campaigns.name AS campaign_name,
            campaigns.status AS campaign_status, campaign_nodes.node_id,
            campaign_nodes.trigger_json, campaign_nodes.conditions_json, campaign_nodes.paths_json
     FROM campaign_nodes
     JOIN campaigns ON campaigns.id = campaign_nodes.campaign_id
     WHERE campaign_nodes.trigger_json IS NOT NULL OR campaign_nodes.conditions_json IS NOT NULL
        OR campaign_nodes.paths_json IS NOT NULL
     ORDER BY campaigns.created_at, campaigns.id`,
  );
  return result.rows;
}

function isAtOrUnder(path: string, attribute: string): boolean {
  return path === attribute || path.startsWith(`${attribute}.`);
}

// The left side of every comparison in an expression.
function comparisonFields(expression: unknown): string[] {
  if (expression === null || typeof expression !== "object") return [];
  const node = expression as { type?: unknown; left?: unknown; expressions?: unknown };
  if (node.type === "comparison") return typeof node.left === "string" ? [node.left] : [];
  if ((node.type === "and" || node.type === "or") && Array.isArray(node.expressions)) {
    return node.expressions.flatMap(comparisonFields);
  }
  return [];
}

export interface AttributeUses {
  metrics: { id: string; displayName: string }[];
  campaigns: { name: string; status: string; nodeIds: string[] }[];
  segments: { id: string; name: string }[];
}

// What can read an event's attributes: its metric definitions and the published campaign nodes on
// the event, each with the attribute paths it reads. Profile conditions read only profile fields,
// so they are not read.
interface AttributeReaders {
  metrics: { id: string; displayName: string; fields: string[] }[];
  campaigns: { id: string; name: string; status: string; nodeId: string; fields: string[] }[];
  segments: { id: string; name: string; description: string; fields: string[] }[];
}

// The saved segments with a behavior condition on the event, each with the attributes it reads.
// The owner decided on 2026-11-08 that a segment counts as a use.
async function loadSegmentReaders(db: Pool | PoolClient, eventName: string): Promise<AttributeReaders["segments"]> {
  const result = await db.query(`SELECT id, name, description, conditions_json FROM segments ORDER BY name, id`);
  const segments: AttributeReaders["segments"] = [];
  for (const row of result.rows) {
    let conditions: BehaviorCondition[];
    try {
      conditions = behaviorConditions(parseSegmentConditions(row.conditions_json)).filter((condition) => condition.event === eventName);
    } catch (error) {
      console.warn(`Skipping segment ${String(row.id)} in event uses: its conditions do not parse.`, error);
      continue;
    }
    if (conditions.length === 0) continue;
    const fields = conditions.flatMap((condition) => [
      ...(condition.attribute ? [condition.attribute] : []),
      ...(condition.filters?.groups ?? []).flatMap((group) => group.conditions.map((filter) => filter.field)),
    ]);
    segments.push({ id: String(row.id), name: String(row.name), description: typeof row.description === "string" ? row.description : "", fields });
  }
  return segments;
}

async function loadAttributeReaders(db: Pool | PoolClient, eventId: string, eventName: string): Promise<AttributeReaders> {
  const metricResult = await db.query(
    `SELECT id, display_name, agg_field, default_properties, filter_conditions
     FROM user_metric_definitions
     WHERE user_event_id = $1
     ORDER BY display_name, id`,
    [eventId],
  );
  const metrics = metricResult.rows.map((row) => ({
    id: String(row.id),
    displayName: String(row.display_name),
    fields: [row.agg_field, ...comparisonFields(row.default_properties), ...comparisonFields(row.filter_conditions)]
      .filter((field): field is string => typeof field === "string"),
  }));

  const campaigns: AttributeReaders["campaigns"] = [];
  for (const row of await loadCampaignConditionRows(db)) {
    let fields: string[];
    try {
      fields = [
        ...(triggerNamesEvent(row, eventName) ? triggerFields(row) : []),
        ...behaviorFields(row, eventName),
      ];
    } catch (error) {
      // One bad row must not block every rename.
      console.warn(
        `Skipping campaign ${row.campaign_id} node ${row.node_id} in attribute uses: its JSON does not parse.`,
        error,
      );
      continue;
    }
    if (fields.length > 0) {
      campaigns.push({ id: row.campaign_id, name: row.campaign_name, status: row.campaign_status, nodeId: row.node_id, fields });
    }
  }
  return { metrics, campaigns, segments: await loadSegmentReaders(db, eventName) };
}

// The readers that read the attribute or a descendant.
function attributeUsesIn(readers: AttributeReaders, attribute: string): AttributeUses {
  const metrics = readers.metrics
    .filter((metric) => metric.fields.some((field) => isAtOrUnder(field, attribute)))
    .map(({ id, displayName }) => ({ id, displayName }));
  const campaigns = new Map<string, AttributeUses["campaigns"][number]>();
  for (const node of readers.campaigns) {
    if (!node.fields.some((field) => isAtOrUnder(field, attribute))) continue;
    const campaign = campaigns.get(node.id) ?? { name: node.name, status: node.status, nodeIds: [] };
    campaign.nodeIds.push(node.nodeId);
    campaigns.set(node.id, campaign);
  }
  const segments = readers.segments
    .filter((segment) => segment.fields.some((field) => isAtOrUnder(field, attribute)))
    .map(({ id, name }) => ({ id, name }));
  return { metrics, campaigns: [...campaigns.values()], segments };
}

async function findAttributeUses(
  client: PoolClient,
  eventId: string,
  eventName: string,
  attribute: string,
): Promise<AttributeUses> {
  return attributeUsesIn(await loadAttributeReaders(client, eventId, eventName), attribute);
}

// CAT-FR-20: the saved segments with a behavior condition on the event, for the detail page.
export async function getUserEventSegments(eventId: string): Promise<{ id: string; name: string; description: string }[]> {
  await ensureDbInitialized();
  const pool = getPool();
  const segments = await loadSegmentReaders(pool, await loadUserEventName(pool, eventId));
  return segments.map(({ id, name, description }) => ({ id, name, description }));
}

// CAT-FR-20: the uses of each of the event's attributes, by path, for the detail page. It only
// reads, so a count can be stale by the time an admin acts; every change checks again (CAT-FR-11).
export async function getUserEventFieldUses(eventId: string): Promise<Record<string, AttributeUses>> {
  await ensureDbInitialized();
  const pool = getPool();
  const eventName = await loadUserEventName(pool, eventId);
  const fields = await pool.query(`SELECT field_path FROM user_event_fields WHERE user_event_id = $1`, [eventId]);
  const readers = await loadAttributeReaders(pool, eventId, eventName);
  return Object.fromEntries(
    fields.rows.map((row) => [String(row.field_path), attributeUsesIn(readers, String(row.field_path))]),
  );
}

export type AttributeChange = "renamed" | "deleted" | "retyped" | "turned into a group";

// The three steps CAT-FR-11 offers in place of a breaking change to an attribute in use.
export const SAFE_WAY_STEPS = [
  "Add the new field next to the old one.",
  "Update the journeys, metrics, and segments that use the old one. A live journey can't be edited in place, so duplicate it, point it at the new field, and swap them.",
  "Remove the old field once nothing uses it.",
] as const;

// CAT-FR-11, CAT-FR-12, CAT-FR-19: a rename, a delete, a type change, or turning into a group would leave every use on a path that no longer
// exists, so both are refused while any use exists. Publishes and metric definition writes take
// the same lock before they add a use, so none can add one between this check and the commit.
async function refuseChangeOfUsedAttribute(
  client: PoolClient,
  eventId: string,
  attribute: string,
  change: AttributeChange,
): Promise<void> {
  await lockMetricDefinitions(client);
  const stored = await client.query(`SELECT event_name, item_key FROM user_events WHERE id = $1`, [eventId]);
  if (stored.rowCount === 0) throw userEventNotFoundError(eventId);
  const eventName = String(stored.rows[0].event_name);
  const itemKey: unknown = stored.rows[0].item_key;
  // CAT-FR-17: the item key stays while the event exists, and a change to an ancestor would move
  // or delete it.
  if (typeof itemKey === "string" && isAtOrUnder(itemKey, attribute)) {
    throw new UserFacingError(
      itemKey === attribute
        ? `The attribute "${attribute}" is the item key of this event, so it cannot be ${change}.`
        : `The attribute "${attribute}" holds the item key "${itemKey}", so it cannot be ${change}.`,
    );
  }
  const uses = await findAttributeUses(client, eventId, eventName, attribute);
  if (uses.metrics.length === 0 && uses.campaigns.length === 0 && uses.segments.length === 0) return;

  const lines = [`The attribute "${attribute}" is in use, so it cannot be ${change}. Nothing changed.`];
  if (uses.metrics.length > 0) {
    lines.push("", "Metric definitions:", ...uses.metrics.map((metric) => `- ${metric.displayName} (${metric.id})`));
  }
  if (uses.campaigns.length > 0) {
    lines.push("", "Campaigns:", ...uses.campaigns.map(campaignUseLine));
  }
  if (uses.segments.length > 0) {
    lines.push("", "Segments:", ...uses.segments.map((segment) => `- ${segment.name} (${segment.id})`));
  }
  lines.push("", "The safe way:", ...SAFE_WAY_STEPS.map((step, index) => `${index + 1}. ${step}`));
  throw new UserFacingError(lines.join("\n"));
}

function campaignUseLine(campaign: { name: string; status: string; nodeIds: string[] }): string {
  return `- ${campaign.name} (${campaign.status}), ${campaign.nodeIds.length === 1 ? "node" : "nodes"} ${campaign.nodeIds.join(", ")}`;
}

interface EventCampaignUse {
  campaign: UserEventUsageCampaign;
  nodeId: string;
  // A metric use is a metric condition on the event. A condition use is a trigger or an event
  // condition that names the event's system name.
  use: "metric" | "condition";
}

// The nodes of published campaigns that use the event, one entry per use, in campaign order.
async function findEventCampaignUses(
  db: Pool | PoolClient,
  eventId: string,
  eventName: string,
): Promise<EventCampaignUse[]> {
  const uses: EventCampaignUse[] = [];
  for (const row of await loadCampaignConditionRows(db)) {
    let usesMetrics: boolean;
    let namesEvent: boolean;
    try {
      usesMetrics = behaviorConditionsOn(row, eventName).length > 0;
      namesEvent = triggerNamesEvent(row, eventName);
    } catch (error) {
      // One bad row must not block every event delete or kind change.
      console.warn(
        `Skipping campaign ${row.campaign_id} node ${row.node_id} in event usage: its JSON does not parse.`,
        error,
      );
      continue;
    }
    const campaign = { id: row.campaign_id, name: row.campaign_name, status: row.campaign_status };
    if (usesMetrics) uses.push({ campaign, nodeId: row.node_id, use: "metric" });
    if (namesEvent) uses.push({ campaign, nodeId: row.node_id, use: "condition" });
  }
  return uses;
}

// Each campaign once, with the ids of its nodes that use the event.
function campaignsWithNodes(uses: EventCampaignUse[]): { name: string; status: string; nodeIds: string[] }[] {
  const campaigns = new Map<string, { name: string; status: string; nodeIds: string[] }>();
  for (const { campaign, nodeId } of uses) {
    const entry = campaigns.get(campaign.id) ?? { name: campaign.name, status: campaign.status, nodeIds: [] };
    if (!entry.nodeIds.includes(nodeId)) entry.nodeIds.push(nodeId);
    campaigns.set(campaign.id, entry);
  }
  return [...campaigns.values()];
}

export async function getUserEventUsage(id: string): Promise<UserEventUsage> {
  await ensureDbInitialized();
  const pool = getPool();
  const eventName = await loadUserEventName(pool, id);
  const metricResult = await pool.query(
    `SELECT id, display_name, agg_operator, agg_field
     FROM user_metric_definitions
     WHERE user_event_id = $1
     ORDER BY display_name, id`,
    [id],
  );

  const metricCampaigns = new Map<string, UserEventUsageCampaign>();
  const conditionCampaigns = new Map<string, UserEventUsageCampaign>();
  for (const { campaign, use } of await findEventCampaignUses(pool, id, eventName)) {
    (use === "metric" ? metricCampaigns : conditionCampaigns).set(campaign.id, campaign);
  }

  return {
    metrics: metricResult.rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      measure: metricMeasure(String(row.agg_operator ?? "COUNT"), typeof row.agg_field === "string" ? row.agg_field : null),
    })),
    metricCampaigns: [...metricCampaigns.values()],
    conditionCampaigns: [...conditionCampaigns.values()],
  };
}

// CAT-FR-08: refused while the event has a metric definition or a published campaign or a segment
// uses it, so a delete never cascades to a metric definition. The check and the delete share one
// transaction under the metric definition lock, which publishes and metric writes also take.
export async function deleteUserEvent(id: string): Promise<void> {
  await ensureDbInitialized();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockMetricDefinitions(client);
    const eventName = await loadUserEventName(client, id);
    const metrics = await client.query(
      `SELECT id, display_name FROM user_metric_definitions WHERE user_event_id = $1 ORDER BY display_name, id`,
      [id],
    );
    const campaigns = campaignsWithNodes(await findEventCampaignUses(client, id, eventName));
    const segments = await loadSegmentReaders(client, eventName);
    if (metrics.rows.length > 0 || campaigns.length > 0 || segments.length > 0) {
      const lines = ["This event is in use, so it cannot be deleted. Nothing changed."];
      if (metrics.rows.length > 0) {
        lines.push(
          "",
          "Metric definitions, which are kept for history and never deleted:",
          ...metrics.rows.map((row) => `- ${String(row.display_name)} (${String(row.id)})`),
        );
      }
      if (campaigns.length > 0) lines.push("", "Campaigns:", ...campaigns.map(campaignUseLine));
      if (segments.length > 0) lines.push("", "Segments:", ...segments.map((segment) => `- ${segment.name} (${segment.id})`));
      lines.push("", "Hide it from the builder to retire it.");
      throw new UserFacingError(lines.join("\n"));
    }
    await client.query(`DELETE FROM user_events WHERE id = $1`, [id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Turns the event's schema gate on or off. With the gate on, ingestion drops each event of this
// name that does not match its attributes.
// Switches an event between active and inactive. The builder offers only active events. Campaigns
// that already use an inactive event, and ingestion, do not read the status.
export async function setUserEventStatus(id: string, rawStatus: string): Promise<void> {
  const status = parseEventStatus(rawStatus);
  await ensureDbInitialized();
  const result = await getPool().query(`UPDATE user_events SET status = $1 WHERE id = $2`, [status, id]);
  if (result.rowCount === 0) throw userEventNotFoundError(id);
}

export async function setUserEventSchemaEnforcement(id: string, enforce: boolean): Promise<void> {
  await ensureDbInitialized();
  const result = await getPool().query(`UPDATE user_events SET enforce_schema = $1 WHERE id = $2`, [enforce, id]);
  if (result.rowCount === 0) throw userEventNotFoundError(id);
}

export async function setUserEventFieldRequired(
  user_event_id: string,
  field_path: string,
  required: boolean,
): Promise<void> {
  await ensureDbInitialized();
  const rawFieldPath = normalizeEventAttributePath(field_path);
  const result = await getPool().query(
    `UPDATE user_event_fields SET required = $1 WHERE user_event_id = $2 AND field_path = $3`,
    [required, user_event_id, rawFieldPath],
  );
  if (result.rowCount === 0) {
    throw new UserFacingError(`Attribute ${rawFieldPath} not found on event ${user_event_id}.`);
  }
}

export async function deleteUserEventField(field_path: string, user_event_id: string): Promise<void> {
  await ensureDbInitialized();
  const rawFieldPath = normalizeEventAttributePath(field_path);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await refuseChangeOfUsedAttribute(client, user_event_id, rawFieldPath, "deleted");
    await client.query(
      `DELETE FROM user_event_fields
       WHERE user_event_id = $1
         AND (field_path = $2 OR LEFT(field_path, LENGTH($2) + 1) = $2 || '.')`,
      [user_event_id, rawFieldPath]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// ─── Segments ───

// Every active or paused campaign that uses each segment, by segment id. A node row is read as
// JSON, so a use is found in whichever column holds the node's trigger or conditions.
async function loadSegmentUses(db: Pool | PoolClient): Promise<Map<string, SegmentUse[]>> {
  const result = await db.query(`
    SELECT campaigns.id AS campaign_id, campaigns.name AS campaign_name, campaigns.status,
           campaigns.created_user AS owner_id, to_jsonb(campaign_nodes) AS node
    FROM campaign_nodes
    JOIN campaigns ON campaigns.id = campaign_nodes.campaign_id
    WHERE campaigns.status IN ('active', 'paused')
      AND to_jsonb(campaign_nodes)::text LIKE '%SEG-%'
    ORDER BY campaigns.name, campaigns.id
  `);
  const usesBySegmentId = new Map<string, SegmentUse[]>();
  for (const row of result.rows) {
    const status = parseUsingCampaignStatus(row.status);
    if (!status) {
      console.warn(`Skipping campaign ${String(row.campaign_id)} in segment uses: its status ${String(row.status)} does not use a segment.`);
      continue;
    }
    const columns = Object.values((row.node ?? {}) as Record<string, unknown>)
      .filter((value): value is string => typeof value === "string");
    for (const [segmentId, kinds] of segmentUsesOfNodeRow(columns)) {
      const uses = usesBySegmentId.get(segmentId) ?? [];
      let use = uses.find((existing) => existing.campaignId === row.campaign_id);
      if (!use) {
        const ownerId = typeof row.owner_id === "string" ? row.owner_id : null;
        use = { campaignId: row.campaign_id, campaignName: row.campaign_name, status, kinds: [], ownerId };
        uses.push(use);
      }
      const known = new Set([...use.kinds, ...kinds]);
      use.kinds = SEGMENT_USE_KINDS.filter((kind) => known.has(kind));
      usesBySegmentId.set(segmentId, uses);
    }
  }
  return usesBySegmentId;
}

// SEG-FR-06 and CMP-FR-03: adds the metrics that the behavior conditions of every segment name,
// with their windows, so a segment's metrics stay LIVE while it exists, whether or not a campaign
// uses it. A stored segment whose conditions do not parse is logged and skipped.
async function addSegmentRetentions(client: PoolClient, retentions: Map<string, number | null>): Promise<void> {
  const result = await client.query("SELECT id, conditions_json FROM segments");
  for (const row of result.rows) {
    try {
      for (const condition of behaviorConditions(parseSegmentConditions(row.conditions_json))) {
        if (condition.metric_id) addMetricWindow(retentions, condition.metric_id, condition.window);
      }
    } catch (error) {
      console.warn(`Skipping segment ${String(row.id)} in metric references: its conditions do not parse.`, error);
    }
  }
}

// JSON with every object's keys sorted and no whitespace.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// A behavior condition's metric id, as campaign management's metric definitions describe: m_ and
// the first 16 hex digits of the SHA-256 of its event, measure, attribute, and filters.
export function behaviorMetricId(condition: BehaviorCondition): string {
  const counted = {
    event: condition.event,
    measure: condition.measure,
    attribute: condition.attribute,
    filters: condition.filters,
  };
  return `m_${createHash("sha256").update(canonicalJson(counted)).digest("hex").slice(0, 16)}`;
}

function comparisonRight(value: EventPropertyCondition["value"]): string {
  return Array.isArray(value) ? value.join(",") : String(value);
}

// A behavior condition's filters as the predicate tree the decision job reads from
// filter_conditions today: every group must pass, and any entry of a group.
function filterConditionsText(filters: BehaviorCondition["filters"]): string {
  if (!filters || filters.groups.length === 0) return "{}";
  return JSON.stringify({
    type: "and",
    expressions: filters.groups.map((group) => ({
      type: "or",
      expressions: group.conditions.map((condition) => ({
        type: "comparison",
        left: condition.field,
        op: condition.op,
        right: comparisonRight(condition.value),
      })),
    })),
  });
}

// SEG-FR-06 and step 2 of publish: creates the definition of a behavior condition when none has
// its metric id, as PAUSED, with createdBy as its creator, and writes the id into the condition.
// An existing definition, its creator included, does not change here. A refusal names the place,
// when there is one.
async function deriveMetricDefinition(
  client: PoolClient,
  condition: BehaviorCondition,
  createdBy: string | null,
  place?: string,
): Promise<void> {
  const event = await client.query(
    "SELECT id, event_name, display_name FROM user_events WHERE event_name = $1 LIMIT 1",
    [condition.event],
  );
  if (event.rows.length === 0) {
    const refusal = `Event ${condition.event} is not in the catalog.`;
    throw new UserFacingError(place ? `${place}: ${refusal}` : refusal);
  }
  const eventId = String(event.rows[0].id);
  const metadata = await loadEventMetricMetadata(client, eventId);
  const attribute = condition.attribute ?? null;
  const fieldLabel = attribute
    ? metadata.fieldLabels.get(attribute) ?? unqualifiedFieldName(attribute)
    : null;
  const metricId = behaviorMetricId(condition);
  await client.query(
    `INSERT INTO user_metric_definitions (
      id, name, display_name, processing_mode, user_event_id, event_name,
      default_properties, filter_conditions, agg_operator, agg_field, value_type, created_by
    )
    VALUES ($1, $2, $3, 'PAUSED', $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11)
    ON CONFLICT (id) DO NOTHING`,
    [
      metricId,
      `${condition.measure} ${metadata.eventName}`,
      metricDisplayName(metadata.eventLabel, condition.measure, fieldLabel),
      eventId,
      metadata.eventName,
      JSON.stringify(attributeValuesCondition(metadata.defaultValues)),
      filterConditionsText(condition.filters),
      condition.measure,
      attribute,
      metricValueType(attribute, catalogFieldType(metadata, attribute)),
      createdBy,
    ],
  );
  condition.metric_id = metricId;
}

function parseSegmentRow(row: Record<string, unknown>, uses: Map<string, SegmentUse[]>): Segment | null {
  if (typeof row.id !== "string" || typeof row.name !== "string") return null;
  try {
    return {
      id: row.id as SegmentId,
      name: row.name,
      description: typeof row.description === "string" ? row.description : "",
      conditions: parseSegmentConditions(row.conditions_json),
      updatedAt: timestampText(row.updated_at),
      usedBy: uses.get(row.id) ?? [],
    };
  } catch {
    return null;
  }
}

// SEG-FR-01: every segment, with the campaigns that use it. A row that does not parse is logged
// and left out.
export async function listSegments(): Promise<Segment[]> {
  await ensureDbInitialized();
  const pool = getPool();
  const uses = await loadSegmentUses(pool);
  const result = await pool.query(
    "SELECT id, name, description, conditions_json, updated_at FROM segments ORDER BY name, id",
  );
  return result.rows.flatMap((row) => {
    const segment = parseSegmentRow(row, uses);
    if (!segment) console.warn(`Leaving segment ${String(row.id)} out of the list: its row does not parse.`);
    return segment ? [segment] : [];
  });
}

// A segment as studio v2 lists it (SEG-FR-09). The conditions are not read, so a segment whose
// conditions do not parse is still listed.
export interface SegmentSummary {
  id: string;
  name: string;
  description: string;
  /** The creator's email, or null when the creator's user was deleted. */
  createdBy: string | null;
  updatedAt: string | null;
  usedBy: SegmentUse[];
}

// SEG-FR-09: every segment, by name, with its creator and the campaigns that use it. Reads only.
export async function listSegmentSummaries(): Promise<SegmentSummary[]> {
  await ensureDbInitialized();
  const pool = getPool();
  const [uses, result] = await Promise.all([
    loadSegmentUses(pool),
    pool.query(`
      SELECT segments.id, segments.name, segments.description, segments.updated_at, system_users.email AS created_by
      FROM segments
      LEFT JOIN system_users ON system_users.id = segments.created_by
      ORDER BY segments.name, segments.id
    `),
  ]);
  return result.rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    description: typeof row.description === "string" ? row.description : "",
    createdBy: typeof row.created_by === "string" ? row.created_by : null,
    updatedAt: timestampText(row.updated_at),
    usedBy: uses.get(String(row.id)) ?? [],
  }));
}

// One segment as the studio v2 editor opens it (SEG-FR-01, SEG-FR-07): its conditions, its
// creator, its times, and the campaigns that use it. Null when no segment has the id. A stored
// row whose conditions do not parse is refused, so the editor never saves over what it cannot show.
export interface SegmentDetail extends Segment {
  createdBy: string | null;
  createdAt: string | null;
}

export async function getSegmentDetail(id: SegmentId): Promise<SegmentDetail | null> {
  await ensureDbInitialized();
  const pool = getPool();
  const [uses, result] = await Promise.all([
    loadSegmentUses(pool),
    pool.query(
      `SELECT segments.id, segments.name, segments.description, segments.conditions_json,
              segments.created_at, segments.updated_at, system_users.email AS created_by
       FROM segments
       LEFT JOIN system_users ON system_users.id = segments.created_by
       WHERE segments.id = $1`,
      [id],
    ),
  ]);
  const row = result.rows[0];
  if (!row) return null;
  const segment = parseSegmentRow(row, uses);
  if (!segment) throw new UserFacingError(`Segment ${id} has conditions Studio cannot read.`);
  return {
    ...segment,
    createdBy: typeof row.created_by === "string" ? row.created_by : null,
    createdAt: timestampText(row.created_at),
  };
}

// What a save did: the segment was written, or active campaigns use it and the editor has not
// confirmed each of them.
export type SegmentSaveResult = { saved: true; id: SegmentId } | { saved: false; confirm: SegmentUse[] };

// SEG-FR-01, SEG-FR-03, SEG-FR-05, SEG-FR-06: creates or replaces a segment, and derives the
// metric definitions of its behavior conditions, in one transaction. An edit of a segment that
// active campaigns use is written only when confirmedCampaignIds holds each of them.
export async function saveSegment(
  input: SegmentInput,
  actorUserId: string,
  confirmedCampaignIds: readonly string[] = [],
): Promise<SegmentSaveResult> {
  await ensureDbInitialized();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // A campaign save or a segment delete that reads references waits for this save.
    await lockMetricDefinitions(client);
    let id = input.id;
    let stored: Record<string, unknown> | undefined;
    if (id && input.create) {
      stored = (await client.query(
        "SELECT name, description, conditions_json FROM segments WHERE id = $1 FOR UPDATE",
        [id],
      )).rows[0];
    } else if (id) {
      const existing = await client.query("SELECT id FROM segments WHERE id = $1 FOR UPDATE", [id]);
      if (existing.rows.length === 0) throw new UserFacingError(`Segment ${id} not found.`);
      const unconfirmed = ((await loadSegmentUses(client)).get(id) ?? [])
        .filter((use) => use.status === "active" && !confirmedCampaignIds.includes(use.campaignId));
      if (unconfirmed.length > 0) {
        await client.query("ROLLBACK");
        return { saved: false, confirm: unconfirmed };
      }
    } else {
      id = newSegmentId();
    }
    const conditions: typeof input.conditions = structuredClone(input.conditions);
    for (const condition of behaviorConditions(conditions)) {
      await deriveMetricDefinition(client, condition, actorUserId);
    }
    // A retried create converges: the same id and body changes nothing, another body is refused.
    if (stored) {
      const same = stored.name === input.name
        && stored.description === input.description
        && canonicalJson(stored.conditions_json) === canonicalJson(conditions);
      if (!same) throw new UserFacingError(`Segment ${id} already exists.`);
      await client.query("COMMIT");
      return { saved: true, id: id! };
    }
    await client.query(
      `INSERT INTO segments (id, name, description, conditions_json, created_by, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
         conditions_json = EXCLUDED.conditions_json, updated_at = NOW()`,
      [id, input.name, input.description, JSON.stringify(conditions), actorUserId],
    );
    await syncMetricProcessingModes(client);
    await client.query("COMMIT");
    return { saved: true, id };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function segmentUseLine(use: SegmentUse): string {
  return `${use.campaignName} (${use.status})`;
}

// SEG-FR-04: refuses while an active or paused campaign uses the segment, and names each one.
export async function deleteSegment(id: SegmentId): Promise<void> {
  await ensureDbInitialized();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // A publish that names the segment waits for this delete, or this delete sees its rows.
    await lockMetricDefinitions(client);
    const existing = await client.query("SELECT id FROM segments WHERE id = $1 FOR UPDATE", [id]);
    // A repeated delete, such as a retry after a lost response, finds the row gone and succeeds.
    if (existing.rows.length === 0) {
      await client.query("COMMIT");
      return;
    }
    const uses = (await loadSegmentUses(client)).get(id) ?? [];
    if (uses.length > 0) {
      throw new UserFacingError(
        `The segment cannot be deleted while campaigns use it: ${uses.map(segmentUseLine).join(", ")}.`,
      );
    }
    await client.query("DELETE FROM segments WHERE id = $1", [id]);
    await syncMetricProcessingModes(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Data ingestion API: source keys. Only a hash of each key reaches the database (DIA-NFR-05).

export interface SourceKeySummary {
  id: string;
  appId: string;
  keyHint: string;
  createdAt: string;
  revokedAt: string | null;
}

const SOURCE_KEY_APP_ID_CONSTRAINT = "ingestion_source_keys_active_app_id_key";

export async function getSourceKeys(): Promise<SourceKeySummary[]> {
  await ensureDbInitialized();
  const res = await getPool().query(
    `SELECT id, app_id, key_hint, created_at, revoked_at FROM ingestion_source_keys ORDER BY created_at DESC, id`,
  );
  return res.rows.map((row) => ({
    id: String(row.id),
    appId: String(row.app_id),
    keyHint: String(row.key_hint),
    createdAt: new Date(row.created_at).toISOString(),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
  }));
}

export async function createSourceKey(
  appId: string,
  keyHash: string,
  keyHint: string,
  createdBy: string,
): Promise<string> {
  await ensureDbInitialized();
  const id = `sk_${randomUUID()}`;
  try {
    await getPool().query(
      `INSERT INTO ingestion_source_keys (id, app_id, key_hash, key_hint, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [id, appId, keyHash, keyHint, createdBy],
    );
  } catch (error) {
    const duplicate =
      typeof error === "object"
      && error !== null
      && (error as { code?: unknown }).code === "23505"
      && (error as { constraint?: unknown }).constraint === SOURCE_KEY_APP_ID_CONSTRAINT;
    if (duplicate) throw new UserFacingError(`The app id "${appId}" already has a key. Revoke it first.`);
    throw error;
  }
  return id;
}

// Revoking twice keeps the first revocation time.
export async function revokeSourceKey(id: string): Promise<void> {
  await ensureDbInitialized();
  const res = await getPool().query(
    `UPDATE ingestion_source_keys SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP) WHERE id = $1`,
    [id],
  );
  if (res.rowCount === 0) throw new UserFacingError("The source key no longer exists.");
}

export interface StoredSourceKey {
  appId: string;
  revoked: boolean;
}

export async function findSourceKeyByHash(keyHash: string): Promise<StoredSourceKey | null> {
  await ensureDbInitialized();
  const res = await getPool().query(
    `SELECT app_id, revoked_at FROM ingestion_source_keys WHERE key_hash = $1`,
    [keyHash],
  );
  if (res.rowCount === 0) return null;
  return { appId: String(res.rows[0].app_id), revoked: res.rows[0].revoked_at !== null };
}

// The catalog kind and item key of each named event that is in the catalog.
export async function getCatalogEventKinds(eventNames: string[]): Promise<Map<string, EventKind>> {
  await ensureDbInitialized();
  const res = await getPool().query(
    `SELECT event_name, kind, item_key FROM user_events WHERE event_name = ANY($1::text[])`,
    [eventNames],
  );
  const kinds = new Map<string, EventKind>();
  for (const row of res.rows) {
    const kind = storedEventKind(row);
    if (kind) kinds.set(String(row.event_name), kind);
  }
  return kinds;
}

/** A statement and its parameters, for code that builds SQL apart from running it. */
export type SqlQuery = { text: string; values: unknown[] };

export type RunQuery = (query: SqlQuery) => Promise<Record<string, unknown>[]>;

// Runs work in one read-only transaction on one connection, with each statement bounded by
// timeoutMs, so that a slow read fails on its own and nothing it runs can write. REPEATABLE READ
// gives every statement of work the same snapshot, so counts read in separate statements agree.
// JIT is off because compiling cost more than running: 379 ms of a 406 ms query in EXPLAIN.
export async function readOnly<T>(timeoutMs: number, work: (run: RunQuery) => Promise<T>): Promise<T> {
  await ensureDbInitialized();
  const client = await getPool().connect();
  // A connection whose ROLLBACK failed is in an unknown state, so the pool destroys it.
  let broken: Error | undefined;
  try {
    await client.query("BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ");
    await client.query("SELECT set_config('statement_timeout', $1, true), set_config('jit', 'off', true)", [
      String(timeoutMs),
    ]);
    const result = await work(async (query) => (await client.query(query.text, query.values)).rows);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch((rollbackError: unknown) => {
      broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    });
    throw e;
  } finally {
    client.release(broken);
  }
}
