/** @jest-environment node */
import type { ReactElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import type { SqlQuery, SystemUser } from "@/lib/db";
import { SESSION_COOKIE } from "@/shared/auth/constants";
import { signSessionToken } from "@/shared/auth/sessionToken";

jest.mock("server-only", () => ({}));

const mockCookieValues = new Map<string, string>();
jest.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = mockCookieValues.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

jest.mock("next/navigation", () => ({
  redirect: jest.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
  notFound: jest.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

type Rows = Record<string, unknown>[];
const mockSessionUser: { current: unknown } = { current: undefined };
const mockStaff: { current: Rows | Error } = { current: [] };
const mockReads: SqlQuery[] = [];
const mockPreview: { current: boolean } = { current: true };

jest.mock("@/lib/db", () => ({
  getAdminUserById: async () => mockSessionUser.current,
  getSystemUserPreview: async () => mockPreview.current,
  readOnly: async (_timeoutMs: number, work: (run: (query: SqlQuery) => Promise<Rows>) => unknown) =>
    work(async (query) => {
      mockReads.push(query);
      if (mockStaff.current instanceof Error) throw mockStaff.current;
      return mockStaff.current;
    }),
}));

const SECRET = "test-session-secret-0123456789-abcdef";

// Every value the page must never print (SHL-FR-20).
const SECRETS = {
  SESSION_SECRET: SECRET,
  OIDC_KEYCLOAK_CLIENT_ID: "kc-client-id-4f1c",
  OIDC_KEYCLOAK_CLIENT_SECRET: "kc-client-secret-9a2b",
  OIDC_ENTRA_CLIENT_ID: "entra-client-id-77de",
  OIDC_ENTRA_CLIENT_SECRET: "entra-client-secret-31f0",
  OPENAI_API_KEY: "sk-test-openai-key-5e6f",
};

const AI = { OPENAI_API_BASE: "https://llm.example.com/v1", LLM_MODEL: "gpt-test" };

async function signIn(role: "admin" | "editor"): Promise<void> {
  const user = { id: `user-${role}`, email: `${role}@example.com`, role, session_epoch: 0 } as SystemUser & { session_epoch: number };
  mockSessionUser.current = user;
  const token = await signSessionToken(
    { userId: user.id, email: user.email, epoch: 0, providerId: "keycloak" },
    new TextEncoder().encode(SECRET),
    3600,
  );
  mockCookieValues.set(SESSION_COOKIE, token);
}

async function renderSettings(): Promise<{ html: string; errors: unknown[] }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded after the mocks
  const page: () => Promise<ReactElement> = require("@/app/v2/settings/page").default;
  const errors: unknown[] = [];
  const stream = await renderToReadableStream(await page(), { onError: (error) => void errors.push(error) });
  await stream.allReady;
  return { html: await new Response(stream).text(), errors };
}

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function row(markup: string, label: string): string {
  const match = markup.match(new RegExp(String.raw`<dt[^>]*>${label}</dt><dd[^>]*>([\s\S]*?)</dd>`));
  return match ? text(match[1]) : "";
}

beforeAll(() => {
  Object.assign(process.env, SECRETS, {
    STUDIO_WORKSPACE_NAME: "Acme Retail",
    OIDC_REDIRECT_URL: "https://studio.example.com/api/auth/oidc/callback",
    OIDC_PROVIDERS: "keycloak,entra",
    OIDC_KEYCLOAK_ISSUER: "https://id.example.com/realms/staff",
    OIDC_KEYCLOAK_NAME: "Keycloak",
    OIDC_KEYCLOAK_ROLE_CLAIM: "roles",
    OIDC_KEYCLOAK_ROLE_MAP: '{"studio-admin":"admin"}',
    OIDC_ENTRA_ISSUER: "https://login.example.com/tenant/v2.0",
    OIDC_ENTRA_NAME: "Microsoft Entra",
    OIDC_ENTRA_ROLE_CLAIM: "roles",
    OIDC_ENTRA_ROLE_MAP: '{"Studio.Editor":"editor"}',
  });
});

beforeEach(() => {
  mockCookieValues.clear();
  mockReads.length = 0;
  mockStaff.current = [];
  mockPreview.current = true;
  Object.assign(process.env, AI);
  delete process.env.AI_GENERATION_LIMIT_PER_MINUTE;
  delete process.env.AI_GENERATION_LIMIT_PER_DAY;
});

describe("/v2/settings (SHL-FR-20)", () => {
  it("gives an editor without preview access the not-found page while Settings is at preview (SHL-FR-22)", async () => {
    await signIn("editor");
    mockPreview.current = false;

    await expect(renderSettings()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockReads).toEqual([]);
  });

  it("sends a visitor without a session to sign in and reads nothing (SHL-FR-02)", async () => {
    mockSessionUser.current = undefined;

    await expect(renderSettings()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(mockReads).toEqual([]);
  });

  it("shows an editor with preview access the forbidden state and reads nothing (SHL-FR-03)", async () => {
    await signIn("editor");

    const { html } = await renderSettings();

    expect(html).toContain("This page is for admins.");
    expect(html).not.toContain("Acme Retail");
    expect(html).not.toContain("Keycloak");
    expect(mockReads).toEqual([]);
  });

  it("shows an admin the workspace configuration, each value set by the deployment", async () => {
    await signIn("admin");

    const { html, errors } = await renderSettings();

    expect(errors).toEqual([]);
    expect(row(html, "Workspace name")).toBe("Acme Retail Set by the deployment");
    expect(row(html, "Sign-in providers")).toBe("Keycloak, Microsoft Entra Set by the deployment");
    expect(row(html, "Session length")).toBe("12 h Set by the deployment");
    expect(row(html, "AI generation")).toBe("Configured Set by the deployment");
    expect(row(html, "AI generation limits")).toBe("10 per minute and 100 per day, for each user Set by the deployment");
    expect(html.match(/Set by the deployment/g)).toHaveLength(7);
  });

  it("holds no client secret, client id, session secret, or API key in its HTML", async () => {
    await signIn("admin");

    const { html } = await renderSettings();

    for (const value of Object.values(SECRETS)) expect(html).not.toContain(value);
  });

  it("lists every staff user whose preview flag is true, by email and role", async () => {
    await signIn("admin");
    mockStaff.current = [
      { email: "Lan@Example.com", role: "editor" },
      { email: "minh@example.com", role: "admin" },
    ];

    const { html } = await renderSettings();

    const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((match) => text(match[1]));
    expect(rows).toEqual(["Email Role", "lan@example.com Editor", "minh@example.com Admin"]);
    expect(mockReads).toEqual([{ text: expect.stringMatching(/FROM system_users WHERE preview\b/), values: [] }]);
  });

  it("says so when no staff user has the preview flag", async () => {
    await signIn("admin");

    const { html } = await renderSettings();

    expect(html).toContain("No staff member has the preview flag.");
  });

  it("says AI generation is not configured when a model setting is missing", async () => {
    await signIn("admin");
    delete process.env.LLM_MODEL;

    const { html } = await renderSettings();

    expect(row(html, "AI generation")).toBe("Not configured Set by the deployment");
  });

  it("says the limits are not available when one is invalid", async () => {
    await signIn("admin");
    process.env.AI_GENERATION_LIMIT_PER_DAY = "lots";

    const { html } = await renderSettings();

    expect(row(html, "AI generation limits")).toMatch(/^Not available\./);
  });

  it("keeps the workspace section when the preview list cannot load", async () => {
    await signIn("admin");
    mockStaff.current = new Error("column preview does not exist");

    const { html, errors } = await renderSettings();

    expect(row(html, "Workspace name")).toBe("Acme Retail Set by the deployment");
    expect(errors).toEqual([new Error("column preview does not exist")]);
  });

  it("sends a visitor whose session is gone to sign in and reads nothing", async () => {
    mockSessionUser.current = undefined;

    await expect(renderSettings()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(mockReads).toEqual([]);
  });

  it("shows the Data import defaults and the read-only note for the preview list (SHL-FR-20)", async () => {
    await signIn("admin");

    const { html } = await renderSettings();

    expect(html).toContain("Default phone country");
    expect(html).toContain("Vietnam (+84)");
    expect(html).toContain("Reporting time zone");
    expect(html).toContain("Read only. Studio has no screen to grant access.");
  });
});
