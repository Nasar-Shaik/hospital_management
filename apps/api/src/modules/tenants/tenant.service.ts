/**
 * Tenant service — provisioning and lifecycle (Doc 04 §7, BUSINESS_WORKFLOWS §13).
 *
 * Provisioning pipeline:
 *   registry entry (status=provisioning) → create `hms_<slug>` DB →
 *   run migrations → [seed: P1B roles/permissions] → status=active
 *
 * Lifecycle transitions are guarded against STATE_MACHINE_CATALOG §11 — an
 * invalid transition throws HMS-STATE-001 rather than corrupting state.
 */
import { getTenantConnection, releaseTenantConnection } from "../../core/db/connectionManager.js";
import type { OrganizationType } from "@medicore/permissions";
import { migrateTenantDb } from "../../core/db/migrations/runner.js";
import { tenantMigrations } from "../../core/db/migrations/tenantMigrations.js";
import { AppError } from "../../core/errors/appError.js";
import { tenantDatabaseName } from "../../config/env.js";
import { seedMainBranch } from "../../seed/mainBranch.js";
import * as repo from "./tenant.repository.js";
import type { TenantRegistryEntry } from "./tenant.repository.js";
import type { TenantLicense, TenantStatus } from "./tenant.model.js";
import {
  applyLicensePatch,
  buildProvisionLicense,
  type LicensePatch,
  type LicenseProvisionInput,
} from "./license.js";

/** Legal transitions — STATE_MACHINE_CATALOG §11. Anything absent here is rejected. */
const ALLOWED_TRANSITIONS: Record<TenantStatus, readonly TenantStatus[]> = {
  provisioning: ["trial", "active"],
  trial: ["active", "expired", "suspended"],
  active: ["suspended"],
  suspended: ["active", "terminated"],
  expired: ["active", "terminated"],
  terminated: ["exported"],
  exported: ["purged"],
  purged: [],
};

export class InvalidTenantTransitionError extends AppError {
  constructor(from: TenantStatus, to: TenantStatus) {
    super("HMS-STATE-001", 422, "Invalid state transition", { from, to });
  }
}

/** Slugs become database names and subdomains — keep them boring and safe. */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/**
 * Slugs the platform needs for itself. **The hostname IS the tenant**, so a
 * hospital slugged `admin` would own `admin.paperlesstech.in` — the operator
 * console's own address. A customer could then serve content on our control-plane
 * hostname, harvest operator logins, or simply break the console for everyone.
 *
 * `www`, `api`, `app` and `mail` are reserved for the same reason: each is a
 * hostname the platform will want, and a tenant that holds it takes it forever
 * (a slug is baked into the database name and cannot be changed without a
 * migration).
 *
 * Refusing a name is cheap. Taking one back from a paying customer is not.
 */
const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "app",
  "www",
  "mail",
  "status",
  "docs",
  "support",
  "billing",
  "console",
  "platform",
  "static",
  "assets",
  "cdn",
  "auth",
  "login",
  "internal",
  "system",
  "test",
]);

export interface ProvisionTenantInput {
  hospitalName: string;
  slug: string;
  customDomain?: string;
  region?: string;
  planCode?: string;
  /**
   * What kind of hospital this is (ADR-0013 §6) — private, government, clinic,
   * diagnostic centre, medical college.
   *
   * It selects a POLICY PRESET (entry, token point, routing, billing mode,
   * pharmacy) and is descriptive from then on. A government hospital gets
   * `billingMode: zero_tariff` — the patient pays nothing and **every charge is
   * still posted at ₹0**, because the hospital must report drug consumption and
   * per-patient cost even when nobody pays. Billing is never switched off by type.
   *
   * This is the ONE moment the question can be asked cleanly. Defaults to
   * `private_hospital` (@medicore/permissions), which is the commonest customer.
   */
  organizationType?: OrganizationType;
  /** Start in trial rather than active (Doc 07 §5.4). */
  trial?: boolean;
  /** Platform cap on branches (ADR-0015). Absent ⇒ single-site (1). */
  maxBranches?: number;
  /**
   * Tenure to create the hospital with (ADR-0016). Absent ⇒ a default trial licence
   * (LICENSE_DEFAULT_TRIAL_DAYS) so a new hospital is never accidentally perpetual.
   */
  license?: LicenseProvisionInput;
}

export interface ProvisionResult {
  tenant: TenantRegistryEntry;
  migrationsApplied: string[];
}

/**
 * Provisions a hospital: creates its dedicated database and converges its schema.
 * Idempotent-ish by design — a slug collision is rejected up front rather than
 * half-creating a tenant.
 */
