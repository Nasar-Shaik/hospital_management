/**
 * ENDING A SESSION MUST CLEAR THE CLIENT, NOT JUST NAVIGATE.
 *
 * ── THE BUG THIS PINS ───────────────────────────────────────────────────────
 * A new member of staff signs in with a temporary password, is sent to /change-password, replaces
 * it — and stays exactly where they are. Manual testing reported it as "it only redirects if I
 * interact with another page".
 *
 * The page navigated. What it did NOT do was clear its own session, and that is the whole defect:
 * `changePassword` revokes every session SERVER-side, but the tab kept `user` in state and a
 * working in-memory access token, so it still rendered as signed in and the route guard — which
 * sees a cookie's presence, never its validity — sent /login straight back to /dashboard. The
 * sign-out only became visible on the next request that happened to 401.
 *
 * ── WHY THIS FILE RENDERS ───────────────────────────────────────────────────
 * The house rule (see `vitest.config.ts`) keeps tests in Node and out of the DOM unless the
 * defect is *about* mounting. This one is: the claim is "the app no longer believes anyone is
 * signed in", and the only honest evidence is a component that reads the session and stops
 * showing a user. Asserting that `endSession` calls `setState` would restate the implementation
 * and would still pass on the day someone navigates without calling it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

const replace = vi.fn();
/**
 * ONE router object, not a fresh one per call — matching Next, which returns a stable instance.
 * The provider's bootstrap effect depends on the router through `scheduleRefresh`/`adopt`, so a
 * mock that re-allocates would re-run the effect on every render and refresh in a tight loop.
 */
const router = { replace, push: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

/**
 * The client the provider builds. Only the three calls the session lifecycle makes are real:
 * `refresh` revives the tab, `me` carries the permission list, `logout` ends it server-side.
 */
const me = {
  id: "u1",
  email: "nurse@sunrise.test",
  name: "A Nurse",
  roles: ["NURSE"],
  permissions: ["patient:read"],
  mustChangePassword: false,
};
const logoutCall = vi.fn(() => Promise.resolve());

vi.mock("../lib/api", () => ({
  browserApi: () => ({
    refresh: () => Promise.resolve({ accessToken: "at", refreshToken: "rt", expiresIn: 900 }),
    me: () => Promise.resolve(me),
    logout: logoutCall,
  }),
  apiTarget: () => "http://sunrise.localhost:4000",
}));

const { AuthProvider, useAuth } = await import("../components/AuthProvider");

/** Reads the session and offers the two ways out of it. */
function Probe() {
  const { user, endSession, logout } = useAuth();
  return (
    <div>
      <span data-testid="who">{user ? user.name : "signed out"}</span>
      <button onClick={() => endSession("/login?reason=password-changed")}>end</button>
      <button onClick={() => void logout()}>logout</button>
    </div>
  );
}

/** A tab holding a session — dev per-tab mode reads this before it will refresh at all. */
beforeEach(() => {
  window.sessionStorage.setItem("hms.dev.refreshToken", "rt");
  replace.mockClear();
  logoutCall.mockClear();
});
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

async function signedIn() {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("A Nurse"));
}

describe("endSession — the client catching up with a session the server already ended", () => {
  it("stops showing a signed-in user", async () => {
    await signedIn();
    screen.getByText("end").click();
    // THE REGRESSION. Navigating while `user` is still set is what made the password change look
    // like it did nothing at all.
    await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("signed out"));
  });

  it("carries the reason, which is also the route guard's hatch", async () => {
    await signedIn();
    screen.getByText("end").click();
    /**
     * Not decoration. `decide()` bounces /login → /dashboard for anyone holding a cookie, and it
     * cannot tell a live cookie from a revoked one. `?reason=` is the only thing that stops the
     * bounce — see middleware.test.ts, "is NOT moved when the client says the cookie is dead".
     */
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login?reason=password-changed"));
  });

  it("does not ask the server to end a session the server already ended", async () => {
    await signedIn();
    screen.getByText("end").click();
    // A password change has already revoked every session. Calling /auth/logout here would be one
    // guaranteed 401 whose only possible outcome is the state change we just made ourselves.
    await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("signed out"));
    expect(logoutCall).not.toHaveBeenCalled();
  });

  it("forgets this tab's stored token, so a reload cannot revive the session", async () => {
    await signedIn();
    screen.getByText("end").click();
    await waitFor(() => expect(window.sessionStorage.getItem("hms.dev.refreshToken")).toBeNull());
  });
});

describe("logout still ends it at both ends", () => {
  it("tells the server, then clears the client", async () => {
    await signedIn();
    screen.getByText("logout").click();
    // The refactor moved the client-side teardown into `endSession`; logout must still do both,
    // or signing out would leave the session alive on every other device.
    await waitFor(() => expect(logoutCall).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("who").textContent).toBe("signed out"));
    expect(replace).toHaveBeenCalledWith("/login");
  });
});
