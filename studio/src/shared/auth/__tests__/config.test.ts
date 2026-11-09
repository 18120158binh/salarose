/** @jest-environment node */

// getAuthConfig reads process.env once and caches the result, so each test loads a fresh copy
// of the module.
async function loadConfig(extra: Record<string, string | undefined>) {
  process.env = {
    ...ORIGINAL_ENV,
    OIDC_ISSUER: "https://idp.example.com",
    OIDC_CLIENT_ID: "studio",
    OIDC_CLIENT_SECRET: "secret",
    OIDC_REDIRECT_URL: "https://studio.example.com/api/auth/oidc/callback",
    SESSION_SECRET: "a".repeat(32),
    OIDC_ROLE_CLAIM: "roles",
    OIDC_ROLE_MAP: '{"studio-admin":"admin"}',
    ...extra,
  };
  jest.resetModules();
  const { getAuthConfig } = await import("@/shared/auth/config");
  return getAuthConfig();
}

// The provider the unprefixed OIDC_* variables describe.
async function defaultProvider(extra: Record<string, string | undefined>) {
  return (await loadConfig(extra)).providers.get("default");
}

// Two providers in OIDC_PROVIDERS, each with its own prefixed variables.
const TWO_PROVIDERS = {
  OIDC_ISSUER: undefined,
  OIDC_CLIENT_ID: undefined,
  OIDC_CLIENT_SECRET: undefined,
  OIDC_ROLE_CLAIM: undefined,
  OIDC_ROLE_MAP: undefined,
  OIDC_PROVIDERS: " Keycloak, entra ",
  OIDC_KEYCLOAK_ISSUER: "https://keycloak.example.com/realms/cdp",
  OIDC_KEYCLOAK_CLIENT_ID: "studio",
  OIDC_KEYCLOAK_CLIENT_SECRET: "keycloak-secret",
  OIDC_KEYCLOAK_ROLE_CLAIM: "groups",
  OIDC_KEYCLOAK_ROLE_MAP: '{"/staff/admins":"admin"}',
  OIDC_ENTRA_ISSUER: "https://login.microsoftonline.com/tenant-1/v2.0",
  OIDC_ENTRA_CLIENT_ID: "entra-client",
  OIDC_ENTRA_CLIENT_SECRET: "entra-secret",
  OIDC_ENTRA_NAME: "Microsoft",
  OIDC_ENTRA_ROLE_CLAIM: "roles",
  OIDC_ENTRA_ROLE_MAP: '{"Studio.Admin":"admin","Studio.Editor":"editor"}',
  OIDC_ENTRA_LOGOUT_ID_TOKEN_HINT: "true",
};

const ORIGINAL_ENV = process.env;

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe("OIDC_LOGOUT_ID_TOKEN_HINT", () => {
  it("is off when unset", async () => {
    expect((await defaultProvider({}))?.logoutIdTokenHint).toBe(false);
  });

  it("reads true", async () => {
    expect((await defaultProvider({ OIDC_LOGOUT_ID_TOKEN_HINT: "TRUE" }))?.logoutIdTokenHint).toBe(true);
  });
});

