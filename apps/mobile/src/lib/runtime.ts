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
import { QueryClient } from "@tanstack/query-core";
import { createApiClient } from "./apiClient";
import { createAuthController, type AuthController, type SessionEndReason } from "./session";
import { createBranchController, type BranchController } from "./branch";
import { createSessionStore, type SessionStore } from "../state/session";
import { createBranchStore, type BranchStore } from "../state/branch";
import { createConnectivityStore, type ConnectivityStore } from "../state/connectivity";
import type { HospitalProfile } from "./tenant";
import type { Preferences, SecureStorage } from "./storage";
import { createLogger, type Logger } from "./log";
import { shouldRetryRead, shouldRetryMutation, backoffMs } from "./net/retry";

export interface RuntimeDeps {
  profile: HospitalProfile;
  secureStore: SecureStorage;
  preferences: Preferences;
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
  auth: AuthController;
  branches: BranchController;
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

  const queryClient = new QueryClient({
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
    ...(deps.onLicenseState ? { onLicenseState: deps.onLicenseState } : {}),
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
    auth,
    branches,
    queryClient,
    logger,
  };
}
