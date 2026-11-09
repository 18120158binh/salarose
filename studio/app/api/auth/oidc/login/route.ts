import { NextResponse, type NextRequest } from "next/server";
import {
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  type Configuration,
} from "openid-client";
import { findProvider, getAuthConfig, type AuthConfig } from "@/shared/auth/config";
import { setOidcTransactionCookie } from "@/shared/auth/cookies";
import { getOidcConfiguration } from "@/shared/auth/oidc";
import { sanitizeReturnTo } from "@/shared/auth/returnTo";

export async function GET(request: NextRequest) {
  const returnTo = sanitizeReturnTo(request.nextUrl.searchParams.get("returnTo"));

  let config: AuthConfig;
  try {
    config = getAuthConfig();
  } catch (error) {
    console.error("Sign-in is not configured:", error instanceof Error ? error.message : error);
    // Without OIDC_REDIRECT_URL there is no trusted origin, so send a relative Location.
    return seeOther("/login?error=server_error");
  }
  const appOrigin = config.redirectUrl.origin;

  // The login page names the provider. With several providers, a link without a known one goes
  // back to the page so the user can choose.
  const provider = findProvider(config, request.nextUrl.searchParams.get("provider"));
  if (!provider) {
    const loginUrl = new URL("/login", appOrigin);
    loginUrl.searchParams.set("returnTo", returnTo);
    return seeOther(loginUrl);
  }

  let oidc: Configuration;
  try {
    oidc = await getOidcConfiguration(provider);
  } catch (error) {
    console.warn("OIDC sign-in failed: idp_unavailable", error instanceof Error ? error.message : error);
    return seeOther(new URL("/login?error=idp_unavailable", appOrigin));
  }

  const codeVerifier = randomPKCECodeVerifier();
  const state = randomState();
  const nonce = randomNonce();
  const authorizationUrl = buildAuthorizationUrl(oidc, {
    redirect_uri: config.redirectUrl.href,
    scope: provider.scopes,
    code_challenge: await calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: "S256",
    state,
    nonce,
  });

  const response = seeOther(authorizationUrl);
  await setOidcTransactionCookie(response, { state, nonce, codeVerifier, returnTo, providerId: provider.id });
  return response;
}

function seeOther(location: URL | string): NextResponse {
  return new NextResponse(null, {
    status: 303,
    headers: { Location: location.toString(), "Cache-Control": "no-store" },
  });
}
