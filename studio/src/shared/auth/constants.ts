export const SESSION_COOKIE = "cdp_admin_session";
export const OIDC_TX_COOKIE = "cdp_admin_oidc_tx";
export const OIDC_TX_COOKIE_PATH = "/api/auth/oidc";
export const OIDC_TX_MAX_AGE_SECONDS = 600;

// Paths the proxy lets through without a session. The data ingestion routes check a source
// key instead; list each one, so a new /v1/ route needs a session until it is added here.
export const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/login",
  "/api/auth/oidc/login",
  "/api/auth/oidc/callback",
  "/api/auth/logout",
  "/v1/business-events",
  "/v1/events",
  "/v1/imports",
]);

// The source-key routes whose path holds an id, matched whole. Each route checks the key itself.
const PUBLIC_PATH_PATTERNS: readonly RegExp[] = [
  /^\/v1\/imports\/[^/]+$/,
  /^\/v1\/imports\/[^/]+\/complete$/,
  /^\/v1\/records\/[^/]+$/,
];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname) || PUBLIC_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
}
