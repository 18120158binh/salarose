/** @jest-environment node */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

jest.mock("server-only", () => ({}));
jest.mock("next/navigation", () => ({
  redirect: jest.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));
jest.mock("next/font/google", () => ({
  IBM_Plex_Sans: () => ({ style: { fontFamily: "Plex" } }),
  Space_Grotesk: () => ({ style: { fontFamily: "Grotesk" } }),
}));
jest.mock("@/shared/auth/session", () => ({ getSession: jest.fn() }));
jest.mock("@/shared/auth/config", () => ({ getAuthConfig: jest.fn() }));

import { getAuthConfig, type AuthConfig } from "@/shared/auth/config";
import { getSession } from "@/shared/auth/session";
import LoginPage, { metadata } from "../page";

// The error table, read from the contract itself, so a message that drifts from it fails here (AUTH-FR-04).
function contractMessages(): [string, string][] {
  const contract = readFileSync(join(__dirname, "../../../../docs/internal/features/admin-authentication.md"), "utf8");
  const section = contract.split("### Error messages on `/login`")[1].split("\n### ")[0];
  return [...section.matchAll(/^\| `([a-z_]+)` \| (.+) \|$/gm)].map((row) => [row[1], row[2]]);
}

const PROVIDERS = [
  { id: "keycloak", name: "Keycloak" },
  { id: "entra", name: "Microsoft Entra" },
];

function configure(providers: { id: string; name: string }[] | "missing"): void {
  jest.mocked(getAuthConfig).mockImplementation(() => {
    if (providers === "missing") throw new Error("OIDC_REDIRECT_URL is not set.");
    return { providers: new Map(providers.map((p) => [p.id, p])) } as unknown as AuthConfig;
  });
}

async function renderLogin(params: Record<string, string | string[]> = {}): Promise<string> {
  const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(params) }));
  return html.replaceAll("&#x27;", "'").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

function links(html: string): { href: string; className: string; label: string }[] {
  return [...html.matchAll(/<a ([^>]*)>(.*?)<\/a>/g)].map((match) => ({
    href: /href="([^"]+)"/.exec(match[1])?.[1] ?? "",
    className: /class="([^"]+)"/.exec(match[1])?.[1] ?? "",
    label: match[2].replace(/<[^>]+>/g, ""),
  }));
}

function heading(html: string): string | undefined {
  return /<h1[^>]*>(.*?)<\/h1>/.exec(html)?.[1];
}

const SUBTITLE = "Sign in with your company account to build real-time customer journeys.";

beforeEach(() => {
  jest.mocked(getSession).mockResolvedValue(null);
  configure(PROVIDERS);
  delete process.env.STUDIO_WORKSPACE_NAME;
});

describe("/login", () => {
  it("titles the browser tab Sign in", () => {
    expect(metadata.title).toBe("Sign in");
  });

  it("shows a visitor with no session the Salarose heading, the subtitle, the workspace, and one link per provider in order (AUTH-FR-04)", async () => {
    process.env.STUDIO_WORKSPACE_NAME = "Mộc Lan Shop";

    const html = await renderLogin({ returnTo: "/campaign/abc?x=1" });

    expect(heading(html)).toBe("Salarose");
    expect(html).toContain(SUBTITLE);
    expect(html).toContain("Mộc Lan Shop");
    expect(links(html).map((link) => [link.href, link.label])).toEqual([
      ["/api/auth/oidc/login?provider=keycloak&returnTo=%2Fcampaign%2Fabc%3Fx%3D1", "Sign in with Keycloak"],
      ["/api/auth/oidc/login?provider=entra&returnTo=%2Fcampaign%2Fabc%3Fx%3D1", "Sign in with Microsoft Entra"],
    ]);
    expect(html).not.toContain('role="alert"');
  });

  it("makes the first provider the primary button and the others secondary", async () => {
    const [first, second] = links(await renderLogin());

    expect(first.className).toContain("bg-primary");
    expect(second.className).not.toContain("bg-primary");
  });

  it("names the workspace Studio when the deployment sets none", async () => {
    expect(await renderLogin()).toContain(">Studio</p>");
  });

  it("reads all eight codes from the contract", () => {
    expect(contractMessages()).toHaveLength(8);
  });

  it.each(contractMessages())("shows the contract's message for %s word for word in an alert (AUTH-FR-04)", async (code, message) => {
    const html = await renderLogin({ error: code });

    expect(html).toMatch(new RegExp(`role="alert"[\\s\\S]*${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  it("names Salarose in the not_authorized message", async () => {
    expect(await renderLogin({ error: "not_authorized" })).toContain("Your account has no Salarose role.");
  });

  it("shows Not authorized with no subtitle, keeping the sign-in links (AUTH-FR-04)", async () => {
    const html = await renderLogin({ error: "not_authorized" });

    expect(heading(html)).toBe("Not authorized");
    expect(html).not.toContain(SUBTITLE);
    expect(links(html).map((link) => link.label)).toEqual(["Sign in with Keycloak", "Sign in with Microsoft Entra"]);
  });

  it("keeps the sign-in heading and subtitle for other errors", async () => {
    const html = await renderLogin({ error: "state_mismatch" });

    expect(heading(html)).toBe("Salarose");
    expect(html).toContain(SUBTITLE);
  });

  it("shows the server error message for an unknown code and never prints the raw value (AUTH-FR-04)", async () => {
    const html = await renderLogin({ error: "<b>owned</b>" });

    expect(html).toContain("Sign-in failed because of a server error. Try again.");
    expect(html).not.toContain("owned");
  });

  it("shows one primary Sign in with SSO button when the configuration is missing", async () => {
    configure("missing");

    const result = links(await renderLogin());

    expect(result).toHaveLength(1);
    expect(result[0].href).toBe("/api/auth/oidc/login");
    expect(result[0].label).toBe("Sign in with SSO");
    expect(result[0].className).toContain("bg-primary");
  });

  it("keeps every link and message when the horizon is removed, because the horizon carries none (AUTH-FR-04)", async () => {
    const html = await renderLogin({ error: "idp_error" });
    const horizon = /<svg[^>]*data-testid="horizon"[\s\S]*?<\/svg>/.exec(html)?.[0] ?? "";

    expect(horizon).toContain('aria-hidden="true"');
    expect(horizon).not.toMatch(/<a |<text|<button/);
    const without = html.replace(horizon, "");
    expect(links(without)).toHaveLength(2);
    expect(without).toContain("The identity provider cancelled or refused the sign-in.");
  });

  it("sends a signed-in user to /campaign", async () => {
    jest.mocked(getSession).mockResolvedValue({ userId: "u1", email: "lan@example.com", role: "editor" });

    await expect(renderLogin()).rejects.toThrow("NEXT_REDIRECT /campaign");
  });
});
