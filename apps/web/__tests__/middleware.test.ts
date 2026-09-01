/**
 * THE ROUTE GUARD (Doc 04 §3.2, ADR-0012).
 *
 * `decide` answers one question — where does this request go — and gets it wrong in ways that are
 * invisible in review. Two failures have already reached users from these few lines:
 *
 *   1. `/` was absent from `PUBLIC_PATHS`, so the hospital's public website was unreachable by
 *      every logged-out visitor on every host, and crawlers indexed a redirect to a login form.
 *   2. A stale cookie became a trap: /login bounced to /dashboard, which bounced back, and the
 *      cookie was httpOnly so the user could not clear it. `?reason=` is the hatch.
 *
 * Both are one boolean. Hence a table, not a description.
 */
import { describe, expect, it } from "vitest";
import { decide } from "../middleware";

const out = (pathname: string, hasSession = false, hasReason = false) =>
  decide({ pathname, hasSession, hasReason });

describe("a logged-out visitor", () => {
  it("SEES the hospital's public front page", () => {
    /**
     * The regression. `app/page.tsx` is a real public site — name, services, doctors, crawlable —
     * and it guards itself: unpublished content redirects to sign-in, an unresolved host renders a
     * neutral fallback. The middleware's only job is to let it run.
     */
    expect(out("/")).toEqual({ to: "continue" });
  });

  it("reaches the pages that are the way back IN", () => {
    // Guarding these behind a session is a locked door with the key on the inside.
    for (const path of ["/login", "/mfa", "/forgot-password", "/reset-password"]) {
      expect(out(path), path).toEqual({ to: "continue" });
    }
    expect(out("/reset-password/a-token-here")).toEqual({ to: "continue" });
  });

  it("is turned away from everything else, and told where it was going", () => {
    expect(out("/dashboard")).toEqual({ to: "login", next: "/dashboard" });
    expect(out("/patients/123")).toEqual({ to: "login", next: "/patients/123" });
    expect(out("/billing")).toEqual({ to: "login", next: "/billing" });
  });

  it("carries no `next` off the root — there is nowhere to return to", () => {
    expect(out("/")).not.toHaveProperty("next");
  });

  it("is not let through by a path that merely STARTS like a public one", () => {
    /**
     * `startsWith` without the boundary would make `/loginsomething` public. The rule matches a
     * path or a segment beneath it, never a prefix of a longer name.
     */
    expect(out("/loginsomething")).toEqual({ to: "login", next: "/loginsomething" });
    expect(out("/mfa-bypass")).toEqual({ to: "login", next: "/mfa-bypass" });
  });

  it("is not let through by the root rule matching too widely", () => {
    /**
     * The root is an exact match. If it ever became a PREFIX match, every route in the app would
     * be public in one step — the highest-consequence single character in this file.
     */
    for (const path of ["/dashboard", "/patients", "/settings/profile", "/a"]) {
      expect(out(path), path).toMatchObject({ to: "login" });
    }
  });
});

describe("a visitor holding a session cookie", () => {
  it("is left alone on the pages they asked for", () => {
    expect(out("/dashboard", true)).toEqual({ to: "continue" });
    expect(out("/", true)).toEqual({ to: "continue" });
  });

  it("is moved off the login page to somewhere useful", () => {
    expect(out("/login", true)).toEqual({ to: "dashboard" });
  });

  it("is NOT moved when the client says the cookie is already dead", () => {
    /**
     * The trap. The middleware sees a cookie's presence, never its validity; the client knows,
     * because its refresh just 401'd, and says so with `?reason=`. Without this the login form is
     * unreachable and an httpOnly cookie cannot be cleared by the person stuck behind it.
     */
    expect(out("/login", true, true)).toEqual({ to: "continue" });
  });
});

describe("the guard redirects — it does not authorize", () => {
  it("treats any cookie as a session, which is why the API re-checks everything", () => {
    /**
     * Stated as a test so it cannot be mistaken for an oversight: a forged cookie gets past this
     * file by design. It buys a rendered skeleton and no data — Express authorizes every request
     * regardless of what happened here.
     */
    expect(out("/dashboard", true)).toEqual({ to: "continue" });
  });
});
