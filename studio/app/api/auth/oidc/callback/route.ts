import { NextResponse, type NextRequest } from "next/server";
import { authorizationCodeGrant, type Configuration, type IDToken } from "openid-client";
import * as db from "@/lib/db";
import { findProvider, getAuthConfig, type AuthConfig } from "@/shared/auth/config";
import {
  clearOidcTransactionCookie,
  readOidcTransactionCookie,
  setSessionCookie,
} from "@/shared/auth/cookies";
import { getOidcConfiguration } from "@/shared/auth/oidc";
import { checkCallbackParams, resolveSignIn } from "@/shared/auth/signIn";
import type { AuthErrorCode } from "@/shared/auth/types";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;

  let config: AuthConfig;
  try {
    config = getAuthConfig();
  } catch (error) {
    console.error("Sign-in is not configured:", error instanceof Error ? error.message : error);
    // Without OIDC_REDIRECT_URL there is no trusted origin, so send a relative Location.
    return seeOther("/login?error=server_error");
  }
  const appOrigin = config.redirectUrl.origin;
  const fail = (code: AuthErrorCode, detail?: string) => {
    console.warn(`OIDC sign-in failed: ${code}`, detail ?? "");
    return seeOther(new URL(`/login?error=${code}`, appOrigin));
  };

  const tx = await readOidcTransactionCookie(request);
  const paramsError = checkCallbackParams(params, tx);
  if (paramsError === "idp_error") {
    return fail(paramsError, `${params.get("error")}: ${params.get("error_description") ?? ""}`);
  }
  if (paramsError !== null || tx === null) {
    return fail(paramsError ?? "transaction_expired");
  }

  // The provider the sign-in started at. One removed from the configuration since then cannot
  // finish it.
  const provider = findProvider(config, tx.providerId);
  if (!provider) return fail("transaction_expired", `unknown provider ${tx.providerId}`);

  let oidc: Configuration;
  try {
    oidc = await getOidcConfiguration(provider);
  } catch (error) {
    return fail("idp_unavailable", errorMessage(error));
  }

  // openid-client derives the token request's redirect_uri from this URL, so it must be built
  // from OIDC_REDIRECT_URL and not from request.url, which can carry an internal host.
  const currentUrl = new URL(config.redirectUrl);
  currentUrl.search = request.nextUrl.search;

  let claims: IDToken | undefined;
  let idToken: string | undefined;
  try {
    const tokens = await authorizationCodeGrant(oidc, currentUrl, {
      pkceCodeVerifier: tx.codeVerifier,
      expectedState: tx.state,
      expectedNonce: tx.nonce,
      idTokenExpected: true,
    });
    claims = tokens.claims();
    idToken = tokens.id_token;
  } catch (error) {
    return fail("token_exchange_failed", errorMessage(error));
  }
  if (!claims) return fail("token_exchange_failed", "no ID token claims");

  const result = await resolveSignIn(claims, { upsertByAccount: db.upsertSystemUserFromSignIn }, provider);
  if (!result.ok) return fail(result.error);

  if (provider.logoutIdTokenHint && idToken) {
    try {
      await db.saveSystemUserIdToken(result.session.userId, result.session.epoch, idToken);
    } catch (error) {
      // Sign-out then sends client_id alone, which this provider may refuse.
      console.error("Could not store the ID token for the provider sign-out:", error);
    }
  }

  const response = seeOther(new URL(tx.returnTo, appOrigin));
  await setSessionCookie(response, result.session);
  return response;
}

// Every callback response deletes the transaction cookie and is not cached.
function seeOther(location: URL | string): NextResponse {
  const response = new NextResponse(null, {
    status: 303,
    headers: { Location: location.toString(), "Cache-Control": "no-store" },
  });
  clearOidcTransactionCookie(response);
  return response;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
