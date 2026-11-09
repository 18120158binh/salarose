export type SystemRole = "admin" | "editor";

export function isSystemRole(value: string): value is SystemRole {
  return value === "admin" || value === "editor";
}

export interface AdminSession {
  userId: string; // system_users.id
  email: string; // system_users.email, lowercase
  role: SystemRole; // read from system_users on every call, not from the cookie
}

declare const checkedAdmin: unique symbol;

// A session whose role was checked to be admin on this request. Only toCheckedAdmin makes one, so
// a server function that takes it cannot run for an editor.
export type CheckedAdmin = AdminSession & { readonly role: "admin"; readonly [checkedAdmin]: true };

export function toCheckedAdmin(session: AdminSession): CheckedAdmin | null {
  return session.role === "admin" ? (session as CheckedAdmin) : null;
}

export interface OidcTransaction {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  // The provider the sign-in started at. The callback finishes it there.
  providerId: string;
}

export type AuthErrorCode =
  | "transaction_expired"
  | "state_mismatch"
  | "idp_error"
  | "idp_unavailable"
  | "token_exchange_failed"
  | "email_missing"
  | "not_authorized"
  | "server_error";
