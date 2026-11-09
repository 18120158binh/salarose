/** @jest-environment node */
import { NextRequest } from "next/server";
import type { OidcProvider } from "@/shared/auth/config";
import { verifyOidcTransaction } from "@/shared/auth/sessionToken";

jest.mock("server-only", () => ({}));

// Each provider's discovered configuration, with an authorization endpoint on its own origin. The
// factory builds it from the module registry the route uses, which is an isolated one.
jest.mock("@/shared/auth/oidc", () => {
  const { Configuration } = jest.requireActual<typeof import("openid-client")>("openid-client");
  return {
    getOidcConfiguration: async (provider: OidcProvider) =>
      new Configuration(
        { issuer: provider.issuer.href, authorization_endpoint: `${provider.issuer.origin}/authorize` },
        provider.clientId,
        provider.clientSecret,
      ),
  };
});

const SECRET = "test-session-secret-0123456789-abcdef";
const PUBLIC_ORIGIN = "https://studio.example.com";
const SINGLE_PROVIDER = {
  OIDC_ISSUER: "https://idp.example.com",
  OIDC_CLIENT_ID: "studio",
  OIDC_CLIENT_SECRET: "client-secret",
  OIDC_ROLE_CLAIM: "roles",
  OIDC_ROLE_MAP: '{"studio-admin":"admin"}',
};
const TWO_PROVIDERS = {
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

const ORIGINAL_ENV = process.env;

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

// Calls a fresh copy of the route, so each test reads its own configuration.
async function getLogin(env: Record<string, string>, query: string): Promise<Response> {
  process.env = {
    ...ORIGINAL_ENV,
    SESSION_SECRET: SECRET,
    OIDC_REDIRECT_URL: `${PUBLIC_ORIGIN}/api/auth/oidc/callback`,
    ...env,
  };
  let response: Response | undefined;
  await jest.isolateModulesAsync(async () => {
    const { GET } = await import("../route");
    response = await GET(new NextRequest(`http://studio.internal:3001/api/auth/oidc/login${query}`));
  });
  if (!response) throw new Error("the route returned no response");
  return response;
}

async function transactionOf(response: Response) {
  const token = /cdp_admin_oidc_tx=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  return verifyOidcTransaction(token, new TextEncoder().encode(SECRET));
}

describe("GET /api/auth/oidc/login", () => {
  it("starts the sign-in at the chosen provider and keeps the provider in the transaction", async () => {
    const response = await getLogin(TWO_PROVIDERS, "?provider=entra&returnTo=%2Fcampaign%2Fabc");

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://login.microsoftonline.com/authorize");
    expect(location.searchParams.get("client_id")).toBe("entra-client");
    await expect(transactionOf(response)).resolves.toMatchObject({
      providerId: "entra",
      returnTo: "/campaign/abc",
      state: location.searchParams.get("state"),
    });
  });

  it.each([["no provider", "?returnTo=%2Fcampaign%2Fabc"], ["an unknown provider", "?provider=google&returnTo=%2Fcampaign%2Fabc"]])(
    "with several providers and %s, sends the user back to /login to choose one",
    async (_, query) => {
      const response = await getLogin(TWO_PROVIDERS, query);

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/login?returnTo=%2Fcampaign%2Fabc`);
      expect(response.headers.get("set-cookie")).toBeNull();
    },
  );

  it("with one provider and no provider parameter, starts the sign-in at that provider", async () => {
    const response = await getLogin(SINGLE_PROVIDER, "");

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://idp.example.com/authorize");
    await expect(transactionOf(response)).resolves.toMatchObject({ providerId: "default", returnTo: "/campaign" });
  });
});
