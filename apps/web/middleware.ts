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

/**
 * Reachable without a session. Everything else requires one.
 *
 * `/` is the hospital's PUBLIC website (see app/page.tsx) — the first thing a visitor sees, so it
 * must never bounce to sign-in. The password-reset pages are public too: they are the way BACK in
 * for someone who has no session by definition, so guarding them behind one is a locked door with
 * the key on the inside.
 *
 * `/` was missing from this list for a while, and the effect was total: the public site could not
 * be reached by ANY logged-out visitor, on any hospital's host, and a crawler indexing the
 * hospital's front page got a redirect to a login form. The comment above was right and the array
 * was wrong, which is the argument for `decide` being tested rather than described.
 */
const PUBLIC_PATHS = ["/", "/login", "/mfa", "/forgot-password", "/reset-password"];

/** Where a request should go, as a value. No framework, so it can be tested directly. */
export type Decision = { to: "continue" } | { to: "login"; next?: string } | { to: "dashboard" };

export function decide(input: {
  pathname: string;
  hasSession: boolean;
  /** The client sets `?reason=` when it has just been told the cookie is dead. */
  hasReason: boolean;
}): Decision {
  const { pathname, hasSession, hasReason } = input;

  /**
   * `p !== "/"` is not redundant. Without it the prefix arm builds `"//"`, and while no real path
   * starts with that today, a rule whose correctness rests on that coincidence is one bad edit
   * from making every route public. The root is an exact match and nothing else.
   */
  const isPublic = PUBLIC_PATHS.some(
    (p) => pathname === p || (p !== "/" && pathname.startsWith(`${p}/`)),
  );

  if (!hasSession && !isPublic) {
    // Send them back where they were trying to go, once they are in.
    return pathname === "/" ? { to: "login" } : { to: "login", next: pathname };
  }

  if (hasSession && pathname === "/login" && !hasReason) return { to: "dashboard" };

  return { to: "continue" };
}

export function middleware(req: NextRequest) {
  const decision = decide({
    pathname: req.nextUrl.pathname,
    hasSession: req.cookies.has(REFRESH_COOKIE),
    hasReason: req.nextUrl.searchParams.has("reason"),
  });

  if (decision.to === "login") {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    if (decision.next) url.searchParams.set("next", decision.next);
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
  if (decision.to === "dashboard") {
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
