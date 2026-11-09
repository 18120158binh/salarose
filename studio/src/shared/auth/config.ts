import { isSystemRole, type SystemRole } from "./types";

const CALLBACK_PATH = "/api/auth/oidc/callback";
const DEFAULT_SCOPES = "openid email profile";
const DEFAULT_SESSION_MAX_AGE_SECONDS = 43200;
const MIN_SESSION_MAX_AGE_SECONDS = 300;
const MAX_SESSION_MAX_AGE_SECONDS = 604800;
const MIN_SESSION_SECRET_LENGTH = 32;

// The provider the unprefixed OIDC_* variables describe, when OIDC_PROVIDERS is not set.
const DEFAULT_PROVIDER_ID = "default";
const DEFAULT_PROVIDER_NAME = "SSO";
const PROVIDER_ID = /^[a-z][a-z0-9]*$/;
// The settings each provider has: OIDC_<NAME> for the default provider, OIDC_<ID>_<NAME> for
// each provider in OIDC_PROVIDERS.
const PROVIDER_SETTINGS = [
  "ISSUER",
  "CLIENT_ID",
  "CLIENT_SECRET",
  "NAME",
  "SCOPES",
  "ROLE_CLAIM",
  "ROLE_MAP",
  "LOGOUT_ID_TOKEN_HINT",
] as const;

export interface OidcProvider {
  // Names the provider in the login link, the transaction cookie, and the session cookie.
  id: string;
  // Shown on the login page as "Sign in with <name>".
  name: string;
  issuer: URL;
  clientId: string;
  clientSecret: string;
  scopes: string;
  // The ID token claim that carries the user's roles or groups at the provider, and the Studio
  // role each of its values gives.
  roleClaim: string;
  roleMap: ReadonlyMap<string, SystemRole>;
  // Logout sends the ID token from sign-in as id_token_hint. The token is kept in the database,
  // not in a cookie.
  logoutIdTokenHint: boolean;
}

export interface AuthConfig {
  // Keyed by id, in the order of OIDC_PROVIDERS.
  providers: ReadonlyMap<string, OidcProvider>;
  redirectUrl: URL;
  sessionKey: Uint8Array;
  sessionMaxAgeSeconds: number;
  // Cookies get the Secure flag when the app is served over https. TLS ends at the ingress,
  // so this comes from OIDC_REDIRECT_URL and not from the request.
  secureCookies: boolean;
}

type Env = Record<string, string | undefined>;

let cachedConfig: AuthConfig | null = null;

export function getAuthConfig(): AuthConfig {
  if (!cachedConfig) {
    cachedConfig = parseAuthConfig(process.env);
  }
  return cachedConfig;
}

// The provider with this id. Without an id, the only provider, if there is just one: a login
// link without ?provider=, or a sign-out without a session cookie, names none.
export function findProvider(config: AuthConfig, id: string | null): OidcProvider | null {
  if (id !== null) return config.providers.get(id) ?? null;
  if (config.providers.size !== 1) return null;
  const [only] = config.providers.values();
  return only;
}

export function getSessionKey(): Uint8Array {
  return parseSessionKey(process.env);
}

function parseAuthConfig(env: Env): AuthConfig {
  const isProduction = env.NODE_ENV === "production";

  const redirectUrl = requireUrl(env, "OIDC_REDIRECT_URL");
  if (redirectUrl.pathname !== CALLBACK_PATH) {
    throw new Error(`OIDC_REDIRECT_URL must have the path ${CALLBACK_PATH}.`);
  }

  return {
    providers: new Map(parseProviders(env, isProduction).map((provider) => [provider.id, provider])),
    redirectUrl,
    sessionKey: parseSessionKey(env),
    sessionMaxAgeSeconds: parseSessionMaxAge(env.SESSION_MAX_AGE_SECONDS),
    secureCookies: redirectUrl.protocol === "https:",
  };
}

