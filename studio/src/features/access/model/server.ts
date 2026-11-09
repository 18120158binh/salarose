import "server-only";
import { decodeJwt } from "jose";
import { cookies } from "next/headers";
import { readOnly } from "@/lib/db";
import { getAuthConfig, getSessionKey } from "@/shared/auth/config";
import { SESSION_COOKIE } from "@/shared/auth/constants";
import { verifySessionToken } from "@/shared/auth/sessionToken";
import { isSystemRole } from "@/shared/auth/types";
import type { PreviewStaff } from "./settings";

const READ_TIMEOUT_MS = 5_000;

export interface SignInDetails {
  // The provider's name from the configuration, or its id when the configuration no longer has it.
  provider: string;
  expiresAt: number;
}

// The provider and expiry live only in the session cookie. The viewer's session was checked on this
// request, so the cookie verifies here too, and null means it expired between the two reads.
export async function signInDetails(): Promise<SignInDetails | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const sessionUser = await verifySessionToken(token, getSessionKey());
  if (!token || !sessionUser) return null;
  const { exp } = decodeJwt(token);
  if (exp === undefined) return null;
  return { provider: providerName(sessionUser.providerId), expiresAt: exp * 1000 };
}

function providerName(id: string): string {
  try {
    return getAuthConfig().providers.get(id)?.name ?? id;
  } catch {
    return id;
  }
}

// SHL-FR-20: the staff whose preview flag is true. The settings page calls it only for an admin.
export async function previewStaff(): Promise<PreviewStaff[]> {
  const rows = await readOnly(READ_TIMEOUT_MS, (run) =>
    run({ text: "SELECT email, role FROM system_users WHERE preview ORDER BY email", values: [] }),
  );
  return rows.flatMap((row) => {
    const role = String(row.role);
    return isSystemRole(role) ? [{ email: String(row.email).toLowerCase(), role }] : [];
  });
}
