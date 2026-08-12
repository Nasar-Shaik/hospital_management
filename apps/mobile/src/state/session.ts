/**
 * Session state — who is signed in, and the access token (M0 §5, §10).
 *
 * ── `createStore`, NOT `create` ─────────────────────────────────────────────
 * The vanilla store from `zustand/vanilla` has no React dependency, which is what lets the session
 * lifecycle be tested in Node with no renderer. The React layer binds to it with `useStore`.
 *
 * ── THE ACCESS TOKEN LIVES HERE AND NOWHERE ELSE ────────────────────────────
 * Memory only. Not in secure storage, not persisted, not written to a log. A cold start costs one
 * refresh round-trip, which is the correct price: a persisted access token is a bearer credential
 * sitting on a device that may be rooted, and its whole security model assumes a short life.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import type { AuthenticatedUser } from "@medicore/api-client";

export type SessionStatus =
  /** Before the first bootstrap has finished — render a splash, not a login screen. */
  "unknown" | "signedOut" | "signedIn";

export interface SessionState {
  status: SessionStatus;
  /** MEMORY ONLY. */
  accessToken?: string;
  /** When the current access token stops being accepted — drives the proactive refresh timer. */
  expiresAt?: number;
  user?: AuthenticatedUser;
  /**
   * From `/auth/me`. The login response does not carry permissions — only `/auth/me` does — so a
   * session is not fully bootstrapped until this is populated.
   */
  permissions: Set<string>;

  setTokens(accessToken: string, expiresIn: number, now?: number): void;
  setUser(user: AuthenticatedUser): void;
  setPermissions(permissions: string[]): void;
  signedOut(): void;
}

export type SessionStore = StoreApi<SessionState>;

export function createSessionStore(): SessionStore {
  return createStore<SessionState>((set) => ({
    status: "unknown",
    permissions: new Set<string>(),

    setTokens: (accessToken, expiresIn, now = Date.now()) =>
      set({ accessToken, expiresAt: now + expiresIn * 1000 }),

    setUser: (user) => set({ user, status: "signedIn" }),

    setPermissions: (permissions) => set({ permissions: new Set(permissions) }),

    /** One transition, used by every sign-out path so none of them can forget a field. */
    signedOut: () =>
      set({
        status: "signedOut",
        accessToken: undefined,
        expiresAt: undefined,
        user: undefined,
        permissions: new Set<string>(),
      }),
  }));
}

/** Does the signed-in user hold this permission? The UI's only question; the server still decides. */
export function can(state: SessionState, permission: string): boolean {
  return state.permissions.has(permission);
}
