/** @jest-environment node */
import { NextRequest } from "next/server";
import type { ServerMetadata } from "openid-client";
import type { OidcProvider } from "@/shared/auth/config";
import { signSessionToken } from "@/shared/auth/sessionToken";

jest.mock("server-only", () => ({}));

// getSession reads the cookie through next/headers. The tests put a copy of the signed-out
// cookie there, as a second browser holding the same cookie would.
const mockCookieValues = new Map<string, string>();
jest.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = mockCookieValues.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

interface MockUser {
  id: string;
  email: string;
  role: string;
  session_epoch: number;
}

// An in-memory system_users. endSystemUserSessions raises the epoch unless a newer sign-out
// already did, the way the conditional UPDATE does. takeSystemUserIdToken removes and returns
// the ID token stored at sign-in, if it was stored at the cookie's epoch.
const mockUsers = new Map<string, MockUser>();
const mockIdTokens = new Map<string, { epoch: number; idToken: string }>();
jest.mock("@/lib/db", () => ({
  getAdminUserById: jest.fn(async (id: string) => mockUsers.get(id) ?? null),
  endSystemUserSessions: jest.fn(async (id: string, epoch: number) => {
    const user = mockUsers.get(id);
    if (user && user.session_epoch <= epoch) user.session_epoch += 1;
  }),
  takeSystemUserIdToken: jest.fn(async (id: string, epoch: number) => {
    const stored = mockIdTokens.get(id);
    if (!stored || stored.epoch !== epoch) return null;
    mockIdTokens.delete(id);
    return stored.idToken;
  }),
}));

// The provider's discovered metadata. Each test sets the metadata it needs. The factory builds
// the Configuration from the module registry the route uses, which a test may reset.
const mockGetOidcConfiguration = jest.fn<Promise<ServerMetadata>, [OidcProvider]>();
jest.mock("@/shared/auth/oidc", () => {
  const { Configuration } = jest.requireActual<typeof import("openid-client")>("openid-client");
  return {
    getOidcConfiguration: async (provider: OidcProvider) =>
      new Configuration(await mockGetOidcConfiguration(provider), provider.clientId, provider.clientSecret),
  };
});

import * as db from "@/lib/db";
import { getSession } from "@/shared/auth/session";
import { POST } from "../route";

const SECRET = "test-session-secret-0123456789-abcdef";
const PUBLIC_ORIGIN = "https://studio.example.com";

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
  process.env.OIDC_ISSUER = "https://idp.example.com";
  process.env.OIDC_CLIENT_ID = "studio";
  process.env.OIDC_CLIENT_SECRET = "client-secret";
  process.env.OIDC_ROLE_CLAIM = "roles";
  process.env.OIDC_ROLE_MAP = '{"studio-admin":"admin"}';
  process.env.OIDC_REDIRECT_URL = `${PUBLIC_ORIGIN}/api/auth/oidc/callback`;
});

function provider(metadata: Partial<ServerMetadata> = {}): ServerMetadata {
  return { issuer: "https://idp.example.com", end_session_endpoint: "https://idp.example.com/logout", ...metadata };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOidcConfiguration.mockResolvedValue(provider());
  mockCookieValues.clear();
  mockUsers.clear();
  mockIdTokens.clear();
  mockUsers.set("user_7", {
    id: "user_7",
    email: "lan.nguyen@example.com",
    role: "editor",
    session_epoch: 4,
  });
});

async function sessionCookie(epoch: number, providerId = "default"): Promise<string> {
  return signSessionToken(
    { userId: "user_7", email: "lan.nguyen@example.com", epoch, providerId },
    new TextEncoder().encode(SECRET),
    3600,
  );
}

function logoutRequest(token?: string): NextRequest {
  return new NextRequest("http://studio.internal:3001/api/auth/logout", {
    method: "POST",
    headers: token ? { cookie: `cdp_admin_session=${token}` } : {},
  });
}

function deletesSessionCookie(response: Response): boolean {
  return /^cdp_admin_session=; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT/.test(
    response.headers.get("set-cookie") ?? "",
  );
}

