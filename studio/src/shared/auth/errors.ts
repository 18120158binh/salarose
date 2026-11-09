import type { AuthErrorCode } from "./types";

export const AUTH_ERROR_MESSAGES: Record<AuthErrorCode, string> = {
  transaction_expired: "Your sign-in took too long or was started in another tab. Sign in again.",
  state_mismatch: "The sign-in response did not match this browser's request. Sign in again.",
  idp_error: "The identity provider cancelled or refused the sign-in.",
  idp_unavailable: "The identity provider could not be reached. Try again later or contact an admin.",
  token_exchange_failed: "The identity provider did not complete the sign-in. Try again.",
  email_missing: "The identity provider did not send an email address. Ask an admin to check the OIDC scopes.",
  not_authorized:
    "Your account has no Salarose role. Ask the admin of your identity provider to assign you one.",
  server_error: "Sign-in failed because of a server error. Try again.",
};

// Reads the `error` query value on /login. No value means no error; an unknown value is
// shown as a server error so the page never prints the raw query value.
export function parseAuthErrorCode(value: string | undefined): AuthErrorCode | null {
  if (value === undefined || value === "") return null;
  return isAuthErrorCode(value) ? value : "server_error";
}

function isAuthErrorCode(value: string): value is AuthErrorCode {
  return Object.hasOwn(AUTH_ERROR_MESSAGES, value);
}
