import { timingSafeEqual } from "node:crypto";
import type { IDToken } from "openid-client";
import type { SystemUserAccount } from "@/lib/db";
import type { SessionUser } from "./sessionToken";
import type { AuthErrorCode, OidcTransaction, SystemRole } from "./types";

export type SignInResult = { ok: true; session: SessionUser } | { ok: false; error: AuthErrorCode };

// Steps 1 to 3 of the OIDC callback: the transaction cookie, the state, and a provider error.
export function checkCallbackParams(
  params: URLSearchParams,
  tx: OidcTransaction | null,
): AuthErrorCode | null {
  if (tx === null) return "transaction_expired";
  const state = params.get("state");
  if (state === null || !constantTimeEqual(state, tx.state)) return "state_mismatch";
  if (params.has("error")) return "idp_error";
  return null;
}

// The provider account a sign-in proves, with what the token says about the person.
export interface SignInAccount {
  issuer: string;
  subject: string;
  // Trimmed and lowercased. Sign-in never finds a user by email.
  email: string;
  role: SystemRole;
}

// The system_users write sign-in needs.
export interface SignInUsers {
  // Creates the user for this provider account, or updates the role and email of the user that
  // has it, and returns that user.
  upsertByAccount(account: SignInAccount): Promise<SystemUserAccount>;
}

// The provider settings sign-in reads.
export interface SignInProvider {
  id: string;
  roleClaim: string;
  roleMap: ReadonlyMap<string, SystemRole>;
}

// Steps 5 to 7 of the OIDC callback: turns verified ID token claims into a session. The provider
// account (iss and sub) finds the user, and a first sign-in creates one. The role comes from the
// provider's role claim at every sign-in, and a token with no mapped role is refused.
export async function resolveSignIn(
  claims: IDToken,
  users: SignInUsers,
  provider: SignInProvider,
): Promise<SignInResult> {
  const { email } = claims;
  if (typeof email !== "string" || email.trim() === "") {
    return { ok: false, error: "email_missing" };
  }
  const role = mapRole(claims[provider.roleClaim], provider.roleMap);
  if (role === null) return { ok: false, error: "not_authorized" };

  try {
    const user = await users.upsertByAccount({
      issuer: claims.iss,
      subject: claims.sub,
      email: email.trim().toLowerCase(),
      role,
    });
    return {
      ok: true,
      session: { userId: user.id, email: user.email, epoch: user.session_epoch, providerId: provider.id },
    };
  } catch (error) {
    console.error("System user write failed during sign-in:", error);
    return { ok: false, error: "server_error" };
  }
}

// The highest role any value of the claim maps to. The claim may be one string or a list.
function mapRole(claim: unknown, roleMap: ReadonlyMap<string, SystemRole>): SystemRole | null {
  const values = typeof claim === "string" ? [claim] : Array.isArray(claim) ? claim : [];
  const roles = values.flatMap((value) => (typeof value === "string" ? (roleMap.get(value) ?? []) : []));
  if (roles.includes("admin")) return "admin";
  return roles.includes("editor") ? "editor" : null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
