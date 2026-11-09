import { TZ_COOKIE } from "@/shared/lib/time-range";

// The cookie the shared sidebar writes when it opens or collapses.
export const SIDEBAR_COOKIE = "sidebar_state";

const DEFAULT_WORKSPACE_NAME = "Studio";

// The server reads the viewer's zone from this cookie (SHL-FR-15).
export function tzCookie(zone: string): string {
  return `${TZ_COOKIE}=${zone}; path=/; max-age=31536000; SameSite=Lax`;
}

// Open unless the viewer collapsed it.
export function parseSidebarOpen(value: string | undefined): boolean {
  return value !== "false";
}

export function workspaceName(configured: string | undefined): string {
  const name = configured?.trim();
  return name ? name : DEFAULT_WORKSPACE_NAME;
}

export function initials(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : local.slice(0, 2);
  return letters.toUpperCase() || "?";
}