// Without OIDC_PROVIDERS, one provider from the unprefixed OIDC_* variables. With it, one provider
// per id, each from its own OIDC_<ID>_* variables. Mixing the two forms is rejected, so a
// setting cannot silently apply to the wrong provider.
function parseProviders(env: Env, isProduction: boolean): OidcProvider[] {
  const list = env.OIDC_PROVIDERS?.trim();
  if (!list) {
    return [parseProvider(env, DEFAULT_PROVIDER_ID, "OIDC_", DEFAULT_PROVIDER_NAME, isProduction)];
  }

  for (const setting of PROVIDER_SETTINGS) {
    if (env[`OIDC_${setting}`]?.trim()) {
      throw new Error(`OIDC_${setting} applies only without OIDC_PROVIDERS. Use OIDC_<ID>_${setting}.`);
    }
  }
  const ids = list.split(",").map((id) => id.trim().toLowerCase());
  if (ids.some((id) => !PROVIDER_ID.test(id)) || new Set(ids).size !== ids.length) {
    throw new Error(
      "OIDC_PROVIDERS must be a comma-separated list of distinct ids of a letter followed by letters and digits.",
    );
  }
  return ids.map((id) => parseProvider(env, id, `OIDC_${id.toUpperCase()}_`, id, isProduction));
}

function parseProvider(
  env: Env,
  id: string,
  prefix: string,
  defaultName: string,
  isProduction: boolean,
): OidcProvider {
  const issuer = requireUrl(env, `${prefix}ISSUER`);
  if (isProduction && issuer.protocol !== "https:") {
    throw new Error(`${prefix}ISSUER must use https: in production.`);
  }

  const scopes = (env[`${prefix}SCOPES`]?.trim() || DEFAULT_SCOPES).split(/\s+/);
  if (!scopes.includes("openid") || !scopes.includes("email")) {
    throw new Error(`${prefix}SCOPES must include openid and email.`);
  }

  const roleClaim = requireValue(env, `${prefix}ROLE_CLAIM`);
  if (/\s/.test(roleClaim)) {
    throw new Error(`${prefix}ROLE_CLAIM must be one claim name without spaces.`);
  }

  return {
    id,
    name: env[`${prefix}NAME`]?.trim() || defaultName,
    issuer,
    clientId: requireValue(env, `${prefix}CLIENT_ID`),
    clientSecret: requireValue(env, `${prefix}CLIENT_SECRET`),
    scopes: scopes.join(" "),
    roleClaim,
    roleMap: parseRoleMap(env, `${prefix}ROLE_MAP`),
    logoutIdTokenHint: parseBoolean(env, `${prefix}LOGOUT_ID_TOKEN_HINT`, false),
  };
}

// A JSON object from claim values to Studio roles, such as {"studio-admins":"admin"}. JSON, so a
// claim value may hold any character, such as the commas and equals signs of an LDAP group DN.
function parseRoleMap(env: Env, name: string): ReadonlyMap<string, SystemRole> {
  const value = requireValue(env, name);
  const invalid = new Error(`${name} must be a JSON object that maps each claim value to admin or editor.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalid;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid;
  const entries = Object.entries(parsed);
  if (entries.length === 0) throw invalid;
  const roleMap = new Map<string, SystemRole>();
  for (const [value, role] of entries) {
    if (value === "" || typeof role !== "string" || !isSystemRole(role)) throw invalid;
    roleMap.set(value, role);
  }
  return roleMap;
}

function parseSessionKey(env: Env): Uint8Array {
  const secret = requireValue(env, "SESSION_SECRET");
  if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(`SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters.`);
  }
  return new TextEncoder().encode(secret);
}

function parseSessionMaxAge(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_SESSION_MAX_AGE_SECONDS;
  }
  const seconds = Number(value);
  if (
    !Number.isInteger(seconds) ||
    seconds < MIN_SESSION_MAX_AGE_SECONDS ||
    seconds > MAX_SESSION_MAX_AGE_SECONDS
  ) {
    throw new Error(
      `SESSION_MAX_AGE_SECONDS must be an integer from ${MIN_SESSION_MAX_AGE_SECONDS} to ${MAX_SESSION_MAX_AGE_SECONDS}.`,
    );
  }
  return seconds;
}

function parseBoolean(env: Env, name: string, defaultValue: boolean): boolean {
  const value = env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return defaultValue;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function requireValue(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not set. See studio/.env.example.`);
  }
  return value;
}

function requireUrl(env: Env, name: string): URL {
  const value = requireValue(env, name);
  if (!URL.canParse(value)) {
    throw new Error(`${name} must be an absolute URL.`);
  }
  return new URL(value);
}
