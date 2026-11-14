import "server-only";
import { NextResponse } from "next/server";
import * as db from "@/lib/db";
import { createKeyRateLimiter, parseRequestsPerSecond } from "./rateLimit";
import { bearerKey, hashSourceKey } from "./sourceKeys";

// Per process: each replica counts on its own, and a restart clears the counts. Every route of the
// data ingestion API and of data import shares this one limiter, so a key has one budget across
// them (DIA-NFR-02, DIM-NFR-05).
const rateLimiter = createKeyRateLimiter();

export type AuthenticatedSource = { ok: true; source: db.StoredSourceKey } | { ok: false; response: NextResponse };

export function failure(status: number, error: string, headers?: Record<string, string>): NextResponse {
  return NextResponse.json({ error }, { status, headers });
}

/**
 * Checks `Authorization: Bearer <source key>` and the key's rate limit. A missing, unknown, or
 * revoked key gets 401, and a key over its limit gets 429. Logs never hold the key (DIA-NFR-05).
 */
export async function authenticateSourceKey(req: Request, label: string): Promise<AuthenticatedSource> {
  const key = bearerKey(req.headers.get("authorization"));
  if (!key) return { ok: false, response: failure(401, "A valid source key is required.") };

  const keyHash = hashSourceKey(key);
  let source: db.StoredSourceKey | null;
  try {
    source = await db.findSourceKeyByHash(keyHash);
  } catch (error) {
    console.error(`${label}: the source key lookup failed:`, error);
    return { ok: false, response: failure(503, "The service is unavailable. Try again.") };
  }
  if (!source || source.revoked) return { ok: false, response: failure(401, "A valid source key is required.") };

  let perSecond: number;
  try {
    perSecond = parseRequestsPerSecond(process.env);
  } catch (error) {
    console.error(`${label}: invalid configuration:`, error);
    return { ok: false, response: failure(503, "The service is not configured.") };
  }
  const decision = rateLimiter.take(keyHash, perSecond);
  if (!decision.allowed) {
    return {
      ok: false,
      response: failure(429, "Too many requests for this source key.", { "Retry-After": String(decision.retryAfterSeconds) }),
    };
  }
  return { ok: true, source };
}

/** The body as text, or null once it passes maxBytes. Stops reading at the cap. */
export async function readCapped(req: Request, maxBytes: number): Promise<string | null> {
  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (declaredLength > maxBytes) return null;
  // content-length can be absent, as with a chunked body, so the cap holds while reading too.
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
