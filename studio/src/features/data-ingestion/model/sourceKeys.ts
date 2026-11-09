import { createHash, randomBytes } from "node:crypto";
import { UserFacingError } from "shared/lib/userFacingError";

const KEY_PREFIX = "cdp_sk_";
const HINT_LENGTH = KEY_PREFIX.length + 4;
const APP_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface NewSourceKey {
  key: string;
  hash: string;
  hint: string;
}

// 32 random bytes, so a plain SHA-256 is enough: there is nothing to guess that a slow hash
// would protect.
export function generateSourceKey(): NewSourceKey {
  const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashSourceKey(key), hint: key.slice(0, HINT_LENGTH) };
}

export function hashSourceKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

// The key from `Authorization: Bearer <key>`, or null.
export function bearerKey(header: string | null): string | null {
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : null;
}

export function parseAppId(value: unknown): string {
  const appId = typeof value === "string" ? value.trim() : "";
  if (!APP_ID.test(appId)) {
    throw new UserFacingError(
      "The app id must be 1 to 64 lower-case letters, digits, dots, dashes, or underscores, starting with a letter or digit.",
    );
  }
  return appId;
}
