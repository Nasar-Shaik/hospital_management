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
import * as repo from "./tenant.repository.js";
import type { TenantRegistryEntry } from "./tenant.repository.js";
import type { TenantStatus } from "./tenant.model.js";

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
  });

  // Creating the DB = connecting to it and writing; Mongo materializes it lazily.
  const db = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
    ...(tenant.dbUri ? { dbUri: tenant.dbUri } : {}),
  });
  const migrationsApplied = await migrateTenantDb(db, tenantMigrations);

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

export const getBySlug = repo.findBySlug;
export const getById = repo.findById;