describe("POST /api/auth/logout", () => {
  it("ends every session of the user, so a copy of the cookie stops working", async () => {
    const token = await sessionCookie(4);
    mockCookieValues.set("cdp_admin_session", token);
    await expect(getSession()).resolves.toEqual({
      userId: "user_7",
      email: "lan.nguyen@example.com",
      role: "editor",
    });

    const response = await POST(logoutRequest(token));

    expect(response.status).toBe(303);
    expect(deletesSessionCookie(response)).toBe(true);
    await expect(getSession()).resolves.toBeNull();
  });

  it("without a session cookie, ends no session and still signs out", async () => {
    const response = await POST(logoutRequest());

    expect(response.status).toBe(303);
    expect(db.endSystemUserSessions).not.toHaveBeenCalled();
    expect(mockUsers.get("user_7")?.session_epoch).toBe(4);
  });

  it("still deletes the cookie when the database cannot end the sessions", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    jest.mocked(db.endSystemUserSessions).mockRejectedValueOnce(new Error("connection refused"));

    const response = await POST(logoutRequest(await sessionCookie(4)));

    expect(response.status).toBe(303);
    expect(deletesSessionCookie(response)).toBe(true);
    expect(consoleError).toHaveBeenCalledWith(
      "Could not end the user's sessions at sign-out:",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });
});

describe("POST /api/auth/logout and the provider session", () => {
  it("redirects to the provider's end-session endpoint, which returns the user to /login", async () => {
    const response = await POST(logoutRequest(await sessionCookie(4)));

    expect(response.status).toBe(303);
    expect(deletesSessionCookie(response)).toBe(true);
    const location = response.headers.get("location") ?? "";
    expect(location).toMatch(/^https:\/\/idp\.example\.com\/logout\?/);
    expect(Object.fromEntries(new URL(location).searchParams)).toEqual({
      post_logout_redirect_uri: `${PUBLIC_ORIGIN}/login`,
      logout_uri: `${PUBLIC_ORIGIN}/login`,
      client_id: "studio",
    });
  });

  it("returns to /login through Cognito's logout endpoint, which reads only logout_uri", async () => {
    const cognito = "https://studio-auth.auth.us-east-1.amazoncognito.com/logout";
    mockGetOidcConfiguration.mockResolvedValue(provider({ end_session_endpoint: cognito }));

    const response = await POST(logoutRequest(await sessionCookie(4)));

    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(cognito);
    expect(location.searchParams.get("logout_uri")).toBe(`${PUBLIC_ORIGIN}/login`);
    expect(location.searchParams.get("client_id")).toBe("studio");
  });

  it("signs out locally when the provider has no end_session_endpoint", async () => {
    mockGetOidcConfiguration.mockResolvedValue(provider({ end_session_endpoint: undefined }));

    const response = await POST(logoutRequest(await sessionCookie(4)));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
    expect(deletesSessionCookie(response)).toBe(true);
  });

  it("signs out locally when the provider cannot be reached", async () => {
    const consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockGetOidcConfiguration.mockRejectedValue(new Error("getaddrinfo ENOTFOUND idp.example.com"));

    const response = await POST(logoutRequest(await sessionCookie(4)));

    expect(response.headers.get("location")).toBe("/login");
    expect(deletesSessionCookie(response)).toBe(true);
    consoleWarn.mockRestore();
  });

  it("signs out locally without the OIDC configuration", async () => {
    const redirectUrl = process.env.OIDC_REDIRECT_URL;
    delete process.env.OIDC_REDIRECT_URL;
    try {
      // A fresh module registry, so no configuration is cached from the tests above.
      await jest.isolateModulesAsync(async () => {
        const { POST: unconfiguredPost } = await import("../route");

        const response = await unconfiguredPost(logoutRequest());

        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe("/login");
        expect(mockGetOidcConfiguration).not.toHaveBeenCalled();
      });
    } finally {
      process.env.OIDC_REDIRECT_URL = redirectUrl;
    }
  });
});

// Loads a fresh copy of the route, and of openid-client with it, with these environment changes,
// so no configuration is cached from other tests. An undefined value removes the variable.
async function postWithEnv(env: Record<string, string | undefined>, request: NextRequest): Promise<Response> {
  const saved = process.env;
  process.env = { ...saved };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    jest.resetModules();
    const { POST: freshPost } = await import("../route");
    return await freshPost(request);
  } finally {
    process.env = saved;
  }
}

