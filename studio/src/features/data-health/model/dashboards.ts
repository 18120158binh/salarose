// DHL-FR-03: the pipeline dashboards the deployment declares in PIPELINE_DASHBOARDS, a JSON array of
// {"name", "url"}. Code past parsePipelineDashboards trusts these types.

export type Dashboard = { readonly name: string; readonly url: string };

function warn(message: string): void {
  console.warn(`[data-health] ${message}`);
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !URL.canParse(value.trim())) return null;
  const url = new URL(value.trim());
  return url.protocol === "http:" || url.protocol === "https:" ? value.trim() : null;
}

function parseDashboard(value: unknown): Dashboard | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  const url = httpUrl(fields.url);
  return name !== "" && url !== null ? { name, url } : null;
}

/** A missing or invalid value declares no dashboards. An invalid entry is skipped with a warning. */
export function parsePipelineDashboards(raw: string | undefined): Dashboard[] {
  if (raw === undefined || raw.trim() === "") return [];
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    entries = null;
  }
  if (!Array.isArray(entries)) {
    warn("PIPELINE_DASHBOARDS is not a JSON array; no dashboards are shown.");
    return [];
  }
  return entries.flatMap((entry, index) => {
    const dashboard = parseDashboard(entry);
    if (!dashboard) warn(`PIPELINE_DASHBOARDS entry ${index} is not a dashboard with a name and an http(s) url; skipped.`);
    return dashboard ? [dashboard] : [];
  });
}
