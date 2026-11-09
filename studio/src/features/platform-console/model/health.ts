// Health of a tool, checked from studio's server by the rules in the platform console contract
// (PCN-FR-04). Reasons are our own words: no response body, header, or token reaches them (PCN-FR-09).
import type { FlinkJob, HealthCheck } from "./tools";

export type HealthStatus = "up" | "degraded" | "down" | "unknown";

// The parts that make a tool's health, for its card to list (PCN-FR-14). Flink lists every job it
// was asked about; Argo CD lists only the applications that are not synced and healthy.
export type HealthDetails = { kind: "flink"; jobs: JobState[] } | { kind: "argocd"; apps: ArgocdApp[] };

// state is Flink's job state, such as RUNNING or RESTARTING, or "Not known" when the job could not
// be read. fine is true only for RUNNING with every task running.
export interface JobState {
  name: string;
  fine: boolean;
  state: string;
}

export interface ArgocdApp {
  name: string;
  sync: string;
  health: string;
}

export interface Health {
  status: HealthStatus;
  reason: string;
  details?: HealthDetails;
}

export interface HealthDeps {
  fetch: typeof fetch;
  argocdToken: string | undefined;
}

export const CHECK_TIMEOUT_MS = 3_000;
const NAMED_LIMIT = 3;
// Only the fields the check reads, so Argo CD does not send every application's resource tree.
export const ARGOCD_APP_FIELDS = ["items.metadata.name", "items.status.sync.status", "items.status.health.status"];

type Answer = { kind: "answered"; status: number; body: unknown } | { kind: "timed-out" } | { kind: "no-answer" };

const TIMED_OUT: Health = { status: "unknown", reason: "timed out" };
const NO_ANSWER: Health = { status: "down", reason: "no answer" };
const NOT_KNOWN = "Not known";

// Never rejects. Each check sends its requests once, with no retry (contract, Health of a tool).
export async function checkHealth(check: HealthCheck, deps: HealthDeps): Promise<Health> {
  switch (check.kind) {
    case "argocd":
      return argocdHealth(check.url, deps);
    case "grafana":
      return grafanaHealth(check.url, deps);
    case "flink":
      return flinkHealth(check.jobs, deps);
    case "http":
      return httpHealth(check.url, deps);
  }
}

async function argocdHealth(url: string, deps: HealthDeps): Promise<Health> {
  if (!deps.argocdToken) return { status: "unknown", reason: "not configured" };
  const answer = await ask(deps, `${url}/api/v1/applications?fields=${ARGOCD_APP_FIELDS.join(",")}`, {
    headers: { Authorization: `Bearer ${deps.argocdToken}` },
  });
  if (answer.kind !== "answered") return unanswered(answer);
  if (answer.status === 401 || answer.status === 403) return { status: "unknown", reason: "token rejected" };
  if (!ok(answer.status)) return answeredWith(answer.status);

  const apps = argocdApps(answer.body);
  if (!apps) return { status: "unknown", reason: "unexpected answer" };
  const unhealthy = apps.filter((app) => app.sync !== "Synced" || app.health !== "Healthy");
  const details: HealthDetails = { kind: "argocd", apps: unhealthy };
  if (unhealthy.length === 0) return { status: "up", reason: `${count(apps.length, "application")} synced and healthy`, details };
  return {
    status: "degraded",
    reason: named(unhealthy.map((app) => `${app.name}: ${app.sync}, ${app.health}`)),
    details,
  };
}

function argocdApps(body: unknown): ArgocdApp[] | null {
  const fields = record(body);
  if (!fields) return null;
  // Argo CD sends "items": null when there is no application.
  if (fields.items === null) return [];
  if (!Array.isArray(fields.items)) return null;
  return fields.items.map((item) => {
    const status = record(record(item)?.status);
    return {
      name: word(record(record(item)?.metadata)?.name) ?? "unnamed",
      sync: word(record(status?.sync)?.status) ?? "Unknown",
      health: word(record(status?.health)?.status) ?? "Unknown",
    };
  });
}

async function grafanaHealth(url: string, deps: HealthDeps): Promise<Health> {
  const answer = await ask(deps, `${url}/api/health`);
  if (answer.kind !== "answered") return unanswered(answer);
  // Grafana answers 503 with "database": "failing" when it cannot reach its database.
  const database = record(answer.body)?.database;
  if (typeof database === "string" && database !== "ok") return { status: "degraded", reason: "database failing" };
  if (ok(answer.status) && database === "ok") return { status: "up", reason: "healthy" };
  if (ok(answer.status)) return { status: "unknown", reason: "unexpected answer" };
  return answeredWith(answer.status);
}

