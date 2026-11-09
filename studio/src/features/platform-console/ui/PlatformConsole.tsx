import { ChevronDownIcon, ExternalLinkIcon, InfoIcon } from "lucide-react";
import { Suspense, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { SectionCard } from "@/shared/ui/v2/SectionCard";
import { StatusBadge, type StatusTone } from "@/shared/ui/v2/StatusBadge";
import type { ArgocdApp, Health, HealthDetails, JobState } from "../model/health";
import { checkedText, platformStatus, type PlatformStatus, type StatusKind, type ToolResult } from "../model/status";
import type { ConfiguredTool, Link, PlatformConfig, SignIn, Tool } from "../model/tools";
import { RecheckButton } from "./RecheckButton";

export interface PlatformConsoleProps {
  config: PlatformConfig;
  // The health of a configured tool. It must return the same promise for a tool on every render.
  healthOf: (tool: ConfiguredTool) => Promise<Health>;
  // When the check behind a tool's health started, once healthOf has run for it.
  checkedAt: (toolId: string) => number | null;
  now: () => number;
}

const HEALTH: Record<ToolResult["status"], { tone: StatusTone; word: string }> = {
  up: { tone: "success", word: "Up" },
  degraded: { tone: "warning", word: "Degraded" },
  down: { tone: "error", word: "Down" },
  unknown: { tone: "neutral", word: "Unknown" },
  checking: { tone: "info", word: "Checking" },
};

const BANNER: Record<StatusKind, { tone: StatusTone; className: string }> = {
  ok: { tone: "success", className: "border-success/25 bg-success/5" },
  attention: { tone: "warning", className: "border-warning/30 bg-warning/5" },
  checking: { tone: "info", className: "border-info/25 bg-info/5" },
  none: { tone: "neutral", className: "border-border bg-card" },
};

const SIGN_IN: Record<SignIn, { text: string; note: string }> = {
  sso: { text: "Single sign-on", note: "No second password" },
  "own-login": { text: "Own login", note: "The tool asks for its own password" },
};

type Check = { tool: Tool; health: Promise<Health> | null };

// PCN-FR-11: the Platform board, status first. The page only reads.
export function PlatformConsole({ config, healthOf, checkedAt, now }: PlatformConsoleProps) {
  const checks: Check[] = config.tools.map((tool) => ({ tool, health: tool.status === "configured" ? healthOf(tool) : null }));
  const pending = checks.map(({ tool, health }): ToolResult =>
    health ? { id: tool.id, name: tool.name, status: "checking", reason: "Checking health…" } : notConfigured(tool),
  );

  return (
    <div className="flex flex-col gap-6">
      <Suspense fallback={<StatusBanner checked="Checking now…" status={platformStatus(pending)} />}>
        <SettledBanner checkedAt={checkedAt} checks={checks} now={now} />
      </Suspense>

      <SectionCard
        description={checks.length > 0 ? `${checks.length} tools, in the order the deployment lists them` : undefined}
        flush
        title="Tools"
      >
        {checks.length === 0 ? (
          <div className="flex flex-col gap-1 px-4 pb-4 text-sm">
            <p className="font-medium">No tools</p>
            <p className="text-muted-foreground">
              {config.problem ?? "No tools are configured. Set PLATFORM_TOOLS in studio's environment, then reload this page."}
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-border border-y bg-muted/40 text-left text-muted-foreground text-xs">
              <tr>
                <th className="px-4 py-2 font-medium" scope="col">
                  Tool
                </th>
                <th className="px-4 py-2 font-medium" scope="col">
                  Health
                </th>
                <th className="px-4 py-2 font-medium" scope="col">
                  Sign-in
                </th>
                <th className="px-4 py-2 font-medium" scope="col">
                  Open
                </th>
              </tr>
            </thead>
            {checks.map(({ tool, health }, index) =>
              health === null ? (
                <ToolRows key={tool.id} result={pending[index]} tool={tool} />
              ) : (
                <Suspense fallback={<ToolRows result={pending[index]} tool={tool} />} key={tool.id}>
                  <SettledToolRows health={health} tool={tool} />
                </Suspense>
              ),
            )}
          </table>
        )}
      </SectionCard>

      {config.quickLinks.length > 0 && (
        <SectionCard title="Quick links">
          <ul className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {config.quickLinks.map((link) => (
              <li key={`${link.label} ${link.url}`}>
                <ExternalLink link={link} />
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <aside aria-label="About this page" className="flex gap-3 rounded-card border border-border bg-card px-4 py-3 text-sm">
        <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="flex flex-col gap-1">
          <p className="font-medium">This page only reads</p>
          <p className="text-muted-foreground">
            It checks health and never changes a tool. To sync, stop or restart something, open the tool. No password or token is shown
            here.
          </p>
          <p className="text-muted-foreground text-xs">
            Studio&apos;s server runs the checks, at most every 15 seconds. A tool that takes over 3 seconds shows Unknown.
          </p>
        </div>
      </aside>
    </div>
  );
}

function notConfigured(tool: Tool): ToolResult {
  return { id: tool.id, name: tool.name, status: "unknown", reason: "Not configured" };
}

async function SettledBanner({ checks, checkedAt, now }: { checks: Check[]; checkedAt: PlatformConsoleProps["checkedAt"]; now: () => number }) {
  const results = await Promise.all(
    checks.map(async ({ tool, health }): Promise<ToolResult> => (health ? { id: tool.id, name: tool.name, ...(await health) } : notConfigured(tool))),
  );
  const times = checks.filter((check) => check.health !== null).map((check) => checkedAt(check.tool.id));
  return <StatusBanner checked={checkedText(times, now())} status={platformStatus(results)} />;
}

// PCN-FR-12: the word with its icon, the title, the count line, each tool not up, and the check time.
function StatusBanner({ status, checked }: { status: PlatformStatus; checked: string }) {
  const banner = BANNER[status.kind];
  return (
    <section
      aria-label="Platform status"
      aria-live="polite"
      className={cn("flex flex-wrap items-start gap-4 rounded-card border px-4 py-3.5", banner.className)}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <StatusBadge tone={banner.tone}>{status.word}</StatusBadge>
        <h2 className="font-heading font-semibold text-[0.9375rem] leading-snug">{status.title}</h2>
        <p className="text-muted-foreground text-sm">{status.line}</p>
        {status.listed.length > 0 && (
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {status.listed.map((tool) => (
              <li className="flex flex-wrap items-center gap-2" key={tool.id}>
                <StatusBadge tone={HEALTH[tool.status].tone}>{HEALTH[tool.status].word}</StatusBadge>
                <a
                  className="rounded-sm underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  href={`#tool-${tool.id}`}
                >
                  {`${tool.name} · ${tool.reason}`}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="text-muted-foreground text-xs">{checked}</span>
        <RecheckButton disabled={status.kind === "checking" || status.kind === "none"} />
      </div>
    </section>
  );
}

async function SettledToolRows({ tool, health }: { tool: Tool; health: Promise<Health> }) {
  const { status, reason, details } = await health;
  return <ToolRows details={details} result={{ id: tool.id, name: tool.name, status, reason }} tool={tool} />;
}

function ToolRows({ tool, result, details }: { tool: Tool; result: ToolResult; details?: HealthDetails }) {
  const state = HEALTH[result.status];
  const attention = result.status === "degraded" || result.status === "down";
  const degraded = result.status === "degraded";
  const jobs = tool.status === "configured" && tool.health.kind === "flink" ? jobRows(tool.health.jobs, result.status, details, degraded) : [];
  const apps = details?.kind === "argocd" ? details.apps : [];
  return (
    <tbody className={cn("border-border border-t", attention && "bg-warning/5")} id={`tool-${tool.id}`}>
      <tr className="align-top">
        <td className="px-4 py-3">
          <div className="flex items-start gap-3">
            <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted font-heading font-semibold text-xs">
              {tool.name.slice(0, 2)}
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">{tool.name}</span>
              {tool.status === "configured" && (
                <>
                  <span className="text-muted-foreground text-xs">{tool.purpose}</span>
                  <span className="truncate text-muted-foreground text-xs">{tool.url.replace(/^https?:\/\//, "")}</span>
                </>
              )}
            </div>
          </div>
        </td>
        <td className="px-4 py-3">
          <div className="flex flex-col gap-0.5">
            <StatusBadge tone={state.tone}>{state.word}</StatusBadge>
            <span className="text-muted-foreground text-xs">{result.reason}</span>
          </div>
        </td>
        <td className="px-4 py-3">
          {tool.status === "configured" ? (
            <div className="flex flex-col gap-0.5">
              <span>{SIGN_IN[tool.signIn].text}</span>
              <span className="text-muted-foreground text-xs">{SIGN_IN[tool.signIn].note}</span>
            </div>
          ) : (
            <span className="text-muted-foreground">Not known</span>
          )}
        </td>
        <td className="px-4 py-3">
          {tool.status === "configured" ? (
            <div className="flex flex-col gap-1">
              <ExternalLink link={{ label: "Open", url: tool.url }} name={`Open ${tool.name}`} />
              {tool.links.map((link) => (
                <ExternalLink key={`${link.label} ${link.url}`} link={link} />
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground text-xs">The configuration of this tool is missing or invalid, so it has no address.</span>
          )}
        </td>
      </tr>
      {tool.status === "configured" && jobs.length > 0 && (
        <DetailRow label={`Jobs (${jobs.length})`} open={degraded}>
          <p className="text-muted-foreground text-xs">
            A job is fine when it is RUNNING and STABLE. Stop or restart a job inside Flink, not here.
          </p>
          <ul className="flex flex-col divide-y divide-border text-sm">
            {jobs.map((job) => (
              <li className="flex flex-wrap items-center justify-between gap-2 py-1.5" key={job.name}>
                <span className="font-mono text-xs">{job.name}</span>
                <JobStateBadge job={job} />
                <ExternalLink link={{ label: "Job UI", url: `${tool.url}/${encodeURIComponent(job.name)}/` }} name={`Job UI ${job.name}`} />
              </li>
            ))}
          </ul>
        </DetailRow>
      )}
      {tool.status === "configured" && apps.length > 0 && (
        <DetailRow label={`Apps (${apps.length})`} open={degraded}>
          <p className="font-medium text-sm">Apps that are not synced and healthy</p>
          <p className="text-muted-foreground text-xs">Every other app is synced and healthy. Sync an app inside Argo CD, not here.</p>
          <ul className="flex flex-col divide-y divide-border text-sm">
            {apps.map((app) => (
              <AppRow app={app} argocdUrl={tool.url} key={app.name} />
            ))}
          </ul>
        </DetailRow>
      )}
    </tbody>
  );
}

type JobRow = { name: string; state: JobState | "checking" };

// Each configured job with its state from the check, the jobs not running first when Flink is
// degraded (PCN-FR-16). A job the check did not report shows "Not known".
function jobRows(configured: { name: string }[], status: ToolResult["status"], details: HealthDetails | undefined, degraded: boolean): JobRow[] {
  const read = new Map((details?.kind === "flink" ? details.jobs : []).map((job) => [job.name, job]));
  const rows = configured.map(({ name }): JobRow => ({
    name,
    state: status === "checking" ? "checking" : (read.get(name) ?? { name, fine: false, state: "Not known" }),
  }));
  if (!degraded) return rows;
  const fine = (row: JobRow) => row.state !== "checking" && row.state.fine;
  return [...rows.filter((row) => !fine(row)), ...rows.filter(fine)];
}

function JobStateBadge({ job }: { job: JobRow }) {
  if (job.state === "checking") return <StatusBadge tone="info">Checking</StatusBadge>;
  if (job.state.fine) return <StatusBadge tone="success">Running</StatusBadge>;
  return <StatusBadge tone={job.state.state === "Not known" ? "neutral" : "warning"}>{job.state.state}</StatusBadge>;
}

function AppRow({ app, argocdUrl }: { app: ArgocdApp; argocdUrl: string }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-1.5">
      <span className="font-mono text-xs">{app.name}</span>
      <span className="flex items-center gap-2">
        <StatusBadge tone={app.sync === "Synced" ? "success" : "warning"}>{app.sync}</StatusBadge>
        <StatusBadge tone={app.health === "Healthy" ? "success" : "warning"}>{app.health}</StatusBadge>
      </span>
      <ExternalLink
        link={{ label: "Open in Argo CD", url: `${argocdUrl}/applications/${encodeURIComponent(app.name)}` }}
        name={`Open ${app.name} in Argo CD`}
      />
    </li>
  );
}

// PCN-FR-16: a list behind a toggle that names its count, open by default when the tool is
// degraded. The browser keeps the admin's toggle.
function DetailRow({ label, open, children }: { label: string; open: boolean; children: ReactNode }) {
  return (
    <tr>
      <td className="px-4 pb-3" colSpan={4}>
        <details className="group rounded-md border border-border bg-background" open={open}>
          <summary className="flex cursor-pointer list-none items-center gap-1 px-3 py-2 font-medium text-sm">
            <ChevronDownIcon aria-hidden className="size-4 transition-transform group-open:rotate-180" />
            {label}
          </summary>
          <div className="flex flex-col gap-2 border-border border-t px-3 py-2">{children}</div>
        </details>
      </td>
    </tr>
  );
}

// name replaces the visible label for screen readers when the label alone is ambiguous, such as "Open".
function ExternalLink({ link, name }: { link: Link; name?: string }) {
  return (
    <a
      aria-label={`${name ?? link.label} (opens in a new tab)`}
      className="inline-flex items-center gap-1 rounded-sm font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      href={link.url}
      rel="noopener noreferrer"
      target="_blank"
    >
      {link.label}
      <ExternalLinkIcon aria-hidden className="size-3.5 shrink-0" />
    </a>
  );
}