describe("OIDC providers", () => {
  it("reads one provider named default from the unprefixed variables", async () => {
    expect([...(await loadConfig({})).providers.values()]).toEqual([
      {
        id: "default",
        name: "SSO",
        issuer: new URL("https://idp.example.com"),
        clientId: "studio",
        clientSecret: "secret",
        scopes: "openid email profile",
        roleClaim: "roles",
        roleMap: new Map([["studio-admin", "admin"]]),
        logoutIdTokenHint: false,
      },
    ]);
  });

  it("reads each provider in OIDC_PROVIDERS from its prefixed variables, in order", async () => {
    expect([...(await loadConfig(TWO_PROVIDERS)).providers.values()]).toEqual([
      {
        id: "keycloak",
        name: "keycloak",
        issuer: new URL("https://keycloak.example.com/realms/cdp"),
        clientId: "studio",
        clientSecret: "keycloak-secret",
        scopes: "openid email profile",
        roleClaim: "groups",
        roleMap: new Map([["/staff/admins", "admin"]]),
        logoutIdTokenHint: false,
      },
      {
        id: "entra",
        name: "Microsoft",
        issuer: new URL("https://login.microsoftonline.com/tenant-1/v2.0"),
        clientId: "entra-client",
        clientSecret: "entra-secret",
        scopes: "openid email profile",
        roleClaim: "roles",
        roleMap: new Map([
          ["Studio.Admin", "admin"],
          ["Studio.Editor", "editor"],
        ]),
        logoutIdTokenHint: true,
      },
    ]);
  });

  it("rejects an unprefixed provider setting next to OIDC_PROVIDERS", async () => {
    await expect(loadConfig({ ...TWO_PROVIDERS, OIDC_SCOPES: "openid email" })).rejects.toThrow(
      "OIDC_SCOPES applies only without OIDC_PROVIDERS. Use OIDC_<ID>_SCOPES.",
    );
  });

  it("rejects OIDC_ISSUER next to OIDC_PROVIDERS", async () => {
    await expect(
      loadConfig({ ...TWO_PROVIDERS, OIDC_ISSUER: "https://idp.example.com" }),
    ).rejects.toThrow("OIDC_ISSUER applies only without OIDC_PROVIDERS. Use OIDC_<ID>_ISSUER.");
  });

  it("names the missing variable of a listed provider", async () => {
    await expect(loadConfig({ ...TWO_PROVIDERS, OIDC_ENTRA_CLIENT_SECRET: undefined })).rejects.toThrow(
      "OIDC_ENTRA_CLIENT_SECRET is not set.",
    );
  });

  it.each([["my-idp"], ["9idp"], ["keycloak,keycloak"], [" , "]])("rejects OIDC_PROVIDERS=%j", async (value) => {
    await expect(loadConfig({ ...TWO_PROVIDERS, OIDC_PROVIDERS: value })).rejects.toThrow(
      "OIDC_PROVIDERS must be a comma-separated list of distinct ids of a letter followed by letters and digits.",
    );
  });
});

describe("OIDC_ROLE_CLAIM and OIDC_ROLE_MAP", () => {
  const ROLES = { OIDC_ROLE_CLAIM: " groups ", OIDC_ROLE_MAP: '{"studio-admins":"admin","/staff/editors":"editor"}' };

  it("reads the role claim, trimmed, and the map from claim values to roles", async () => {
    const provider = await defaultProvider(ROLES);

    expect(provider?.roleClaim).toBe("groups");
    expect(provider?.roleMap).toEqual(
      new Map([
        ["studio-admins", "admin"],
        ["/staff/editors", "editor"],
      ]),
    );
  });

  it.each([["OIDC_ROLE_CLAIM"], ["OIDC_ROLE_MAP"]])("names %s when it is not set", async (name) => {
    await expect(loadConfig({ ...ROLES, [name]: undefined })).rejects.toThrow(`${name} is not set.`);
  });

  it("rejects a role claim with a space", async () => {
    await expect(loadConfig({ ...ROLES, OIDC_ROLE_CLAIM: "realm roles" })).rejects.toThrow(
      "OIDC_ROLE_CLAIM must be one claim name without spaces.",
    );
  });

  it.each([
    ["not JSON", "studio-admins=admin"],
    ["a list", '["admin"]'],
    ["an empty object", "{}"],
    ["an empty claim value", '{"":"admin"}'],
    ["the role viewer", '{"studio-viewers":"viewer"}'],
    ["a role in another case", '{"studio-admins":"Admin"}'],
    ["a role that is not a string", '{"studio-admins":1}'],
  ])("rejects %s", async (_, value) => {
    await expect(loadConfig({ ...ROLES, OIDC_ROLE_MAP: value })).rejects.toThrow(
      "OIDC_ROLE_MAP must be a JSON object that maps each claim value to admin or editor.",
    );
  });

  it("reads each listed provider's own role settings, and rejects the unprefixed ones next to OIDC_PROVIDERS", async () => {
    const config = await loadConfig({
      ...TWO_PROVIDERS,
      OIDC_KEYCLOAK_ROLE_CLAIM: "roles",
      OIDC_KEYCLOAK_ROLE_MAP: '{"studio-admin":"admin"}',
      OIDC_ENTRA_ROLE_CLAIM: "roles",
      OIDC_ENTRA_ROLE_MAP: '{"Studio.Editor":"editor"}',
    });

    expect(config.providers.get("entra")?.roleMap).toEqual(new Map([["Studio.Editor", "editor"]]));
    await expect(loadConfig({ ...TWO_PROVIDERS, ...ROLES })).rejects.toThrow(
      "OIDC_ROLE_CLAIM applies only without OIDC_PROVIDERS. Use OIDC_<ID>_ROLE_CLAIM.",
    );
  });
});
