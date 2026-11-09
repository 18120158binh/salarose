import { jwtVerify, SignJWT, type JWTPayload } from "jose";
import { OIDC_TX_MAX_AGE_SECONDS } from "./constants";
import type { OidcTransaction } from "./types";

const ISSUER = "campaign-admin";
const SESSION_AUDIENCE = "campaign-admin:session";
const OIDC_TX_AUDIENCE = "campaign-admin:oidc-tx";
const ALGORITHM = "HS256";

export interface SessionUser {
  userId: string;
  email: string;
  // system_users.session_epoch at sign-in. Sign-out raises the stored epoch, which ends every
  // cookie signed below it.
  epoch: number;
  // The provider the user signed in at, so logout can end that provider's session.
  providerId: string;
}

export async function signSessionToken(
  user: SessionUser,
  key: Uint8Array,
  maxAgeSeconds: number,
  now: Date = new Date(),
): Promise<string> {
  return sign(
    { email: user.email, epoch: user.epoch, idp: user.providerId },
    SESSION_AUDIENCE,
    key,
    maxAgeSeconds,
    now,
    user.userId,
  );
}

export async function verifySessionToken(
  token: string | undefined,
  key: Uint8Array,
  now: Date = new Date(),
): Promise<SessionUser | null> {
  const payload = await verify(token, SESSION_AUDIENCE, key, now);
  if (!payload) return null;
  const { sub, email, epoch, idp } = payload;
  if (!isNonEmptyString(sub) || !isNonEmptyString(email) || !isEpoch(epoch) || !isNonEmptyString(idp)) return null;
  return { userId: sub, email, epoch, providerId: idp };
}

export async function signOidcTransaction(
  tx: OidcTransaction,
  key: Uint8Array,
  now: Date = new Date(),
): Promise<string> {
  return sign(
    { state: tx.state, nonce: tx.nonce, cv: tx.codeVerifier, rt: tx.returnTo, idp: tx.providerId },
    OIDC_TX_AUDIENCE,
    key,
    OIDC_TX_MAX_AGE_SECONDS,
    now,
  );
}

export async function verifyOidcTransaction(
  token: string | undefined,
  key: Uint8Array,
  now: Date = new Date(),
): Promise<OidcTransaction | null> {
  const payload = await verify(token, OIDC_TX_AUDIENCE, key, now);
  if (!payload) return null;
  const { state, nonce, cv, rt, idp } = payload;
  if (
    !isNonEmptyString(state) ||
    !isNonEmptyString(nonce) ||
    !isNonEmptyString(cv) ||
    !isNonEmptyString(rt) ||
    !isNonEmptyString(idp)
  ) {
    return null;
  }
  return { state, nonce, codeVerifier: cv, returnTo: rt, providerId: idp };
}

async function sign(
  claims: JWTPayload,
  audience: string,
  key: Uint8Array,
  maxAgeSeconds: number,
  now: Date,
  subject?: string,
): Promise<string> {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + maxAgeSeconds);
  if (subject !== undefined) jwt.setSubject(subject);
  return jwt.sign(key);
}

async function verify(
  token: string | undefined,
  audience: string,
  key: Uint8Array,
  now: Date,
): Promise<JWTPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: ISSUER,
      audience,
      algorithms: [ALGORITHM],
      currentDate: now,
    });
    return payload;
  } catch {
    return null;
  }
}

function isEpoch(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}
