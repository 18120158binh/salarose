/** @jest-environment node */
import type { SystemUser } from "@/lib/db";
import { SESSION_COOKIE } from "@/shared/auth/constants";
import { UTC } from "@/shared/lib/time-range";
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
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
}));

const mockSessionUser: { current: unknown } = { current: undefined };
const mockListSegmentSummaries = jest.fn(async () => []);
jest.mock("@/lib/db", () => ({
  getAdminUserById: async () => mockSessionUser.current,
  listSegmentSummaries: () => mockListSegmentSummaries(),
}));

import { loadSegmentRows } from "../server";

const SECRET = "test-session-secret-0123456789-abcdef";
const EDITOR = { id: "user-editor", email: "editor@example.com", role: "editor", session_epoch: 0 } as SystemUser & {
  session_epoch: number;
};

async function holdSignedCookieFor(user: typeof EDITOR): Promise<void> {
  const token = await signSessionToken(
    { userId: user.id, email: user.email, epoch: 0, providerId: "default" },
    new TextEncoder().encode(SECRET),
    3600,
  );
  mockCookieValues.set(SESSION_COOKIE, token);
}

beforeAll(() => {
  process.env.SESSION_SECRET = SECRET;
});

beforeEach(() => {
  mockCookieValues.clear();
  mockSessionUser.current = undefined;
  mockListSegmentSummaries.mockClear();
});

describe("loadSegmentRows (SEG-NFR-02)", () => {
  it("sends a visitor without a session to sign in and reads no segment", async () => {
    await expect(loadSegmentRows(UTC)).rejects.toThrow("NEXT_REDIRECT /login");
    expect(mockListSegmentSummaries).not.toHaveBeenCalled();
  });

  it("sends a deleted user who still holds a signed cookie to sign in and reads no segment", async () => {
    await holdSignedCookieFor(EDITOR);

    await expect(loadSegmentRows(UTC)).rejects.toThrow("NEXT_REDIRECT /login");
    expect(mockListSegmentSummaries).not.toHaveBeenCalled();
  });

  it("reads the segments for a signed-in user", async () => {
    mockSessionUser.current = EDITOR;
    await holdSignedCookieFor(EDITOR);

    await expect(loadSegmentRows(UTC)).resolves.toEqual([]);
    expect(mockListSegmentSummaries).toHaveBeenCalledTimes(1);
  });
});
