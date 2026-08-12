/**
 * The composition root — where the client, the stores and the two controllers are wired.
 *
 * ── WHY A FACTORY AND NOT MODULE-LEVEL SINGLETONS ───────────────────────────
 * Singletons would make the wiring implicit, un-substitutable and impossible to test twice in one
 * process. A factory makes the dependency graph a value: the app builds one at startup and hands
 * it down through a provider; a test builds one per case with an in-memory store and an injected
 * `fetch`, and gets the REAL client, the REAL controllers and the REAL stores — nothing about the
 * architecture is mocked away, only the two edges (transport, disk) that a phone owns.
 *
 * Switching hospital or signing out builds a NEW runtime rather than mutating this one, which is
 * what guarantees no state survives the boundary.
 *
 * ── THE CIRCULARITY, RESOLVED DELIBERATELY ──────────────────────────────────
 * The client needs `onUnauthorized`, which needs the auth controller, which needs the client. It
 * is broken with a late-bound reference rather than a setter on the client: the callback closes
 * over a variable assigned two statements later, so the client is fully formed and immutable, and
 * the "not yet ready" window is nil because no request can be issued before this function returns.
 */
import type { ApiClient, DeprecationNotice, LicenseHeader } from "@medicore/api-client";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/query-core";
import { createApiClient } from "./apiClient";
import { createAuthController, type AuthController, type SessionEndReason } from "./session";
import { createBranchController, type BranchController } from "./branch";
import { createSessionStore, type SessionStore } from "../state/session";
import { createBranchStore, type BranchStore } from "../state/branch";
import { createConnectivityStore, type ConnectivityStore } from "../state/connectivity";
import { createLicenceStore, type LicenceStore } from "../state/licence";
import { createLockStore, type LockStore } from "../state/lock";
import { isLicenceRefusal } from "./licence";
import type { HospitalProfile } from "./tenant";
import {
  storageKeys,
  type BiometricAuthenticator,
  type Preferences,
  type SecureStorage,
} from "./storage";
import { readLockPreference } from "./lock";
import { createLogger, type Logger } from "./log";
import { shouldRetryRead, shouldRetryMutation, backoffMs } from "./net/retry";

export interface RuntimeDeps {
  profile: HospitalProfile;
  secureStore: SecureStorage;
  preferences: Preferences;
  /**
   * The device's biometric prompt (M2 K). Optional: a runtime built without one simply never
   * offers the biometric door, and the lock falls back to the password path — which is the same
   * behaviour as a phone with no sensor, and the reason tests need no device.
   */
  biometrics?: BiometricAuthenticator;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  now?: () => number;
  /** The app navigates to `(auth)` here. Tests assert on it. */
  onSessionEnded?: (reason: SessionEndReason) => void;
  onLicenseState?: (state: LicenseHeader | null) => void;
}

export interface MobileRuntime {
  profile: HospitalProfile;
  api: ApiClient;
  session: SessionStore;
  branch: BranchStore;
  connectivity: ConnectivityStore;
  /**
   * The hospital's subscription, as the server's own responses describe it (M2 L). Read by the
   * write guard and by the renewal banner — never by anything that enforces.
   */
  licence: LicenceStore;
  /** Whether the app is showing anything at all (M2 K). Read by the root gate. */
  lock: LockStore;
  auth: AuthController;
  branches: BranchController;
  /**
   * The device prompt, or `undefined` when this build has none. The gate checks for it rather
   * than assuming — see `unlockMethod`.
   */
  biometrics?: BiometricAuthenticator;
  /** Non-secret settings. Exposed so the lock's preference can be written from Settings (M2 K). */
  preferences: Preferences;
  /** Owned here so that no sign-out or branch switch can forget to clear it. */
  queryClient: QueryClient;
  logger: Logger;
}

