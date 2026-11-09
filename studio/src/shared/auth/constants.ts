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
]);
