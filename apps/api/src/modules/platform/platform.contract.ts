/**
 * Control-plane response contracts (Doc 02 A1).
 *
 * These live on `/api/platform/v1` and are answered to an OPERATOR token, which is a different
 * population from a hospital's users entirely — a separate database, no tenant, and no ability to
 * authorize inside a hospital. Documenting them alongside the tenant API is deliberate: an
 * operation nobody can see is an operation nobody reviews.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { PLATFORM_ROLES, PLATFORM_USER_STATUSES } from "./platform.model.js";
import { TENANT_STATUSES } from "../tenants/tenant.model.js";
import { usageLine } from "../subscriptions/subscription.contract.js";
import type {
  CreateHospitalResult,
  HospitalSummary,
  LicenseView,
  OperatorSession,
  getHospital,
} from "./platform.service.js";
import type { Returns } from "../../core/http/contract.js";
import type { PlatformAuditEntry, PlatformUser } from "./platform.repository.js";

const platformRole = z.enum(PLATFORM_ROLES);

export const licenseView = contract(
  "LicenseView",
  z.object({
    state: z.enum(["ACTIVE", "GRACE", "EXPIRED", "PERPETUAL"]),
    /** ISO expiry, or absent when perpetual. */
    expiresAt: z.string().optional(),
    /** ACTIVE: days until expiry. GRACE: days until access is cut. Perpetual: null. */
    daysRemaining: z.number().nullable(),
    plan: z.string().optional(),
  }),
);
export type LicenseViewProof = Proves<Matches<typeof licenseView, LicenseView>>;

const hospitalFields = {
  id: z.string(),
  slug: z.string(),
  hospitalName: z.string(),
  status: z.enum(TENANT_STATUSES),
  planCode: z.string().optional(),
  databaseName: z.string(),
  /** Supported branches (ADR-0015). Absent ⇒ single-site. */
  maxBranches: z.number().optional(),
  /** Custom domain (ADR-0005), when one is attached. */
  customDomain: z.string().optional(),
  /** Tenure (ADR-0016). Perpetual for hospitals with no expiry set. */
  license: licenseView,
  /** Where this hospital is reachable — assembled here so no UI has to guess. */
  url: z.string(),
};

export const hospitalSummary = contract("HospitalSummary", z.object(hospitalFields));
export type HospitalSummaryProof = Proves<Matches<typeof hospitalSummary, HospitalSummary>>;

/** The detail screen: the summary plus what the hospital is entitled to and using. */
export const hospitalDetail = contract(
  "HospitalDetail",
  z.object({ ...hospitalFields, usage: z.array(usageLine), features: z.array(z.string()) }),
);
export type HospitalDetailProof = Proves<
  Matches<typeof hospitalDetail, Returns<typeof getHospital>>
>;

export const createHospitalResult = contract(
  "CreateHospitalResult",
  z.object({
    hospital: hospitalSummary,
    /** The first administrator. The password is shown once and never returned again. */
    admin: z.object({ email: z.string(), temporaryPassword: z.string().optional() }),
  }),
);
export type CreateHospitalResultProof = Proves<
  Matches<typeof createHospitalResult, CreateHospitalResult>
>;

export const operatorSession = contract(
  "OperatorSession",
  z.object({
    accessToken: z.string(),
    expiresIn: z.number(),
    operator: z.object({
      id: z.string(),
      email: z.string(),
      name: z.string(),
      roles: z.array(platformRole),
      mustChangePassword: z.boolean(),
    }),
  }),
);
export type OperatorSessionProof = Proves<Matches<typeof operatorSession, OperatorSession>>;

/** What `/auth/me` answers — read off the token, so it carries no name or status. */
export const operatorIdentity = contract(
  "OperatorIdentity",
  z.object({ id: z.string(), email: z.string(), roles: z.array(platformRole) }),
);

export const platformUser = contract(
  "PlatformUser",
  z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    roles: z.array(platformRole),
    status: z.enum(PLATFORM_USER_STATUSES),
    mfaEnabled: z.boolean(),
    mustChangePassword: z.boolean(),
    lastLoginAt: z.string().optional(),
  }),
);
export type PlatformUserProof = Proves<Matches<typeof platformUser, PlatformUser>>;

export const platformAuditEntry = contract(
  "PlatformAuditEntry",
  z.object({
    id: z.string(),
    at: z.string(),
    actorEmail: z.string().optional(),
    action: z.string(),
    tenantSlug: z.string().optional(),
    outcome: z.enum(["success", "failure"]),
    meta: z.record(z.unknown()).optional(),
    ip: z.string().optional(),
  }),
);
export type PlatformAuditEntryProof = Proves<
  Matches<typeof platformAuditEntry, PlatformAuditEntry>
>;

/** A newly created login — the password appears once, on this response only. */
export const createdCredential = contract(
  "CreatedCredential",
  z.object({ email: z.string(), temporaryPassword: z.string() }),
);

export const operatorLoggedOutAck = contract(
  "OperatorLoggedOutAck",
  z.object({ loggedOut: z.literal(true) }),
);
export const operatorPasswordChangedAck = contract(
  "OperatorPasswordChangedAck",
  z.object({ passwordChanged: z.literal(true) }),
);