type JobRead = { job: string; state: "fine" | string } | { job: string; unread: Answer["kind"] };

async function flinkHealth(jobs: FlinkJob[], deps: HealthDeps): Promise<Health> {
  const reads = await Promise.all(jobs.map((job) => readFlinkJob(job, deps)));
  const unread = reads.filter((read) => "unread" in read);
  if (unread.length === reads.length) {
    return unread.every((read) => read.unread === "timed-out") ? TIMED_OUT : { status: "down", reason: "jobs cannot be read" };
  }
  const problems = reads.flatMap((read) => {
    if ("unread" in read) return [`${read.job}: ${read.unread === "timed-out" ? "timed out" : "unreachable"}`];
    return read.state === "fine" ? [] : [`${read.job}: ${read.state}`];
  });
  const details: HealthDetails = {
    kind: "flink",
    jobs: reads.map((read) =>
      "unread" in read
        ? { name: read.job, fine: false, state: NOT_KNOWN }
        : { name: read.job, fine: read.state === "fine", state: read.state === "fine" ? "RUNNING" : read.state },
    ),
  };
  if (problems.length === 0) return { status: "up", reason: `${count(jobs.length, "job")} running`, details };
  return { status: "degraded", reason: named(problems), details };
}

// A job is fine when it is RUNNING with every task running. Flink's REST API has no lifecycle
// state, so all tasks running stands in for the contract's STABLE.
async function readFlinkJob(job: FlinkJob, deps: HealthDeps): Promise<JobRead> {
  const answer = await ask(deps, `${job.url}/jobs/overview`);
  if (answer.kind !== "answered") return { job: job.name, unread: answer.kind };
  if (!ok(answer.status)) return { job: job.name, unread: "no-answer" };

  const listed = record(answer.body)?.jobs;
  if (!Array.isArray(listed)) return { job: job.name, unread: "no-answer" };
  // An application cluster can still list the job it ran before a restart, so read the newest.
  const newest = listed
    .map(record)
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .sort((a, b) => numberOr(b["start-time"], 0) - numberOr(a["start-time"], 0))[0];
  if (!newest) return { job: job.name, state: "no job" };

  const state = word(newest.state) ?? "UNKNOWN";
  const tasks = record(newest.tasks);
  const running = numberOr(tasks?.running, -1);
  const total = numberOr(tasks?.total, -1);
  if (state !== "RUNNING") return { job: job.name, state };
  if (running !== total || total < 0) return { job: job.name, state: `RUNNING, ${Math.max(running, 0)} of ${Math.max(total, 0)} tasks running` };
  return { job: job.name, state: "fine" };
}

async function httpHealth(url: string, deps: HealthDeps): Promise<Health> {
  const answer = await ask(deps, url, { redirect: "manual" });
  if (answer.kind !== "answered") return unanswered(answer);
  if (answer.status >= 200 && answer.status < 400) return { status: "up", reason: `answered ${answer.status}` };
  return answeredWith(answer.status);
}

async function ask(deps: HealthDeps, url: string, init: RequestInit = {}): Promise<Answer> {
  try {
    const response = await deps.fetch(url, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => null);
    return { kind: "answered", status: response.status, body };
  } catch (error) {
    // fetch rejects with a DOMException, which is not an Error in every realm.
    return record(error)?.name === "TimeoutError" ? { kind: "timed-out" } : { kind: "no-answer" };
  }
}

function unanswered(answer: Exclude<Answer, { kind: "answered" }>): Health {
  return answer.kind === "timed-out" ? TIMED_OUT : NO_ANSWER;
}

function answeredWith(status: number): Health {
  return { status: "down", reason: `answered ${status}` };
}

function ok(status: number): boolean {
  return status >= 200 && status < 300;
}

function named(items: string[]): string {
  const shown = items.slice(0, NAMED_LIMIT).join("; ");
  return items.length > NAMED_LIMIT ? `${shown}; and ${items.length - NAMED_LIMIT} more` : shown;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// A short identifier from a response, such as a state or an application name. Anything else is
// dropped, so a body cannot put free text in a reason.
function word(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,63}$/.test(value) ? value : null;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
