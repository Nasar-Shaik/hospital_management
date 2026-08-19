/**
 * A signed-out runtime wired to a fake transport and an in-memory Keychain, plus the fixtures a
 * happy path needs. One per test — nothing is shared, so ordering cannot matter.
 */
import { createRuntime, type MobileRuntime } from "../../src/lib/runtime";
import { createMemoryStorage } from "../../src/lib/storage";
import { createProfile } from "../../src/lib/tenant";
import type { SessionEndReason } from "../../src/lib/session";
import type { BiometricAuthenticator } from "../../src/lib/storage";
import { createFakeApi, ok, type FakeApi } from "./fakeApi";
import type { PushCredential, PushPayload, PushRegistrar } from "../../src/lib/push";

export const SLUG = "apollo";
export const PASSWORD = "V4lid!Password#2026";

export const USER = {
  id: "user-1",
  email: "dr.rao@apollo.test",
  name: "Dr Rao",
  roles: ["DOCTOR"],
  branchIds: [],
  mfaEnabled: false,
  mustChangePassword: false,
};

export const PERMISSIONS = ["patient:read", "encounter:read", "order:read"];

/** A hospital edition that includes the modules the default permissions reach. */
export const FEATURES = ["module.ops.opd", "module.ops.appointments", "module.clinical.emr"];

export const BRANCH_HYD = {
  id: "branch-hyd",
  name: "Hyderabad",
  code: "HYD",
  status: "active" as const,
  isMain: true,
  timezone: "Asia/Kolkata",
};

export const BRANCH_CHN = {
  id: "branch-chn",
  name: "Chennai",
  code: "CHN",
  status: "active" as const,
  isMain: false,
  timezone: "Asia/Kolkata",
};

export function tokenPair(overrides: Partial<{ accessToken: string; refreshToken: string }> = {}) {
  return {
    accessToken: overrides.accessToken ?? "access-1",
    refreshToken: overrides.refreshToken ?? "refresh-1",
    expiresIn: 900,
    user: USER,
  };
}

/**
 * A biometric sensor that does exactly what a test tells it to.
 *
 * This is the whole reason `BiometricAuthenticator` is a port: no simulator will fail a scan five
 * times on request, and the attempt ladder is the part of the lock most worth proving.
 */
export interface FakeBiometrics extends BiometricAuthenticator {
  /** Queue the outcome of the next `authenticate()`. Falls back to `answer` when empty. */
  next(...results: Awaited<ReturnType<BiometricAuthenticator["authenticate"]>>[]): void;
  /** The standing answer once the queue is empty. */
  answer: Awaited<ReturnType<BiometricAuthenticator["authenticate"]>>;
  capabilityIs(capability: { hasHardware: boolean; isEnrolled: boolean }): void;
  /** Every prompt shown, so a test can assert the user was told what they were unlocking. */
  prompts: string[];
}

export function createFakeBiometrics(): FakeBiometrics {
  const queue: Awaited<ReturnType<BiometricAuthenticator["authenticate"]>>[] = [];
  let capability = { hasHardware: true, isEnrolled: true };

  const fake: FakeBiometrics = {
    answer: "success",
    prompts: [],
    next: (...results) => queue.push(...results),
    capabilityIs: (next) => {
      capability = next;
    },
    capability: () => Promise.resolve(capability),
    authenticate: (reason) => {
      fake.prompts.push(reason);
      return Promise.resolve(queue.shift() ?? fake.answer);
    },
  };
  return fake;
}

/**
 * A notification service that does exactly what a test tells it to (M4).
 *
 * The whole reason `PushRegistrar` is a port. No simulator will decline a permission on request,
 * rotate a token mid-session, or deliver a payload from a build two versions newer — and those
 * are the three situations the registration lifecycle has to survive.
 */
export interface FakePush extends PushRegistrar {
  /** What `getCredential()` answers. `undefined` is the ordinary "no push here" case. */
  credential: PushCredential | undefined;
  /** Make the OS call throw, the way a revoked permission can. */
  failNext: boolean;
  /** Deliver a tap to whatever the app subscribed with. */
  open(payload: PushPayload): void;
  /** Every subscription that is still live — so a test can prove the shell unsubscribes. */
  subscribers: number;
}

export function createFakePush(): FakePush {
  const handlers = new Set<(payload: PushPayload) => void>();
  const fake: FakePush = {
    credential: { token: "ExponentPushToken[test]", platform: "ios" },
    failNext: false,
    get subscribers() {
      return handlers.size;
    },
    getCredential: () => {
      if (fake.failNext) {
        fake.failNext = false;
        return Promise.reject(new Error("permission revoked"));
      }
      return Promise.resolve(fake.credential);
    },
    onOpened: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    open: (payload) => handlers.forEach((handler) => handler(payload)),
  };
  return fake;
}

export interface Harness {
  runtime: MobileRuntime;
  api: FakeApi;
  biometrics: FakeBiometrics;
  push: FakePush;
  secureStore: ReturnType<typeof createMemoryStorage>;
  preferences: ReturnType<typeof createMemoryStorage>;
  /** Every reason a session ended during the test, in order. */
  sessionEndings: SessionEndReason[];
  /** Wire up the routes a successful sign-in needs. Individual tests override what they care about. */
  happyPath(options?: {
    branches?: unknown[];
    canAggregate?: boolean;
    permissions?: string[];
    /** The hospital's edition, as `/auth/me` reports it (M4). */
    features?: string[];
  }): void;
}

export function createHarness(options: { now?: () => number } = {}): Harness {
  const api = createFakeApi();
  const secureStore = createMemoryStorage();
  const preferences = createMemoryStorage();
  const biometrics = createFakeBiometrics();
  const push = createFakePush();
  const sessionEndings: SessionEndReason[] = [];

  const runtime = createRuntime({
    profile: createProfile(SLUG, {
      tenantDomain: "paperlesstech.in",
      insecureTransportAllowed: false,
    }),
    secureStore,
    preferences,
    fetchImpl: api.fetchImpl,
    biometrics,
    push,
    ...(options.now ? { now: options.now } : {}),
    onSessionEnded: (reason) => sessionEndings.push(reason),
  });

  return {
    runtime,
    api,
    biometrics,
    push,
    secureStore,
    preferences,
    sessionEndings,
    happyPath(config = {}) {
      api.on("POST", "/api/v1/auth/login", () => ok(tokenPair()));
      api.on("POST", "/api/v1/auth/refresh", () => ok(tokenPair({ refreshToken: "refresh-2" })));
      api.on("POST", "/api/v1/auth/logout", () => ok({ loggedOut: true }));
      api.on("GET", "/api/v1/auth/me", () =>
        ok({
          ...USER,
          permissions: config.permissions ?? PERMISSIONS,
          features: config.features ?? FEATURES,
        }),
      );
      api.on("POST", "/api/v1/me/devices", () =>
        ok({
          id: "device-1",
          userId: USER.id,
          platform: "ios",
          active: true,
          lastSeenAt: "2026-08-20T09:00:00.000Z",
          createdAt: "2026-08-20T09:00:00.000Z",
        }),
      );
      api.on("DELETE", "/api/v1/me/devices/device-1", () => ok({ released: true }));
      api.on("GET", "/api/v1/me/branches", () =>
        ok({
          branches: config.branches ?? [BRANCH_HYD],
          canAggregate: config.canAggregate ?? false,
        }),
      );
    },
  };
}
