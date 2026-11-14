/** @jest-environment node */
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { config, proxy } from "@/proxy";
import { signSessionToken } from "@/shared/auth/sessionToken";

const SECRET = "test-session-secret-0123456789-abcdef";
// Behind the ingress, requests reach the app on an internal host. Redirects must use the
// public origin from OIDC_REDIRECT_URL instead.
const INTERNAL_ORIGIN = "http://studio.internal:3001";
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

async function validCookie(): Promise<string> {
  const token = await signSessionToken(
    { userId: "user_7", email: "lan.nguyen@example.com", epoch: 0, providerId: "default" },
    new TextEncoder().encode(SECRET),
    3600,
  );
  return `cdp_admin_session=${token}`;
}

function request(path: string, init: { method?: string; cookie?: string } = {}): NextRequest {
  return new NextRequest(`${INTERNAL_ORIGIN}${path}`, {
    method: init.method ?? "GET",
    headers: init.cookie ? { cookie: init.cookie } : {},
  });
}

function redirectOf(response: Response): { status: number; location: string | null } {
  return { status: response.status, location: response.headers.get("location") };
}

function isPassedThrough(response: Response): boolean {
  return response.headers.get("x-middleware-next") === "1";
}

describe("proxy", () => {
  it("redirects a page request without a cookie to /login on the public origin with 303", async () => {
    const response = await proxy(request("/campaign/abc?x=1"));

    expect(redirectOf(response)).toEqual({
      status: 303,
      location: `${PUBLIC_ORIGIN}/login?returnTo=%2Fcampaign%2Fabc%3Fx%3D1`,
    });
  });

  it("redirects a /v2 page without a cookie to /login with the v2 path to return to (SHL-FR-02)", async () => {
    const response = await proxy(request("/v2/journeys"));

    expect(redirectOf(response)).toEqual({
      status: 303,
      location: `${PUBLIC_ORIGIN}/login?returnTo=%2Fv2%2Fjourneys`,
    });
  });

  it("redirects a POST without a cookie to /login with 303 and no returnTo", async () => {
    const response = await proxy(request("/campaign/abc", { method: "POST" }));

    expect(redirectOf(response)).toEqual({ status: 303, location: `${PUBLIC_ORIGIN}/login` });
  });

  it("redirects a tampered cookie to /login and deletes it", async () => {
    const [header, payload, signature] = (await validCookie()).split(".");
    const middle = Math.floor(payload.length / 2);
    const changed = payload[middle] === "A" ? "B" : "A";
    const tampered = [
      header,
      payload.slice(0, middle) + changed + payload.slice(middle + 1),
      signature,
    ].join(".");

    const response = await proxy(request("/campaign", { cookie: tampered }));

    expect(redirectOf(response)).toEqual({
      status: 303,
      location: `${PUBLIC_ORIGIN}/login?returnTo=%2Fcampaign`,
    });
    expect(response.headers.get("set-cookie")).toMatch(
      /^cdp_admin_session=; Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT/,
    );
  });

  it("lets a request with a valid cookie through", async () => {
    const response = await proxy(request("/campaign", { cookie: await validCookie() }));

    expect(isPassedThrough(response)).toBe(true);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("returns 401 JSON for an API request without a cookie", async () => {
    const response = await proxy(request("/api/generate-journey", { method: "POST" }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it.each(["/api/auth/oidc/callback?code=c&state=s", "/login"])(
    "lets %p through without a cookie",
    async (path) => {
      expect(isPassedThrough(await proxy(request(path)))).toBe(true);
    },
  );

  it("lets a data ingestion API request through without a cookie, for the route to check its source key", async () => {
    const response = await proxy(request("/v1/business-events", { method: "POST" }));

    expect(isPassedThrough(response)).toBe(true);
  });

  it.each([
    "/v1/imports",
    "/v1/imports/5f0c8a2e-1b7d-4c39-9a51-2d3e4f5a6b7c",
    "/v1/imports/5f0c8a2e-1b7d-4c39-9a51-2d3e4f5a6b7c/complete",
    "/v1/records/orders",
  ])("lets the import route %p through without a cookie, for the route to check its source key", async (path) => {
    const response = await proxy(request(path, { method: "POST" }));

    expect(isPassedThrough(response)).toBe(true);
  });

  it.each(["/v1x", "/v1/other", "/v1/business-events/x", "/v1/imports/a/b", "/v1/records", "/v1/records/a/b"])(
    "still redirects %p, which is not a listed ingestion route",
    async (path) => {
      const response = await proxy(request(path, { method: "POST" }));

      expect(redirectOf(response)).toEqual({ status: 303, location: `${PUBLIC_ORIGIN}/login` });
    },
  );

  it("lets /login through with a valid cookie instead of redirecting", async () => {
    const response = await proxy(request("/login", { cookie: await validCookie() }));

    expect(isPassedThrough(response)).toBe(true);
  });

  it("redirects / to /campaign with a valid cookie", async () => {
    const response = await proxy(request("/", { cookie: await validCookie() }));

    expect(redirectOf(response)).toEqual({ status: 307, location: `${PUBLIC_ORIGIN}/campaign` });
  });
});

describe("proxy without the OIDC configuration", () => {
  const redirectUrl = process.env.OIDC_REDIRECT_URL;

  beforeAll(() => {
    delete process.env.OIDC_REDIRECT_URL;
  });

  afterAll(() => {
    process.env.OIDC_REDIRECT_URL = redirectUrl;
  });

  it("still redirects a page request to /login, on the request's own host", async () => {
    // A fresh module registry, so no configuration is cached from the tests above.
    await jest.isolateModulesAsync(async () => {
      const { proxy: unconfiguredProxy } = await import("@/proxy");

      const response = await unconfiguredProxy(request("/campaign"));

      expect(redirectOf(response)).toEqual({
        status: 303,
        location: `${INTERNAL_ORIGIN}/login?returnTo=%2Fcampaign`,
      });
    });
  });
});

describe("proxy matcher", () => {
  it.each(["/favicon.ico", "/_next/static/chunks/main.js", "/_next/image?url=%2Flogo.png&w=64&q=75"])(
    "skips the static file %p",
    (url) => {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
    },
  );

  it.each(["/favicon.icoX", "/favicon_ico", "/favicon.ico/x", "/_next/staticX", "/_next/imageX", "/campaign", "/"])(
    "runs the proxy for %p",
    (url) => {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
    },
  );
});
