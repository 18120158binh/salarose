import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import * as db from "@/lib/db";
import { UserFacingError } from "shared/lib/userFacingError";
import { getSessionKey } from "./config";
import { SESSION_COOKIE } from "./constants";
import { verifySessionToken } from "./sessionToken";
import { isSystemRole, type AdminSession } from "./types";

export class AuthorizationError extends UserFacingError {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

// Verifies the session cookie, then loads the user so a deleted user, a changed role, or a
// sign-out in another browser takes effect on the next request.
export async function getSession(): Promise<AdminSession | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const sessionUser = await verifySessionToken(token, getSessionKey());
  if (!sessionUser) return null;

  const user = await db.getAdminUserById(sessionUser.userId);
  if (!user || !isSystemRole(user.role) || sessionUser.epoch < user.session_epoch) return null;
  return { userId: user.id, email: user.email.toLowerCase(), role: user.role };
}

// For pages.
export async function requireSession(): Promise<AdminSession> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

// For pages.
export async function requireAdmin(): Promise<AdminSession> {
  const session = await requireSession();
  if (session.role !== "admin") redirect("/campaign");
  return session;
}

// For server actions and route handlers.
export async function assertSession(): Promise<AdminSession> {
  const session = await getSession();
  if (!session) throw new AuthorizationError("Unauthorized");
  return session;
}

// For server actions.
export async function assertAdmin(): Promise<AdminSession> {
  const session = await assertSession();
  if (session.role !== "admin") throw new AuthorizationError("Only admin users can do this.");
  return session;
}
