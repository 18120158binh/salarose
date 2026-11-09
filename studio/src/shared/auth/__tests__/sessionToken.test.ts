/** @jest-environment node */
import { SignJWT } from "jose";
import {
  signOidcTransaction,
  signSessionToken,
  verifyOidcTransaction,
  verifySessionToken,
} from "@/shared/auth/sessionToken";

const key = new TextEncoder().encode("test-session-secret-0123456789-abcdef");
const otherKey = new TextEncoder().encode("another-session-secret-0123456789-xyz");
const signedAt = new Date("2026-01-01T00:00:00Z");
const user = { userId: "user_42", email: "lan.nguyen@example.com", epoch: 3, providerId: "keycloak" };
const tx = {
  state: "state-abc",
  nonce: "nonce-def",
  codeVerifier: "verifier-ghi",
  returnTo: "/campaign/abc",
  providerId: "keycloak",
};

function secondsAfter(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function base64Url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("verifySessionToken", () => {
  it("returns the user a token was signed for", async () => {
    const token = await signSessionToken(user, key, 3600, signedAt);

    await expect(verifySessionToken(token, key, secondsAfter(signedAt, 60))).resolves.toEqual({
      userId: "user_42",
      email: "lan.nguyen@example.com",
      epoch: 3,
      providerId: "keycloak",
    });
  });

  it("rejects a token without an idp claim", async () => {
    const issuedAt = Math.floor(signedAt.getTime() / 1000);
    const token = await new SignJWT({ email: "lan.nguyen@example.com", epoch: 3 })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("campaign-admin")
      .setAudience("campaign-admin:session")
      .setSubject("user_42")
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 3600)
      .sign(key);

    await expect(verifySessionToken(token, key, signedAt)).resolves.toBeNull();
  });

  it("rejects a token without an epoch claim", async () => {
    const issuedAt = Math.floor(signedAt.getTime() / 1000);
    const token = await new SignJWT({ email: "lan.nguyen@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("campaign-admin")
      .setAudience("campaign-admin:session")
      .setSubject("user_42")
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 3600)
      .sign(key);

    await expect(verifySessionToken(token, key, signedAt)).resolves.toBeNull();
  });

  it("rejects a token with one changed character in its payload", async () => {
    const token = await signSessionToken(user, key, 3600, signedAt);
    const [header, payload, signature] = token.split(".");
    const middle = Math.floor(payload.length / 2);
    const changed = payload[middle] === "A" ? "B" : "A";
    const tampered = [
      header,
      payload.slice(0, middle) + changed + payload.slice(middle + 1),
      signature,
    ].join(".");

    await expect(verifySessionToken(tampered, key, signedAt)).resolves.toBeNull();
    await expect(verifySessionToken(token, key, signedAt)).resolves.toEqual(user);
  });

  it("rejects a token signed with a different key", async () => {
    const token = await signSessionToken(user, otherKey, 3600, signedAt);

    await expect(verifySessionToken(token, key, signedAt)).resolves.toBeNull();
  });

  it("rejects a token one second after it expires", async () => {
    const token = await signSessionToken(user, key, 3600, signedAt);

    await expect(verifySessionToken(token, key, secondsAfter(signedAt, 3599))).resolves.toEqual(user);
    await expect(verifySessionToken(token, key, secondsAfter(signedAt, 3601))).resolves.toBeNull();
  });

  it("rejects an unsigned token with alg none", async () => {
    const now = Math.floor(signedAt.getTime() / 1000);
    const unsigned = [
      base64Url({ alg: "none", typ: "JWT" }),
      base64Url({
        iss: "campaign-admin",
        aud: "campaign-admin:session",
        sub: "user_42",
        email: "lan.nguyen@example.com",
        epoch: 3,
        iat: now,
        exp: now + 3600,
      }),
      "",
    ].join(".");

    await expect(verifySessionToken(unsigned, key, signedAt)).resolves.toBeNull();
  });

  it.each([undefined, "", "admin1"])("rejects %p", async (value) => {
    await expect(verifySessionToken(value, key, signedAt)).resolves.toBeNull();
  });
});

describe("token audiences", () => {
  it("does not accept a transaction token as a session, or a session token as a transaction", async () => {
    const txToken = await signOidcTransaction(tx, key, signedAt);
    const sessionToken = await signSessionToken(user, key, 3600, signedAt);

    await expect(verifySessionToken(txToken, key, signedAt)).resolves.toBeNull();
    await expect(verifyOidcTransaction(sessionToken, key, signedAt)).resolves.toBeNull();
  });
});

describe("verifyOidcTransaction", () => {
  it("returns the transaction within 600 seconds and null after", async () => {
    const token = await signOidcTransaction(tx, key, signedAt);

    await expect(verifyOidcTransaction(token, key, secondsAfter(signedAt, 599))).resolves.toEqual(tx);
    await expect(verifyOidcTransaction(token, key, secondsAfter(signedAt, 601))).resolves.toBeNull();
  });

  it("rejects a transaction without a provider", async () => {
    const issuedAt = Math.floor(signedAt.getTime() / 1000);
    const token = await new SignJWT({ state: "s", nonce: "n", cv: "v", rt: "/campaign" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("campaign-admin")
      .setAudience("campaign-admin:oidc-tx")
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 600)
      .sign(key);

    await expect(verifyOidcTransaction(token, key, signedAt)).resolves.toBeNull();
    await expect(verifyOidcTransaction(await signOidcTransaction(tx, key, signedAt), key, signedAt)).resolves.toEqual(tx);
  });
});