export async function provisionTenant(input: ProvisionTenantInput): Promise<ProvisionResult> {
  if (!SLUG_PATTERN.test(input.slug)) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      slug: "must be 3–40 chars, lowercase alphanumeric or hyphen, not starting/ending with a hyphen",
    });
  }
  if (RESERVED_SLUGS.has(input.slug)) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      slug: `"${input.slug}" is reserved by the platform — it is a hostname we serve ourselves`,
    });
  }
  const existing = await repo.findBySlug(input.slug);
  if (existing) {
    throw new AppError("HMS-VAL-001", 409, "Slug already taken", { slug: input.slug });
  }

  const tenant = await repo.create({
    hospitalName: input.hospitalName,
    slug: input.slug,
    databaseName: tenantDatabaseName(input.slug),
    ...(input.customDomain ? { customDomain: input.customDomain } : {}),
    ...(input.region ? { region: input.region } : {}),
    ...(input.planCode ? { planCode: input.planCode } : {}),
    ...(input.organizationType ? { organizationType: input.organizationType } : {}),
    ...(typeof input.maxBranches === "number" ? { maxBranches: input.maxBranches } : {}),
    // Always seed a licence: a hospital with no expiry is perpetual, which must be a
    // deliberate operator choice, never the accident of a forgotten field.
    license: buildProvisionLicense(input.license),
  });

  // Creating the DB = connecting to it and writing; Mongo materializes it lazily.
  const db = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
    ...(tenant.dbUri ? { dbUri: tenant.dbUri } : {}),
  });
  const migrationsApplied = await migrateTenantDb(db, tenantMigrations);

  /**
   * ── A HOSPITAL IS NOT PROVISIONED UNTIL IT HAS A SITE (ADR-0015) ────────────
   * The Main Branch is seeded HERE rather than by each caller, because "provision now, seed the
   * rest later" is the trap this codebase has fallen into three times already — notification
   * templates, tariff, and branches — and each time the second step was forgotten on one path
   * while the other kept working. The CLI seeded a Main Branch; the operator console did not;
   * nothing seeded one for a test tenant. There is now one place, and it is the place that
   * cannot be skipped.
   *
   * It matters more than the other two because nothing FAILS without it: `writeBranchId()` finds
   * no branch, returns `undefined`, and every record the hospital writes is branchless — correct
   * looking, and invisible to a branch-confined user the day a second site opens.
   *
   * Idempotent (upsert on `{tenantId, isMain: true}`), and the seed reaches the collection
   * directly so this import does not close a cycle back through the branches module.
   */
  await seedMainBranch(tenant.id, tenant.slug, db);

  const activated = await transitionStatus(tenant.id, input.trial ? "trial" : "active");

  return { tenant: activated, migrationsApplied };
}

/** Guarded lifecycle transition; invalidates the registry cache on write. */
export async function transitionStatus(
  tenantId: string,
  to: TenantStatus,
): Promise<TenantRegistryEntry> {
  const current = await repo.findById(tenantId);
  if (!current) throw new AppError("HMS-TEN-001", 404, "Organization not found", { tenantId });

  if (!ALLOWED_TRANSITIONS[current.status].includes(to)) {
    throw new InvalidTenantTransitionError(current.status, to);
  }

  const updated = await repo.updateStatus(tenantId, to);
  if (!updated) throw new AppError("HMS-TEN-001", 404, "Organization not found", { tenantId });

  // A suspended tenant must stop being served immediately — drop its cached connection.
  if (!["active", "trial"].includes(to)) await releaseTenantConnection(tenantId);

  return updated;
}

/** Brings one tenant's schema up to date (used by the fleet migration job). */
export async function migrateTenant(tenantId: string): Promise<string[]> {
  const tenant = await repo.findById(tenantId);
  if (!tenant) throw new AppError("HMS-TEN-001", 404, "Organization not found", { tenantId });

  const db = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
    ...(tenant.dbUri ? { dbUri: tenant.dbUri } : {}),
  });
  return migrateTenantDb(db, tenantMigrations);
}

/**
 * Raise/lower the platform branch cap (ADR-0015). Lowering below the number of
 * branches a tenant already has does NOT delete anything — the create-time cap
 * (`branches` module, HMS-PLAN-001) simply refuses further branches until it is
 * raised again. `maxBranches` must be at least 1: every hospital has a Main branch.
 */
export async function setLimits(
  tenantId: string,
  limits: { maxBranches?: number },
): Promise<TenantRegistryEntry> {
  if (typeof limits.maxBranches === "number" && limits.maxBranches < 1) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      maxBranches: "must be at least 1 — every hospital has a Main branch",
    });
  }
  const updated = await repo.updateLimits(tenantId, limits);
  if (!updated) throw new AppError("HMS-TEN-001", 404, "Organization not found", { tenantId });
  return updated;
}

/**
 * Set / renew / extend a hospital's licence (ADR-0016) and propagate to the registry
 * cache so the new expiry gates on the very next request. `extendDays` bumps the
 * expiry from the LATER of now / the current expiry, so a renewal never shortens an
 * already-future licence.
 */
export async function setLicense(
  tenantId: string,
  patch: LicensePatch,
): Promise<{ tenant: TenantRegistryEntry; license: TenantLicense }> {
  const current = await repo.findLicense(tenantId);
  const license = applyLicensePatch(current, patch);
  const updated = await repo.updateLicense(tenantId, license);
  if (!updated) throw new AppError("HMS-TEN-001", 404, "Organization not found", { tenantId });
  return { tenant: updated, license };
}

/**
 * Attach, replace, or clear a hospital's custom domain (ADR-0005: the hostname IS the
 * tenant, so a custom domain is just a second host that resolves to it). Refuses a
 * host already owned by another hospital — two tenants cannot share one hostname.
 * Pass `null` to detach. DNS/TLS for the host is an operational step outside this call.
 */
export async function setCustomDomain(
  tenantId: string,
  customDomain: string | null,
): Promise<TenantRegistryEntry> {
  const host = customDomain?.trim().toLowerCase() || null;
  if (host) {
    if (host.includes("/") || host.includes(":") || !host.includes(".")) {
      throw new AppError("HMS-VAL-001", 400, "Validation failed", {
        customDomain: "must be a bare hostname such as care.hospital.com",
      });
    }
    const owner = await repo.customDomainOwner(host);
    if (owner && owner !== tenantId) {
      throw new AppError("HMS-VAL-001", 409, "Domain already in use", {
        customDomain: `"${host}" already routes to another hospital`,
      });
    }
  }
  const updated = await repo.updateCustomDomain(tenantId, host);
  if (!updated) throw new AppError("HMS-TEN-001", 404, "Organization not found", { tenantId });
  return updated;
}

export const getBySlug = repo.findBySlug;
export const getById = repo.findById;
