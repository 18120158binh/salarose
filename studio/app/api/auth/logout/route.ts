import { NextResponse, type NextRequest } from "next/server";
import { buildEndSessionUrl, type Configuration } from "openid-client";
import * as db from "@/lib/db";
import { findProvider, getAuthConfig, type AuthConfig, type OidcProvider } from "@/shared/auth/config";
import { clearSessionCookie, verifySessionCookie } from "@/shared/auth/cookies";
import { getOidcConfiguration } from "@/shared/auth/oidc";
import type { SessionUser } from "@/shared/auth/sessionToken";

// POST only, so a link or prefetch cannot sign the user out. Works with or without a session.
export async function POST(request: NextRequest) {
  const user = await readSession(request);
  const config = readConfig();
  const provider = config && findProvider(config, user?.providerId ?? null);
  // Read before the epoch rises, while the token still matches the cookie's epoch.
  const idTokenHint = user && provider?.logoutIdTokenHint ? await takeIdToken(user) : null;
  if (user) await endSessions(user);

  const response = new NextResponse(null, {
    status: 303,
    headers: {
      Location: config && provider ? await signOutLocation(config, provider, idTokenHint) : "/login",
      "Cache-Control": "no-store",
    },
  });
  clearSessionCookie(response);
  return response;
}

async function readSession(request: NextRequest): Promise<SessionUser | null> {
  try {
    return await verifySessionCookie(request);
  } catch {
    // Without SESSION_SECRET no session cookie can be valid.
    return null;
  }
}

function readConfig(): AuthConfig | null {
  try {
    return getAuthConfig();
  } catch {
    return null;
  }
}

// The ID token stored at sign-in, for a provider that requires id_token_hint. A failure is
// logged and the sign-out goes on with client_id alone.
async function takeIdToken(user: SessionUser): Promise<string | null> {
  try {
    return await db.takeSystemUserIdToken(user.userId, user.epoch);
  } catch (error) {
    console.error("Could not read the ID token for the provider sign-out:", error);
    return null;
  }
}

// Raises the user's session epoch, so every copy of this session cookie stops working, in this
// browser and in any other. A failure is logged and the cookie is still deleted.
async function endSessions(user: SessionUser): Promise<void> {
  try {
    await db.endSystemUserSessions(user.userId, user.epoch);
  } catch (error) {
    console.error("Could not end the user's sessions at sign-out:", error);
  }
}

// The provider's end_session_endpoint (RP-initiated logout), which sends the user back to
// /login. Without that endpoint, only the app session ends. A relative /login keeps logout
// working when the OIDC variables are missing.
async function signOutLocation(
  config: AuthConfig,
  provider: OidcProvider,
  idTokenHint: string | null,
): Promise<string> {
  const localSignOut = "/login";

  let oidc: Configuration;
  try {
    oidc = await getOidcConfiguration(provider);
  } catch (error) {
    console.warn("Provider sign-out skipped: idp_unavailable", error instanceof Error ? error.message : error);
    return localSignOut;
  }
  if (!oidc.serverMetadata().end_session_endpoint) return localSignOut;

  // buildEndSessionUrl adds client_id. RP-Initiated Logout accepts it with or without
  // id_token_hint. Cognito ignores post_logout_redirect_uri and returns only to logout_uri.
  const returnTo = new URL("/login", config.redirectUrl.origin).href;
  return buildEndSessionUrl(oidc, {
    ...(idTokenHint ? { id_token_hint: idTokenHint } : {}),
    post_logout_redirect_uri: returnTo,
    logout_uri: returnTo,
  }).href;
}
