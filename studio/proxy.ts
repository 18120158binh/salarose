import { NextResponse, type NextRequest } from "next/server";
import { getAuthConfig } from "@/shared/auth/config";
import { isPublicPath } from "@/shared/auth/constants";
import { clearSessionCookie, hasSessionCookie, verifySessionCookie } from "@/shared/auth/cookies";

// First filter only: checks the session cookie's signature and expiry without a database
// lookup. Pages, route handlers, and server actions check the session themselves.
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const session = await verifySessionCookie(request);
  if (!session) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const loginUrl = new URL("/login", appOrigin(request));
    if (request.method === "GET") {
      loginUrl.searchParams.set("returnTo", `${pathname}${search}`);
    }
    // 303, so a POST without a session, such as a server action, is not replayed to /login.
    const response = NextResponse.redirect(loginUrl, 303);
    if (hasSessionCookie(request)) clearSessionCookie(response);
    return response;
  }

  if (pathname === "/") {
    return NextResponse.redirect(new URL("/campaign", appOrigin(request)));
  }

  return NextResponse.next();
}

// Behind the ingress the request URL can carry an internal host, so redirects use the public
// origin of OIDC_REDIRECT_URL. Without the configuration nobody can sign in, but the visitor
// should still reach /login and its error. Next requires an absolute Location here and turns
// one on the request's own host into a relative Location.
function appOrigin(request: NextRequest): string {
  try {
    return getAuthConfig().redirectUrl.origin;
  } catch {
    return request.nextUrl.origin;
  }
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - those under _next/static/ (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * The dot is escaped and the last two are anchored with $, because the lookahead
     * otherwise skips any path that only starts like them, such as /favicon.icoX.
     */
    "/((?!_next/static/|_next/image$|favicon\\.ico$).*)",
  ],
};
