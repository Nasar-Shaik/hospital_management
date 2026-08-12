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

export interface Harness {
  runtime: MobileRuntime;
  api: FakeApi;
  biometrics: FakeBiometrics;
  secureStore: ReturnType<typeof createMemoryStorage>;
  preferences: ReturnType<typeof createMemoryStorage>;
  /** Every reason a session ended during the test, in order. */
  sessionEndings: SessionEndReason[];
  /** Wire up the routes a successful sign-in needs. Individual tests override what they care about. */
  happyPath(options?: {
    branches?: unknown[];
    canAggregate?: boolean;
    permissions?: string[];
  }): void;
}

export function createHarness(options: { now?: () => number } = {}): Harness {
  const api = createFakeApi();
  const secureStore = createMemoryStorage();
  const preferences = createMemoryStorage();
  const biometrics = createFakeBiometrics();
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
    ...(options.now ? { now: options.now } : {}),
    onSessionEnded: (reason) => sessionEndings.push(reason),
  });

  return {
    runtime,
    api,
    biometrics,
    secureStore,
    preferences,
    sessionEndings,
    happyPath(config = {}) {
      api.on("POST", "/api/v1/auth/login", () => ok(tokenPair()));
      api.on("POST", "/api/v1/auth/refresh", () => ok(tokenPair({ refreshToken: "refresh-2" })));
      api.on("POST", "/api/v1/auth/logout", () => ok({ loggedOut: true }));
      api.on("GET", "/api/v1/auth/me", () =>
        ok({ ...USER, permissions: config.permissions ?? PERMISSIONS }),
      );
      api.on("GET", "/api/v1/me/branches", () =>
        ok({
          branches: config.branches ?? [BRANCH_HYD],
          canAggregate: config.canAggregate ?? false,
        }),
      );
    },
  };
}
