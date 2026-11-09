import type { RunQuery, SqlQuery } from "@/lib/db";

/** The field a condition names for a dataset column or a dataset metric: `<dataset>.<name>`. */
export function importedField(dataset: string, name: string): string {
  return `${dataset}.${name}`;
}

/** True when the saved JSON holds a `profile_property` condition on `field`, at any depth. */
export function namesProfileField(json: unknown, field: string): boolean {
  if (Array.isArray(json)) return json.some((item) => namesProfileField(item, field));
  if (typeof json !== "object" || json === null) return false;
  const node = json as Record<string, unknown>;
  if (node.type === "profile_property" && node.field === field) return true;
  return Object.values(node).some((value) => namesProfileField(value, field));
}

function parsed(text: unknown): unknown {
  if (typeof text !== "string") return text;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface FieldUses {
  campaigns: { id: string; name: string }[];
  segments: { id: string; name: string }[];
}

// The text filter only narrows the rows. namesProfileField decides, so a value that happens to
// hold the field's text is not a use.
export function campaignUsesQuery(field: string): SqlQuery {
  return {
    text: `SELECT campaigns.id, campaigns.name, campaign_nodes.trigger_json, campaign_nodes.conditions_json,
                  campaign_nodes.paths_json
           FROM campaign_nodes
           JOIN campaigns ON campaigns.id = campaign_nodes.campaign_id
           WHERE campaigns.status IN ('active', 'paused')
             AND (strpos(campaign_nodes.trigger_json, $1) > 0 OR strpos(campaign_nodes.conditions_json, $1) > 0
                  OR strpos(campaign_nodes.paths_json, $1) > 0)`,
    values: [JSON.stringify(field)],
  };
}

export function segmentUsesQuery(field: string): SqlQuery {
  return {
    text: `SELECT id, name, conditions_json FROM segments WHERE strpos(conditions_json::text, $1) > 0`,
    values: [JSON.stringify(field)],
  };
}

/** Narrows the candidate rows of the two queries to real uses, one entry per campaign or segment. */
export function fieldUses(field: string, campaignRows: Record<string, unknown>[], segmentRows: Record<string, unknown>[]): FieldUses {
  const campaigns = new Map<string, string>();
  for (const row of campaignRows) {
    const named = [row.trigger_json, row.conditions_json, row.paths_json].some((text) => namesProfileField(parsed(text), field));
    if (named) campaigns.set(String(row.id), String(row.name));
  }
  const segments = segmentRows
    .filter((row) => namesProfileField(parsed(row.conditions_json), field))
    .map((row) => ({ id: String(row.id), name: String(row.name) }));
  return { campaigns: [...campaigns].map(([id, name]) => ({ id, name })), segments };
}

/**
 * DIM-FR-05, DIM-FR-18: the active or paused campaigns and the segments that name an imported
 * field. Run it in the transaction that makes the change it guards.
 */
export async function findFieldUses(run: RunQuery, field: string): Promise<FieldUses> {
  return fieldUses(field, await run(campaignUsesQuery(field)), await run(segmentUsesQuery(field)));
}

/** DIM-FR-05: the dataset metrics, archived or not, whose column is `column` or whose filters name it. */
export async function findMetricsUsingColumn(
  run: RunQuery,
  recordTypeId: string,
  column: string,
): Promise<{ id: string; name: string }[]> {
  const rows = await run({
    text: `SELECT id, name, "column", filters FROM import_metric_definitions WHERE record_type_id = $1`,
    values: [recordTypeId],
  });
  return rows
    .filter((row) => row.column === column || filterNames(row.filters, column))
    .map((row) => ({ id: String(row.id), name: String(row.name) }));
}

function filterNames(json: unknown, column: string): boolean {
  if (Array.isArray(json)) return json.some((item) => filterNames(item, column));
  if (typeof json !== "object" || json === null) return false;
  const node = json as Record<string, unknown>;
  return node.column === column || node.field === column || Object.values(node).some((value) => filterNames(value, column));
}
