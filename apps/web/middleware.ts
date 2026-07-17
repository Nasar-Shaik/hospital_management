import { NextResponse, type NextRequest } from "next/server";

/**
 * Route guard (Doc 04 §3.2, ADR-0012).
 *
 * This middleware REDIRECTS; it does not AUTHORIZE. All it knows is whether a
 * refresh cookie is present — not whether it is valid, not who owns it, and
 * certainly not what they may do. Every one of those questions is answered by
 * Express, on every request, no matter what happens here.
 *
 * Its only job is to stop an unauthenticated visitor from watching a dashboard
 * skeleton render before a client-side check bounces them. A forged cookie gets
 * a nicer-looking page and exactly zero data.
 */
const REFRESH_COOKIE = "hms_refresh";

/** Reachable without a session. Everything else requires one. */
const PUBLIC_PATHS = ["/login", "/mfa"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasSession = req.cookies.has(REFRESH_COOKIE);
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (!hasSession && !isPublic) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    // Send them back where they were trying to go, once they are in.
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  /**
   * Already signed in and staring at the login page — go somewhere useful.
   *
   * ── UNLESS THE CLIENT SAYS THE SESSION IS DEAD ───────────────────────────────
   * A cookie is not a session, and this middleware cannot tell the difference: it
   * sees presence, never validity. The client CAN tell — it just tried to exchange
   * the thing and got a 401 — and it says so with `?reason=`.
   *
   * Without this hatch a stale cookie is a trap with no exit, which is exactly how
   * it reached a user: /dashboard renders, its refresh 401s, the app redirects to
   * /login, and this rule sends it back to /dashboard, where it stops on a blank
   * page. The login form becomes unreachable, and the cookie is httpOnly so they
   * cannot clear it themselves.
   *
   * The API now clears a rejected cookie, which closes the trap at its root. This
   * stays anyway: it costs one condition, and it means no future cookie bug can
   * ever cost a user their way back in.
   */
  if (hasSession && pathname === "/login" && !req.nextUrl.searchParams.has("reason")) {
    const url = req.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Everything except Next internals, the health route and static files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/health).*)"],
};
