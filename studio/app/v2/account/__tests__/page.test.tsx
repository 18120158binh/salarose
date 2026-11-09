/** @jest-environment node */
import type { ReactElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import type { SqlQuery, SystemUser } from "@/lib/db";
import { SESSION_COOKIE } from "@/shared/auth/constants";
import { signSessionToken } from "@/shared/auth/sessionToken";
import { formatDateTime } from "@/shared/lib/format";
import { parseTimeZone } from "@/shared/lib/time-range";

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
const mockPreview: { current: boolean } = { current: true };
const mockReads: SqlQuery[] = [];

jest.mock("@/lib/db", () => ({
  getAdminUserById: async () => mockSessionUser.current,
  getSystemUserPreview: async () => mockPreview.current,
  readOnly: async (_timeoutMs: number, work: (run: (query: SqlQuery) => Promise<Rows>) => unknown) =>
    work(async (query) => {
      mockReads.push(query);
      return [];
    }),
}));

const SECRET = "test-session-secret-0123456789-abcdef";
const SESSION_SECONDS = 3600;
const ZONE = "America/New_York";

let expiresAt = 0;

async function signIn(role: "admin" | "editor", providerId = "keycloak"): Promise<void> {
  const user = { id: `user-${role}`, email: `${role}@example.com`, role, session_epoch: 0 } as SystemUser & { session_epoch: number };
  mockSessionUser.current = user;
  const now = new Date();
  expiresAt = (Math.floor(now.getTime() / 1000) + SESSION_SECONDS) * 1000;
  const token = await signSessionToken(
    { userId: user.id, email: user.email, epoch: 0, providerId },
    new TextEncoder().encode(SECRET),
    SESSION_SECONDS,
    now,
  );
  mockCookieValues.set(SESSION_COOKIE, token);
}

async function renderAccount(): Promise<{ html: string; errors: unknown[] }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded after the mocks
  const page: () => Promise<ReactElement> = require("@/app/v2/account/page").default;
  const errors: unknown[] = [];
  const stream = await renderToReadableStream(await page(), { onError: (error) => void errors.push(error) });
  await stream.allReady;
  return { html: await new Response(stream).text(), errors };
}

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
// The value and note of the row with this label, as text.
function row(markup: string, label: string): string {
  const match = markup.match(new RegExp(String.raw`<dt[^>]*>${label}</dt><dd[^>]*>([\s\S]*?)</dd>`));
  return match ? `${text(match[1]).trim()} ` : "";
}

beforeAll(() => {
  Object.assign(process.env, {
    SESSION_SECRET: SECRET,
    OIDC_REDIRECT_URL: "https://studio.example.com/api/auth/oidc/callback",
    OIDC_PROVIDERS: "keycloak",
    OIDC_KEYCLOAK_ISSUER: "https://id.example.com/realms/staff",
    OIDC_KEYCLOAK_CLIENT_ID: "studio-client",
    OIDC_KEYCLOAK_CLIENT_SECRET: "keycloak-client-secret-value",
    OIDC_KEYCLOAK_NAME: "Keycloak",
    OIDC_KEYCLOAK_ROLE_CLAIM: "roles",
    OIDC_KEYCLOAK_ROLE_MAP: '{"studio-editor":"editor","studio-admin":"admin"}',
  });
});

beforeEach(() => {
  mockCookieValues.clear();
  mockReads.length = 0;
  mockPreview.current = true;
});

describe("/v2/account (SHL-FR-19)", () => {
  it("shows an editor with preview access her sign-in details, her time zone, and Sign out, with no theme switch", async () => {
    await signIn("editor");
    mockCookieValues.set("tz", ZONE);
    mockCookieValues.set("theme", "dark");
    mockPreview.current = true;

    const { html, errors } = await renderAccount();

    expect(errors).toEqual([]);
    expect(row(html, "Email")).toMatch(/^editor@example\.com /);
    expect(row(html, "Role")).toMatch(/^Editor /);
    expect(row(html, "Signed in with")).toMatch(/^Keycloak /);
    expect(row(html, "Session expires")).toMatch(new RegExp(`^${formatDateTime(expiresAt, parseTimeZone(ZONE))} `));
    expect(row(html, "Preview access")).toMatch(/^On /);
    expect(row(html, "Time zone")).toMatch(new RegExp(`^${ZONE} `));
    expect(html).not.toMatch(/>(Theme|Light|Dark)</);
    expect(html).toMatch(/<form [^>]*action="\/api\/auth\/logout"[^>]*method="post">[\s\S]*Sign out[\s\S]*<\/form>/);
    expect(text(html)).toContain("Ends every Studio session you have open.");
  });

  it("heads the page with the viewer's initials, the email in place of a name, the role and the workspace", async () => {
    await signIn("editor");
    process.env.STUDIO_WORKSPACE_NAME = "Mộc Lan Shop";

    const { html } = await renderAccount();
    delete process.env.STUDIO_WORKSPACE_NAME;

    const profile = text(html.match(/<section aria-label="Your profile"[\s\S]*?<\/section>/)?.[0] ?? "");
    expect(profile).toMatch(/ED editor@example\.com Editor Mộc Lan Shop /);
  });

  it("offers no field to edit the email, the role, or a password", async () => {
    await signIn("editor");

    const { html } = await renderAccount();

    expect(html).not.toMatch(/<(input|textarea|select)\b/);
  });

  it("gives an editor without preview access the not-found page while Account is at preview (SHL-FR-22)", async () => {
    await signIn("editor");
    mockPreview.current = false;

    await expect(renderAccount()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("shows preview access on for an admin, whatever the flag", async () => {
    await signIn("admin");
    mockPreview.current = false;

    const { html } = await renderAccount();

    expect(row(html, "Role")).toMatch(/^Admin /);
    expect(row(html, "Preview access")).toMatch(/^On /);
    expect(mockReads).toEqual([]);
  });

  it("shows the provider's id when the configuration no longer has the provider", async () => {
    await signIn("editor", "okta");

    const { html } = await renderAccount();

    expect(row(html, "Signed in with")).toMatch(/^okta /);
  });

  it("shows times in UTC when the browser sent no time zone", async () => {
    await signIn("editor");

    const { html } = await renderAccount();

    expect(row(html, "Time zone")).toMatch(/^UTC /);
  });

  it("sends a visitor whose session is gone to sign in and reads nothing", async () => {
    mockSessionUser.current = undefined;

    await expect(renderAccount()).rejects.toThrow("NEXT_REDIRECT /login");
    expect(mockReads).toEqual([]);
  });
});
