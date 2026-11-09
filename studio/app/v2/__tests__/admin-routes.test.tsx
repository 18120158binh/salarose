/** @jest-environment node */
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SystemUser } from "@/lib/db";
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
  headers: async () => new Headers(),
}));

jest.mock("next/navigation", () => ({
  redirect: jest.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  }),
}));

// Every export of the database module is a spy, so a page that reads anything is caught, whatever
// function it calls. Only the session lookup and the preview flag answer. The editor has preview
// access, so a preview admin page shows her the forbidden state, not the not-found page (SHL-FR-22).
const mockDataCalls: string[] = [];
const mockSessionUser: { current: unknown } = { current: undefined };
jest.mock("@/lib/db", () => {
  const spies = new Map<string, jest.Mock>();
  return new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === "__esModule") return true;
        if (typeof key !== "string" || key === "then") return undefined;
        if (key === "getAdminUserById") return async () => mockSessionUser.current;
        if (key === "getSystemUserPreview") return async () => true;
        if (!spies.has(key)) {
          spies.set(
            key,
            jest.fn(() => {
              mockDataCalls.push(key);
              return new Promise(() => {});
            }),
          );
        }
        return spies.get(key);
      },
    },
  );
});

jest.mock("kafkajs", () => ({
  Kafka: jest.fn(() => {
    mockDataCalls.push("kafka");
    return {};
  }),
}));

import { SESSION_COOKIE } from "@/shared/auth/constants";
import { NAV } from "@/widgets/v2-shell/model/routes";

const SECRET = "test-session-secret-0123456789-abcdef";

async function signInAsEditor(): Promise<void> {
  const user = { id: "user-editor", email: "editor@example.com", role: "editor", session_epoch: 0 } as SystemUser & {
    session_epoch: number;
  };
  mockSessionUser.current = user;
  const token = await signSessionToken(
    { userId: user.id, email: user.email, epoch: 0, providerId: "default" },
    new TextEncoder().encode(SECRET),
    3600,
  );
  mockCookieValues.set(SESSION_COOKIE, token);
}

type Page = (props: { params: Promise<object>; searchParams: Promise<object> }) => Promise<ReactElement>;

function pageAt(href: string): Page {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the route table names the module
  return require(`@/app${href}/page`).default;
}

const fetchSpy = jest.fn(() => new Promise<Response>(() => {}));

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
  global.fetch = fetchSpy as unknown as typeof fetch;
});

beforeEach(() => {
  mockCookieValues.clear();
  mockDataCalls.length = 0;
  fetchSpy.mockClear();
});

const ADMIN_PAGES = NAV.filter((entry) => entry.access === "admin" && entry.stage !== "reserved");

describe("admin pages of the route table", () => {
  it("includes at least the platform and settings pages", () => {
    expect(ADMIN_PAGES.map((entry) => entry.href)).toEqual(expect.arrayContaining(["/v2/platform", "/v2/settings"]));
  });

  it.each(ADMIN_PAGES.map((entry) => [entry.href]))(
    "%s shows an editor the forbidden state and reads no data (SHL-FR-03)",
    async (href) => {
      await signInAsEditor();

      const html = renderToStaticMarkup(await pageAt(href)({ params: Promise.resolve({}), searchParams: Promise.resolve({}) }));

      expect(html).toContain("This page is for admins.");
      expect(mockDataCalls).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );
});