describe("POST /api/auth/logout and id_token_hint", () => {
  const ID_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzdWItbGFuIn0.c2lnbmF0dXJl";

  it("sends the ID token stored at sign-in as id_token_hint when the provider opts in, and removes it", async () => {
    mockIdTokens.set("user_7", { epoch: 4, idToken: ID_TOKEN });

    const response = await postWithEnv({ OIDC_LOGOUT_ID_TOKEN_HINT: "true" }, logoutRequest(await sessionCookie(4)));

    expect(response.status).toBe(303);
    expect(deletesSessionCookie(response)).toBe(true);
    expect(Object.fromEntries(new URL(response.headers.get("location") ?? "").searchParams)).toEqual({
      id_token_hint: ID_TOKEN,
      post_logout_redirect_uri: `${PUBLIC_ORIGIN}/login`,
      logout_uri: `${PUBLIC_ORIGIN}/login`,
      client_id: "studio",
    });
    expect(mockIdTokens.has("user_7")).toBe(false);
    expect(mockUsers.get("user_7")?.session_epoch).toBe(5);
  });

  it("sends only client_id when no ID token was stored at the cookie's epoch", async () => {
    mockIdTokens.set("user_7", { epoch: 5, idToken: ID_TOKEN });

    const response = await postWithEnv({ OIDC_LOGOUT_ID_TOKEN_HINT: "true" }, logoutRequest(await sessionCookie(4)));

    expect(Object.fromEntries(new URL(response.headers.get("location") ?? "").searchParams)).toEqual({
      post_logout_redirect_uri: `${PUBLIC_ORIGIN}/login`,
      logout_uri: `${PUBLIC_ORIGIN}/login`,
      client_id: "studio",
    });
    expect(mockIdTokens.get("user_7")).toEqual({ epoch: 5, idToken: ID_TOKEN });
  });

  it("does not read a stored ID token when the provider has not opted in", async () => {
    mockIdTokens.set("user_7", { epoch: 4, idToken: ID_TOKEN });

    const response = await postWithEnv({}, logoutRequest(await sessionCookie(4)));

    expect(new URL(response.headers.get("location") ?? "").searchParams.has("id_token_hint")).toBe(false);
    expect(mockIdTokens.get("user_7")).toEqual({ epoch: 4, idToken: ID_TOKEN });
  });
});

describe("POST /api/auth/logout with several providers", () => {
  const TWO_PROVIDERS = {
    OIDC_ISSUER: undefined,
    OIDC_CLIENT_ID: undefined,
    OIDC_CLIENT_SECRET: undefined,
    OIDC_ROLE_CLAIM: undefined,
    OIDC_ROLE_MAP: undefined,
    OIDC_PROVIDERS: "keycloak,entra",
    OIDC_KEYCLOAK_ISSUER: "https://keycloak.example.com/realms/cdp",
    OIDC_KEYCLOAK_CLIENT_ID: "studio",
    OIDC_KEYCLOAK_CLIENT_SECRET: "keycloak-secret",
    OIDC_KEYCLOAK_ROLE_CLAIM: "roles",
    OIDC_KEYCLOAK_ROLE_MAP: '{"studio-admin":"admin"}',
    OIDC_ENTRA_ISSUER: "https://login.microsoftonline.com/tenant-1/v2.0",
    OIDC_ENTRA_CLIENT_ID: "entra-client",
    OIDC_ENTRA_CLIENT_SECRET: "entra-secret",
    OIDC_ENTRA_ROLE_CLAIM: "roles",
    OIDC_ENTRA_ROLE_MAP: '{"studio-admin":"admin"}',
  };

  beforeEach(() => {
    mockGetOidcConfiguration.mockImplementation(async (provider) => ({
      issuer: provider.issuer.href,
      end_session_endpoint: `${provider.issuer.origin}/logout`,
    }));
  });

  it("signs out at the provider the session signed in with", async () => {
    const response = await postWithEnv(TWO_PROVIDERS, logoutRequest(await sessionCookie(4, "entra")));

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://login.microsoftonline.com/logout");
    expect(location.searchParams.get("client_id")).toBe("entra-client");
    expect(deletesSessionCookie(response)).toBe(true);
  });

  it("signs out locally when the session's provider is no longer configured", async () => {
    const response = await postWithEnv(TWO_PROVIDERS, logoutRequest(await sessionCookie(4, "google")));

    expect(response.headers.get("location")).toBe("/login");
    expect(deletesSessionCookie(response)).toBe(true);
    expect(mockUsers.get("user_7")?.session_epoch).toBe(5);
  });
});
