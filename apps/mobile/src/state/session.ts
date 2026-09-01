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
  /**
   * The MODULE FLAGS this hospital's edition includes — also from `/auth/me` (ADR-0010 layer 1).
   *
   * ── WHY THE PHONE NEEDS BOTH, AND ONLY HAD ONE ──────────────────────────────
   * A permission answers "may this USER"; a feature answers "did this HOSPITAL buy it". Until M4
   * this store read `me.permissions` and dropped `me.features`, so `tabsFor` gated on the first
   * alone — and a nurse holding `nursing:manage` at a clinic with no IPD was offered a Ward tab
   * that could only ever answer `HMS-PLAN-002`. That is D20, which the web shell fixed in August,
   * arriving on the other client.
   *
   * A hint for drawing a tab bar, never a grant: the server's refusal remains the authority, and
   * `isFeatureUnavailable` (lib/net/errors.ts) is what a screen reacts to when it has one.
   */
  features: Set<string>;

  setTokens(accessToken: string, expiresIn: number, now?: number): void;
  setUser(user: AuthenticatedUser): void;
  setPermissions(permissions: string[]): void;
  setFeatures(features: string[]): void;
  signedOut(): void;
}

export type SessionStore = StoreApi<SessionState>;

export function createSessionStore(): SessionStore {
  return createStore<SessionState>((set) => ({
    status: "unknown",
    permissions: new Set<string>(),
    features: new Set<string>(),

    setTokens: (accessToken, expiresIn, now = Date.now()) =>
      set({ accessToken, expiresAt: now + expiresIn * 1000 }),

    setUser: (user) => set({ user, status: "signedIn" }),

    setPermissions: (permissions) => set({ permissions: new Set(permissions) }),

    setFeatures: (features) => set({ features: new Set(features) }),

    /** One transition, used by every sign-out path so none of them can forget a field. */
    signedOut: () =>
      set({
        status: "signedOut",
        accessToken: undefined,
        expiresAt: undefined,
        user: undefined,
        permissions: new Set<string>(),
        // The edition belongs to the HOSPITAL, not the session — but the next person to sign in
        // must learn it from their own `/auth/me` rather than inherit a set read before a plan
        // change that may have happened while nobody was signed in.
        features: new Set<string>(),
      }),
  }));
}

/** Does the signed-in user hold this permission? The UI's only question; the server still decides. */
export function can(state: SessionState, permission: string): boolean {
  return state.permissions.has(permission);
}

/** Did this hospital buy the module? Same standing as `can` — a hint for drawing, not a grant. */
export function hasFeature(state: SessionState, feature: string): boolean {
  return state.features.has(feature);
}
