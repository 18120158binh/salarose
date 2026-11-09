/** @jest-environment node */
import type { AdminSession } from "@/shared/auth/types";
import { bridge } from "../../testing/pgBridge";
import { isPreviewViewer, requirePreviewViewer } from "@/shared/auth/preview";

jest.mock("../../../../../shared/node_modules/pg", () => jest.requireActual("../../testing/pgBridge").bridge.pgModule());
jest.mock("server-only", () => ({}));
jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
}));
jest.mock("@/shared/auth/session", () => ({
  requireSession: async () => {
    const session = (globalThis as { mockSession?: AdminSession | null }).mockSession;
    if (!session) throw new Error("NEXT_REDIRECT /login");
    return session;
  },
}));

const EDITOR: AdminSession = { userId: "user_lan", email: "lan@example.com", role: "editor" };
const ADMIN: AdminSession = { userId: "user_an", email: "an@example.com", role: "admin" };
const signIn = (session: AdminSession | null) => {
  (globalThis as { mockSession?: AdminSession | null }).mockSession = session;
};
const setPreview = (session: AdminSession, preview: boolean) =>
  bridge.query("UPDATE system_users SET preview = $2 WHERE id = $1", [session.userId, preview]);

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://pglite-bridge";
  await bridge.ready();
  for (const user of [EDITOR, ADMIN]) {
    await bridge.query("INSERT INTO system_users (id, email, role, oidc_issuer, oidc_subject) VALUES ($1, $2, $3, 'idp', $1)", [user.userId, user.email, user.role]);
  }
}, 120_000);
afterAll(() => bridge.stop());

// SHL-FR-22: a route at stage preview opens to admins and to staff whose preview flag is true.
describe("the preview check", () => {
  it("gives an editor without the flag the not-found page", async () => {
    signIn(EDITOR);
    await setPreview(EDITOR, false);
    await expect(requirePreviewViewer()).rejects.toThrow("404");
  });

  it("opens to an editor with the flag", async () => {
    signIn(EDITOR);
    await setPreview(EDITOR, true);
    await expect(requirePreviewViewer()).resolves.toEqual(EDITOR);
  });

  it("applies a flag change at the next request, with no new sign-in", async () => {
    signIn(EDITOR);
    await setPreview(EDITOR, false);
    expect(await isPreviewViewer(EDITOR)).toBe(false);
    await setPreview(EDITOR, true);
    expect(await isPreviewViewer(EDITOR)).toBe(true);
    await setPreview(EDITOR, false);
    expect(await isPreviewViewer(EDITOR)).toBe(false);
  });

  it("opens to an admin, whose flag is false", async () => {
    signIn(ADMIN);
    await expect(requirePreviewViewer()).resolves.toEqual(ADMIN);
  });

  it("sends a request with no session to sign in before it reads the flag", async () => {
    signIn(null);
    await expect(requirePreviewViewer()).rejects.toThrow("NEXT_REDIRECT /login");
  });
});
