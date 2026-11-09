/** @jest-environment node */
import { NextRequest } from "next/server";
import type { IDToken } from "openid-client";
import type { OidcProvider } from "@/shared/auth/config";
import { signOidcTransaction, verifySessionToken } from "@/shared/auth/sessionToken";

jest.mock("server-only", () => ({}));

// The code exchange returns these claims and this raw ID token.
let mockClaims: IDToken;
const ID_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJzdWItbGFuIn0.c2lnbmF0dXJl";
jest.mock("openid-client", () => ({
  ...jest.requireActual("openid-client"),
  authorizationCodeGrant: jest.fn(async () => ({ id_token: ID_TOKEN, claims: () => mockClaims })),
}));

// Records which provider the route discovered. The factory builds the Configuration from the
// module registry the route uses, which is an isolated one.
const mockDiscoveredProviders: string[] = [];
jest.mock("@/shared/auth/oidc", () => {
  const { Configuration } = jest.requireActual<typeof import("openid-client")>("openid-client");
  return {
    getOidcConfiguration: async (provider: OidcProvider) => {
      mockDiscoveredProviders.push(provider.id);
      return new Configuration({ issuer: provider.issuer.href }, provider.clientId, provider.clientSecret);
    },
  };
});

// The sign-in writes Lan's row, at session epoch 2.
jest.mock("@/lib/db", () => ({
  upsertSystemUserFromSignIn: jest.fn(async (account: { email: string; role: string }) => ({
    id: "user_7",
    email: account.email,
    role: account.role,
    session_epoch: 2,
  })),
  saveSystemUserIdToken: jest.fn(async () => {}),
}));

import * as db from "@/lib/db";

const SECRET = "test-session-secret-0123456789-abcdef";
const KEY = new TextEncoder().encode(SECRET);
const PUBLIC_ORIGIN = "https://studio.example.com";
const ENTRA_ISSUER = "https://login.microsoftonline.com/tenant-1/v2.0";
const TWO_PROVIDERS = {
  OIDC_PROVIDERS: "keycloak,entra",
  OIDC_KEYCLOAK_ISSUER: "https://keycloak.example.com/realms/cdp",
  OIDC_KEYCLOAK_CLIENT_ID: "studio",
  OIDC_KEYCLOAK_CLIENT_SECRET: "keycloak-secret",
  OIDC_KEYCLOAK_ROLE_CLAIM: "groups",
  OIDC_KEYCLOAK_ROLE_MAP: '{"/staff/editors":"editor"}',
  OIDC_ENTRA_ISSUER: ENTRA_ISSUER,
  OIDC_ENTRA_CLIENT_ID: "entra-client",
  OIDC_ENTRA_CLIENT_SECRET: "entra-secret",
  OIDC_ENTRA_ROLE_CLAIM: "roles",
  OIDC_ENTRA_ROLE_MAP: '{"Studio.Admin":"admin"}',
  OIDC_ENTRA_LOGOUT_ID_TOKEN_HINT: "true",
};

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  mockDiscoveredProviders.length = 0;
  mockClaims = {
    iss: ENTRA_ISSUER,
    sub: "sub-lan",
    aud: "entra-client",
    iat: 0,
    exp: 0,
    email: "Lan.Nguyen@example.com",
    roles: ["Studio.Admin"],
  };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

// Calls a fresh copy of the route with a transaction cookie for this provider.
async function callback(env: Record<string, string>, providerId: string): Promise<Response> {
  process.env = {
    ...ORIGINAL_ENV,
    SESSION_SECRET: SECRET,
    OIDC_REDIRECT_URL: `${PUBLIC_ORIGIN}/api/auth/oidc/callback`,
    ...env,
  };
  const tx = await signOidcTransaction(
    { state: "state-abc", nonce: "nonce-def", codeVerifier: "verifier-ghi", returnTo: "/campaign/abc", providerId },
    KEY,
  );
  let response: Response | undefined;
  await jest.isolateModulesAsync(async () => {
    const { GET } = await import("../route");
    response = await GET(
      new NextRequest("http://studio.internal:3001/api/auth/oidc/callback?code=c&state=state-abc", {
        headers: { cookie: `cdp_admin_oidc_tx=${tx}` },
      }),
    );
  });
  if (!response) throw new Error("the route returned no response");
  return response;
}

async function sessionOf(response: Response) {
  const token = /cdp_admin_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  return verifySessionToken(token, KEY);
}

describe("GET /api/auth/oidc/callback with several providers", () => {
  it("signs in through the transaction's provider, with its role mapping, and records it in the session", async () => {
    const response = await callback(TWO_PROVIDERS, "entra");

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/campaign/abc`);
    expect(mockDiscoveredProviders).toEqual(["entra"]);
    await expect(sessionOf(response)).resolves.toEqual({
      userId: "user_7",
      email: "lan.nguyen@example.com",
      epoch: 2,
      providerId: "entra",
    });
    expect(db.upsertSystemUserFromSignIn).toHaveBeenCalledWith({
      issuer: ENTRA_ISSUER,
      subject: "sub-lan",
      email: "lan.nguyen@example.com",
      role: "admin",
    });
  });

  it("stores the ID token at the session epoch for a provider that sends id_token_hint at sign-out", async () => {
    await callback(TWO_PROVIDERS, "entra");

    expect(db.saveSystemUserIdToken).toHaveBeenCalledWith("user_7", 2, ID_TOKEN);
  });

  it("does not store the ID token for a provider that has not opted in", async () => {
    mockClaims = { ...mockClaims, iss: "https://keycloak.example.com/realms/cdp", groups: ["/staff/editors"] };

    const response = await callback(TWO_PROVIDERS, "keycloak");

    await expect(sessionOf(response)).resolves.toMatchObject({ userId: "user_7", providerId: "keycloak" });
    expect(db.saveSystemUserIdToken).not.toHaveBeenCalled();
  });

  it("still signs in when the ID token cannot be stored", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    jest.mocked(db.saveSystemUserIdToken).mockRejectedValueOnce(new Error("connection refused"));

    const response = await callback(TWO_PROVIDERS, "entra");

    expect(response.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/campaign/abc`);
    await expect(sessionOf(response)).resolves.toMatchObject({ userId: "user_7", providerId: "entra" });
    expect(consoleError).toHaveBeenCalledWith(
      "Could not store the ID token for the provider sign-out:",
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("returns transaction_expired for a transaction whose provider is no longer configured", async () => {
    const consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => {});

    const response = await callback(TWO_PROVIDERS, "google");

    expect(response.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/login?error=transaction_expired`);
    expect(mockDiscoveredProviders).toEqual([]);
    consoleWarn.mockRestore();
  });
});
