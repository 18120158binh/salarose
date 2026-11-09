// The tools and quick links of the platform console, parsed from studio's environment (PCN-FR-03).
// Code past parsePlatformConfig trusts these types.

export type SignIn = "sso" | "own-login";

export interface Link {
  label: string;
  url: string;
}

export interface FlinkJob {
  name: string;
  url: string;
}

// url and each job's url are internal base addresses, without a trailing slash, that only
// studio's server calls.
export type HealthCheck =
  | { kind: "argocd"; url: string }
  | { kind: "grafana"; url: string }
  | { kind: "flink"; jobs: FlinkJob[] }
  | { kind: "http"; url: string };

export interface ConfiguredTool {
  status: "configured";
  id: string;
  name: string;
  purpose: string;
  url: string;
  signIn: SignIn;
  health: HealthCheck;
  links: Link[];
}

// An entry with a usable id and name whose other fields are missing or invalid. Its card shows
// health unknown, "not configured".
export interface UnconfiguredTool {
  status: "not-configured";
  id: string;
  name: string;
}

export type Tool = ConfiguredTool | UnconfiguredTool;

export interface PlatformConfig {
  tools: Tool[];
  quickLinks: Link[];
  // Why the tool list is empty, when PLATFORM_TOOLS is missing or is not a JSON array.
  problem: string | null;
}

type Fields = Record<string, unknown>;

const KIND_ORDER: Record<HealthCheck["kind"], number> = { argocd: 0, grafana: 1, flink: 2, http: 3 };
const JOB_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function parsePlatformConfig(env: Record<string, string | undefined>): PlatformConfig {
  const quickLinks = parseList(env.PLATFORM_QUICK_LINKS, "PLATFORM_QUICK_LINKS").flatMap((entry, index) => {
    const link = parseLink(entry);
    if (!link) warn(`PLATFORM_QUICK_LINKS entry ${index} is not a link with a label and an http(s) url; skipped.`);
    return link ? [link] : [];
  });

  if (env.PLATFORM_TOOLS === undefined || env.PLATFORM_TOOLS.trim() === "") {
    return { tools: [], quickLinks, problem: "No tools are configured. Set PLATFORM_TOOLS in studio's environment." };
  }
  const entries = parseJsonArray(env.PLATFORM_TOOLS);
  if (!entries) {
    warn("PLATFORM_TOOLS is not a JSON array; no tools are shown.");
    return { tools: [], quickLinks, problem: "PLATFORM_TOOLS is not a JSON array, so no tools are shown." };
  }

  const ids = new Set<string>();
  const tools = entries.flatMap((entry, index): Tool[] => {
    const tool = parseTool(entry);
    if (!tool) {
      warn(`PLATFORM_TOOLS entry ${index} has no usable id and name; skipped.`);
      return [];
    }
    if (ids.has(tool.id)) {
      warn(`PLATFORM_TOOLS entry ${index} repeats the id "${tool.id}"; skipped.`);
      return [];
    }
    ids.add(tool.id);
    if (tool.status === "not-configured") warn(`PLATFORM_TOOLS entry "${tool.id}" is invalid; shown as not configured.`);
    return [tool];
  });

  return { tools: [...tools].sort((a, b) => rank(a) - rank(b)), quickLinks, problem: null };
}

// The links a card shows under its address. A Flink card links to each job's UI under the landing
// page (PCN-FR-06), so the job names are configured once, in the health check.
export function toolLinks(tool: ConfiguredTool): Link[] {
  const jobLinks =
    tool.health.kind === "flink"
      ? tool.health.jobs.map((job) => ({ label: job.name, url: `${tool.url}/${encodeURIComponent(job.name)}/` }))
      : [];
  return [...jobLinks, ...tool.links];
}

function rank(tool: Tool): number {
  return tool.status === "configured" ? KIND_ORDER[tool.health.kind] : KIND_ORDER.http;
}

function parseTool(value: unknown): Tool | null {
  const fields = record(value);
  if (!fields) return null;
  const id = text(fields.id);
  const name = text(fields.name);
  if (!id || !name) return null;

  const purpose = text(fields.purpose);
  const url = httpUrl(fields.url);
  const signIn = fields.signIn === "sso" || fields.signIn === "own-login" ? fields.signIn : null;
  const health = parseHealthCheck(fields.health);
  const links = fields.links === undefined ? [] : parseLinks(fields.links);
  if (!purpose || !url || !signIn || !health || !links) return { status: "not-configured", id, name };
  return { status: "configured", id, name, purpose, url, signIn, health, links };
}

function parseHealthCheck(value: unknown): HealthCheck | null {
  const fields = record(value);
  if (!fields) return null;
  switch (fields.kind) {
    case "argocd":
    case "grafana":
    case "http": {
      const url = httpUrl(fields.url);
      return url ? { kind: fields.kind, url } : null;
    }
    case "flink": {
      if (!Array.isArray(fields.jobs) || fields.jobs.length === 0) return null;
      const jobs = fields.jobs.map(parseFlinkJob);
      return jobs.every((job): job is FlinkJob => job !== null) ? { kind: "flink", jobs } : null;
    }
    default:
      return null;
  }
}

function parseFlinkJob(value: unknown): FlinkJob | null {
  const fields = record(value);
  const name = text(fields?.name);
  const url = httpUrl(fields?.url);
  return name && JOB_NAME.test(name) && url ? { name, url } : null;
}

function parseLinks(value: unknown): Link[] | null {
  if (!Array.isArray(value)) return null;
  const links = value.map(parseLink);
  return links.every((link): link is Link => link !== null) ? links : null;
}

function parseLink(value: unknown): Link | null {
  const fields = record(value);
  const label = text(fields?.label);
  const url = httpUrl(fields?.url);
  return label && url ? { label, url } : null;
}

function parseList(raw: string | undefined, name: string): unknown[] {
  if (raw === undefined || raw.trim() === "") return [];
  const list = parseJsonArray(raw);
  if (!list) warn(`${name} is not a JSON array; ignored.`);
  return list ?? [];
}

function parseJsonArray(raw: string): unknown[] | null {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Fields | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// An absolute http(s) URL, without a trailing slash so that paths join onto it.
function httpUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return raw.replace(/\/+$/, "");
}

function warn(message: string): void {
  console.warn(`[platform-console] ${message}`);
}