export function createRuntime(deps: RuntimeDeps): MobileRuntime {
  const logger = deps.logger ?? createLogger({ verbose: false });
  const now = deps.now ?? Date.now;
  const session = createSessionStore();
  const branch = createBranchStore();
  const connectivity = createConnectivityStore();
  const licence = createLicenceStore();
  const lock = createLockStore();

  /**
   * The lock preference, read once at startup (M2 K).
   *
   * Fire and forget, and deliberately NOT awaited by anything: the gate only matters on a RESUME,
   * which is minutes away at the earliest, so a disk read has no reason to sit in front of the
   * first frame. A failed read leaves the gate off — the state a user can always recover from in
   * Settings, where a gate stuck ON with no enrolled finger would be a locked-out doctor.
   */
  void deps.preferences
    .get(storageKeys.screenLock(deps.profile.slug))
    .then((stored) => lock.getState().setEnabled(readLockPreference(stored)))
    .catch(() => undefined);

  /**
   * Connectivity is observed at the transport seam rather than from a native module, because the
   * question the UI asks is "will a save arrive?", and only an actual request answers that. See
   * `state/connectivity.ts`. Wrapping here also means every request is covered — there is no
   * second code path that could bypass it.
   */
  const baseFetch: typeof fetch =
    // Bound, not passed by reference: an unbound `globalThis.fetch` throws "Illegal invocation"
    // once it is called as a bare function on some engines.
    deps.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));

  const instrumentedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const response = await baseFetch(input, init);
      connectivity.getState().reachable(now());
      return response;
    } catch (error) {
      connectivity.getState().unreachable(now());
      throw error;
    }
  }) as typeof fetch;

  /**
   * ── WHERE THE APP LEARNS ITS LICENCE HAS LAPSED (M2 L) ────────────────────
   * `HMS-TEN-005` is the ONLY way it can: there is no `EXPIRED` header, because the response that
   * would carry one is refused before any header is set (`lib/licence.ts` sets out the two
   * channels). So the refusal has to be caught where every request's failure passes, and these two
   * caches are that place — one for reads, one for writes, both owned here rather than by a screen.
   *
   * `served()` is taken from successful READS only. Several clinical mutations deliberately RESOLVE
   * on failure — `attemptWardNote` answers "not saved" rather than throwing, because a doctor needs
   * a classified outcome and not an exception — so a mutation's success is not evidence that the
   * server is serving this hospital, and using it as such would clear a real block.
   */
  const queryCache = new QueryCache({
    onSuccess: () => licence.getState().served(),
    onError: (error) => {
      if (isLicenceRefusal(error)) licence.getState().refuse();
    },
  });

  const mutationCache = new MutationCache({
    onError: (error) => {
      if (isLicenceRefusal(error)) licence.getState().refuse();
    },
  });

  const queryClient = new QueryClient({
    queryCache,
    mutationCache,
    defaultOptions: {
      queries: {
        retry: shouldRetryRead,
        retryDelay: (attempt) => backoffMs(attempt),
        // Lists tolerate half a minute of staleness; anything that must be exact (a bill, a
        // dispense quantity) overrides this at the call site with `staleTime: 0`.
        staleTime: 30_000,
        // Refetch on reconnect, not on every window focus: on a phone "focus" fires every time
        // the user glances at the app, and a ward list does not need a round trip per glance.
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
      },
      mutations: { retry: shouldRetryMutation },
    },
  });

  const api = createApiClient({
    profile: deps.profile,
    getAccessToken: () => session.getState().accessToken,
    /**
     * Read live on EVERY request. Note it returns `undefined` until `/me/branches` has been read
     * (`validated`), so a remembered branch can never be sent before it has been re-checked — the
     * rule in M0 §7 is enforced here, at the only place the header is produced.
     */
    getActiveBranch: () =>
      branch.getState().validated ? branch.getState().activeBranchId : undefined,
    onUnauthorized: () => auth.refreshOnce(),
    /**
     * The warning channel (M2 L). Every served response carries the hospital's licence state, so
     * this is fed on every call with no poll and no dedicated endpoint. `null` means the response
     * had no licence headers, which means perpetual — the store treats it as such.
     *
     * `deps.onLicenseState` is still called afterwards so a host can observe it too; the store is
     * wired unconditionally, because a hook nobody passed was exactly how M1 ended up with a write
     * guard that assumed the licence was fine.
     */
    onLicenseState: (state: LicenseHeader | null) => {
      licence.getState().observed(state);
      deps.onLicenseState?.(state);
    },
    onDeprecation: (notice: DeprecationNotice, path: string) =>
      logger.warn("endpoint is being retired", { route: path, code: notice.sunsetAt ?? undefined }),
    fetchImpl: instrumentedFetch,
  });

  const branches = createBranchController({
    api,
    store: branch,
    preferences: deps.preferences,
    slug: deps.profile.slug,
    /**
     * The safe strategy from M0 §7/§10: drop everything rather than reason about which keys are
     * branch-sensitive. Every branch-scoped key begins `[tenant, branch]`, so a selective
     * invalidation is possible — and deliberately not done in M1, because "which of these is
     * safe to keep?" is a question worth answering with evidence, not with a guess.
     */
    onBranchChanged: () => queryClient.clear(),
  });

  /**
   * Declared after `api` and referenced by its `onUnauthorized` closure — the late binding that
   * breaks the circularity described in the header. The closure cannot run before this statement,
   * because no request can be issued until `createRuntime` returns.
   */
  const auth: AuthController = createAuthController({
    api,
    store: session,
    secureStore: deps.secureStore,
    slug: deps.profile.slug,
    ...(deps.now ? { now: deps.now } : {}),

    /** Everything that must be true again after a session ends, in one place. */
    onSessionEnded: (reason) => {
      branch.getState().reset();
      /**
       * The gate comes DOWN on sign-out, always. The next screen is the login form: a lock in
       * front of it would demand a fingerprint to reach a password field, and on a device whose
       * enrolment has just been removed that is an app nobody can open.
       */
      lock.getState().reset();
      /**
       * The licence belongs to the HOSPITAL, not the session — but the next person to sign in
       * deserves to learn it from their own responses rather than inherit a refusal recorded
       * before a renewal that may have happened while nobody was signed in.
       */
      licence.getState().reset();
      queryClient.clear();
      logger.info("session ended", { tenantSlug: deps.profile.slug, code: reason });
      deps.onSessionEnded?.(reason);
    },

    /**
     * What "signed in" actually means. The login response carries a user but NOT permissions —
     * only `/auth/me` does — so the app is not usable until this has run. The branch load is part
     * of the same step for the same reason: a shell rendered before either would show the wrong
     * tabs, or the previous site's data, for as long as the round trip takes.
     */
    bootstrap: async () => {
      const me = await api.me();
      session.getState().setUser(me);
      session.getState().setPermissions(me.permissions ?? []);
      await branches.restore(me.id);
    },
  });

  return {
    profile: deps.profile,
    api,
    session,
    branch,
    connectivity,
    licence,
    lock,
    auth,
    branches,
    ...(deps.biometrics ? { biometrics: deps.biometrics } : {}),
    preferences: deps.preferences,
    queryClient,
    logger,
  };
}
