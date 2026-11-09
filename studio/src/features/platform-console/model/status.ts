import type { HealthStatus } from "./health";

// One tool's place in the platform status. A tool whose check still runs is "checking".
export interface ToolResult {
  id: string;
  name: string;
  status: HealthStatus | "checking";
  reason: string;
}

export type StatusKind = "attention" | "ok" | "checking" | "none";

export interface PlatformStatus {
  kind: StatusKind;
  word: "NEEDS ATTENTION" | "OK" | "CHECKING" | "NOTHING TO CHECK";
  title: string;
  line: string;
  // Each tool that is down, degraded, or unknown, for the banner to list and link (PCN-FR-12).
  listed: ToolResult[];
}

// PCN-FR-12: the first row of the platform status table that applies.
export function platformStatus(results: readonly ToolResult[]): PlatformStatus {
  const total = results.length;
  const up = results.filter((tool) => tool.status === "up");
  const bad = results.filter((tool) => tool.status === "down" || tool.status === "degraded");
  const listed = results.filter((tool) => tool.status === "down" || tool.status === "degraded" || tool.status === "unknown");
  const checking = results.filter((tool) => tool.status === "checking").length;

  if (total === 0) {
    return { kind: "none", word: "NOTHING TO CHECK", title: "No tools to check", line: "This deployment lists no tools yet, so there is no health to show.", listed: [] };
  }
  if (checking > 0) {
    return {
      kind: "checking",
      word: "CHECKING",
      title: `Checking ${checking} of ${total} tools…`,
      line: `${tools(up.length)} up so far. Each result shows as its check finishes; you can use the page meanwhile.`,
      listed,
    };
  }
  if (bad.length > 0) {
    return {
      kind: "attention",
      word: "NEEDS ATTENTION",
      title: bad.length === 1 ? `1 tool needs attention: ${bad[0].name} · ${bad[0].reason}` : `${bad.length} tools need attention`,
      line: `${up.length} of ${total} tools are up. Open a tool to fix it; this page cannot change it.`,
      listed,
    };
  }
  return {
    kind: "ok",
    word: "OK",
    title: "All tools are up",
    line: listed.length === 0 ? `${names(results.map((tool) => tool.name))} all passed their checks.` : `${up.length} of ${total} tools are up.`,
    listed,
  };
}

function tools(n: number): string {
  return n === 1 ? "1 tool is" : `${n} tools are`;
}

function names(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

// The age of the oldest check shown, such as "Checked 20 s ago" (PCN-FR-12).
export function checkedText(checkedAt: readonly (number | null)[], now: number): string {
  const times = checkedAt.filter((time): time is number => time !== null);
  if (times.length === 0) return "Not checked";
  const seconds = Math.max(0, Math.round((now - Math.min(...times)) / 1000));
  return seconds < 60 ? `Checked ${seconds} s ago` : `Checked ${Math.floor(seconds / 60)} min ago`;
}
