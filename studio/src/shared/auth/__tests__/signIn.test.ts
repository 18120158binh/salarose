/** @jest-environment node */
import type { SystemUserAccount } from "@/lib/db";
import { checkCallbackParams, resolveSignIn } from "@/shared/auth/signIn";

const tx = {
  state: "state-abc",
  nonce: "nonce-def",
  codeVerifier: "verifier-ghi",
  returnTo: "/campaign",
  providerId: "keycloak",
};

describe("checkCallbackParams", () => {
  it("returns transaction_expired without a transaction", () => {
    expect(checkCallbackParams(new URLSearchParams({ state: "state-abc", code: "c" }), null)).toBe(
      "transaction_expired",
    );
  });

  it("returns state_mismatch for a different or missing state", () => {
    expect(checkCallbackParams(new URLSearchParams({ state: "state-xyz", code: "c" }), tx)).toBe(
      "state_mismatch",
    );
    expect(checkCallbackParams(new URLSearchParams({ code: "c" }), tx)).toBe("state_mismatch");
  });

  it("returns idp_error when the provider sends an error", () => {
    const params = new URLSearchParams({ state: "state-abc", error: "access_denied" });

    expect(checkCallbackParams(params, tx)).toBe("idp_error");
  });

  it("returns null for a matching state with a code", () => {
    expect(checkCallbackParams(new URLSearchParams({ state: "state-abc", code: "c" }), tx)).toBeNull();
  });
});

// Just-in-time provisioning: the provider account (iss and sub) finds the staff user, the
// provider's role claim decides the role at every sign-in, and a first sign-in creates the user.
describe("resolveSignIn", () => {
  const ISSUER = "https://idp.example.com";
  const KEYCLOAK = {
    id: "keycloak",
    roleClaim: "roles",
    roleMap: new Map([
      ["studio-admin", "admin"],
      ["studio-editor", "editor"],
    ] as const),
  };

  interface Row extends SystemUserAccount {
    oidc_issuer: string | null;
    oidc_subject: string | null;
  }

  // An in-memory system_users. upsertByAccount creates the row for a provider account, or updates
  // the row that has it, the way the INSERT ... ON CONFLICT on (oidc_issuer, oidc_subject) does.
  function directory(rows: Row[]) {
    return {
      upsertByAccount: jest.fn(
        async (account: { issuer: string; subject: string; email: string; role: string }) => {
          const existing = rows.find((row) => row.oidc_issuer === account.issuer && row.oidc_subject === account.subject);
          if (existing) {
            Object.assign(existing, { email: account.email, role: account.role });
            return existing;
          }
          const created: Row = {
            id: `user_${rows.length + 1}`,
            email: account.email,
            role: account.role,
            session_epoch: 0,
            oidc_issuer: account.issuer,
            oidc_subject: account.subject,
          };
          rows.push(created);
          return created;
        },
      ),
    };
  }

  function claims(extra: Record<string, unknown>) {
    return { iss: ISSUER, sub: "sub-lan", aud: "studio", iat: 0, exp: 0, email: "lan.nguyen@example.com", ...extra };
  }

  it("creates a staff user at the first sign-in with the role the token's claim maps to", async () => {
    const rows: Row[] = [];

    await expect(
      resolveSignIn(
        claims({ email: " Lan.Nguyen@Example.com ", roles: ["studio-editor"] }),
        directory(rows),
        KEYCLOAK,
      ),
    ).resolves.toEqual({
      ok: true,
      session: { userId: "user_1", email: "lan.nguyen@example.com", epoch: 0, providerId: "keycloak" },
    });
    expect(rows).toEqual([
      {
        id: "user_1",
        email: "lan.nguyen@example.com",
        role: "editor",
        session_epoch: 0,
        oidc_issuer: ISSUER,
        oidc_subject: "sub-lan",
      },
    ]);
  });

  it.each([
    ["a claim value no mapping names", { roles: ["marketing"] }],
    ["an empty claim", { roles: [] }],
    ["no role claim", {}],
    ["a claim that is not a string or a list of strings", { roles: 7 }],
    ["the mapped value under another claim", { groups: ["studio-admin"] }],
  ])("refuses a token with %s and creates nothing", async (_, extra) => {
    const rows: Row[] = [];
    const users = directory(rows);

    await expect(resolveSignIn(claims(extra), users, KEYCLOAK)).resolves.toEqual({
      ok: false,
      error: "not_authorized",
    });
    expect(users.upsertByAccount).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  it("updates the role and the email of the same provider account at the next sign-in", async () => {
    const rows: Row[] = [];
    const users = directory(rows);
    await resolveSignIn(claims({ roles: ["studio-editor"] }), users, KEYCLOAK);

    await expect(
      resolveSignIn(claims({ email: "lan.tran@example.com", roles: ["studio-admin"] }), users, KEYCLOAK),
    ).resolves.toMatchObject({ ok: true, session: { userId: "user_1", email: "lan.tran@example.com" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: "admin", email: "lan.tran@example.com" });
  });

  it("refuses an existing user whose token no longer maps to a role, and leaves the row as it was", async () => {
    const rows: Row[] = [];
    const users = directory(rows);
    await resolveSignIn(claims({ roles: ["studio-admin"] }), users, KEYCLOAK);

    await expect(resolveSignIn(claims({ roles: ["marketing"] }), users, KEYCLOAK)).resolves.toEqual({
      ok: false,
      error: "not_authorized",
    });
    expect(rows[0]).toMatchObject({ role: "admin" });
  });

  it.each([
    ["a list with both roles", ["studio-editor", "studio-admin"]],
    ["a single string", "studio-admin"],
  ])("gives admin for %s", async (_, roles) => {
    const rows: Row[] = [];

    await resolveSignIn(claims({ roles }), directory(rows), KEYCLOAK);

    expect(rows[0]).toMatchObject({ role: "admin" });
  });

  it("does not claim a row with the same email and another or no provider account", async () => {
    const unlinked: Row = {
      id: "user_old",
      email: "lan.nguyen@example.com",
      role: "admin",
      session_epoch: 4,
      oidc_issuer: null,
      oidc_subject: null,
    };
    const otherAccount: Row = { ...unlinked, id: "user_other", oidc_issuer: ISSUER, oidc_subject: "sub-mallory" };
    const rows = [unlinked, otherAccount];

    await expect(
      resolveSignIn(claims({ roles: ["studio-editor"] }), directory(rows), KEYCLOAK),
    ).resolves.toMatchObject({ ok: true, session: { userId: "user_3" } });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ ...unlinked });
    expect(rows[1]).toMatchObject({ role: "admin", oidc_subject: "sub-mallory" });
    expect(rows[2]).toMatchObject({ role: "editor", oidc_issuer: ISSUER, oidc_subject: "sub-lan" });
  });

  it("returns email_missing without an email claim and creates nothing", async () => {
    const users = directory([]);

    await expect(
      resolveSignIn(claims({ email: undefined, roles: ["studio-admin"] }), users, KEYCLOAK),
    ).resolves.toEqual({ ok: false, error: "email_missing" });
    expect(users.upsertByAccount).not.toHaveBeenCalled();
  });

  it("returns server_error when the write throws", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    const users = directory([]);
    users.upsertByAccount.mockRejectedValue(new Error("connection refused"));

    await expect(resolveSignIn(claims({ roles: ["studio-admin"] }), users, KEYCLOAK)).resolves.toEqual({
      ok: false,
      error: "server_error",
    });
    consoleError.mockRestore();
  });
});
