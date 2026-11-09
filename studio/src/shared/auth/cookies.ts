import type { NextRequest, NextResponse } from "next/server";
import { getAuthConfig, getSessionKey } from "./config";
import {
  OIDC_TX_COOKIE,
  OIDC_TX_COOKIE_PATH,
  OIDC_TX_MAX_AGE_SECONDS,
  SESSION_COOKIE,
} from "./constants";
import {
  signOidcTransaction,
  signSessionToken,
  verifyOidcTransaction,
  verifySessionToken,
  type SessionUser,
} from "./sessionToken";
import type { OidcTransaction } from "./types";

// Cookie reads and writes on NextRequest and NextResponse. The proxy imports this file, so
// it must stay free of the database and of next/headers.

export function hasSessionCookie(request: NextRequest): boolean {
  return request.cookies.has(SESSION_COOKIE);
}

// Checks only the signature, audience, issuer, and expiry. Does not look up the user.
export async function verifySessionCookie(request: NextRequest): Promise<SessionUser | null> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token, getSessionKey());
}

export async function setSessionCookie(response: NextResponse, user: SessionUser): Promise<void> {
  const config = getAuthConfig();
  const token = await signSessionToken(user, config.sessionKey, config.sessionMaxAgeSeconds);
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.secureCookies,
    path: "/",
    maxAge: config.sessionMaxAgeSeconds,
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.delete({ name: SESSION_COOKIE, path: "/" });
}

export async function setOidcTransactionCookie(
  response: NextResponse,
  tx: OidcTransaction,
): Promise<void> {
  const config = getAuthConfig();
  const token = await signOidcTransaction(tx, config.sessionKey);
  response.cookies.set(OIDC_TX_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: config.secureCookies,
    path: OIDC_TX_COOKIE_PATH,
    maxAge: OIDC_TX_MAX_AGE_SECONDS,
  });
}

export async function readOidcTransactionCookie(
  request: NextRequest,
): Promise<OidcTransaction | null> {
  return verifyOidcTransaction(request.cookies.get(OIDC_TX_COOKIE)?.value, getSessionKey());
}

export function clearOidcTransactionCookie(response: NextResponse): void {
  response.cookies.delete({ name: OIDC_TX_COOKIE, path: OIDC_TX_COOKIE_PATH });
}
