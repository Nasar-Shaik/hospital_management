/**
 * Platform service (Doc 02 A1) — the control plane.
 *
 * This is the module that creates hospitals and issues their first administrator,
 * which until now only a developer with a terminal could do. It is also the most
 * dangerous module in the system: everything here acts across the tenancy
 * boundary, and a mistake does not affect one hospital, it affects all of them.
 *
 * Three rules it holds to, and the reasoning behind each:
 *
 *  1. **No PHI, ever.** Nothing here returns patient data, and no route should be
 *     added that does. An operator manages the CONTAINER (plan, status, seats);
 *     the contents belong to the hospital. "Our support team can read your
 *     patients" fails HIPAA minimum-necessary and, quite reasonably, loses deals.
 *
 *  2. **Everything is audited on BOTH sides.** An action that touches a hospital
 *     is recorded in THAT HOSPITAL'S trail — where its compliance officer can see
 *     it — as well as in ours. The customer watches us; that asymmetry is
 *     deliberate and it is what makes the control plane trustworthy rather than
 *     merely powerful.
 *
 *  3. **The dangerous verbs need SUPER_ADMIN.** Provisioning, suspending and
 *     re-pricing are gated at the route. Most operator work is support work, and
 *     most operators should hold a role that cannot re-price a customer by
 *     accident.
 */
import { createLogger } from "@medicore/logger";
import type { OrganizationType } from "@medicore/permissions";
import { AppError, InvalidCredentialsError } from "../../core/errors/appError.js";
import { hashPassword, verifyPassword, generatePassword } from "../../core/crypto/password.js";
import { signPlatformToken } from "../../core/crypto/jwt.js";
import { runWithContext } from "../../core/context/requestContext.js";
import { getTenantConnection } from "../../core/db/connectionManager.js";
import { recordAudit } from "../../core/audit/auditWriter.js";
import { cacheKeys, cacheSet } from "../../core/redis/redis.js";
import { seedTenantAdmin } from "../../seed/seedTenantAdmin.js";
import { seedNotificationTemplates } from "../../seed/notificationTemplates.js";
import {
  provisionTenant,
  transitionStatus,
  getById as getTenantById,
  listServable,
  type TenantRegistryEntry,
  type TenantStatus,
} from "../tenants/index.js";
import { changePlan, getSubscription, listPlans } from "../subscriptions/index.js";
import * as repo from "./platform.repository.js";
import type { PlatformRole } from "./platform.model.js";

const logger = createLogger({ service: "platform" });

/* ── operator authentication ──────────────────────────────────────────────── */

export interface OperatorSession {
  accessToken: string;
  expiresIn: number;
  operator: {
    id: string;
    email: string;
    name: string;
    roles: PlatformRole[];
    mustChangePassword: boolean;
  };
}

/**
 * Operator login.
 *
 * Same anti-enumeration discipline as the hospital login (ADR-0009): every
 * failure produces the identical HMS-AUTH-001, and the unknown-email path still
 * pays for a hash verification so the timing does not leak who works here. The
 * operator list is a high-value target precisely because it is short.
 */
export async function loginOperator(
  email: string,
  password: string,
  context: { ip?: string; traceId?: string } = {},
): Promise<OperatorSession> {
  const found = await repo.findCredentialByEmail(email);

  // A real hash of a value nobody knows — keeps the "no such operator" path the
  // same cost as the "wrong password" path.
  const decoy = await hashPassword("not-a-real-password-just-a-timing-decoy");
  const ok = await verifyPassword(found?.passwordHash ?? decoy, password);

  if (!found || !ok || found.status !== "active") {
    await repo.recordPlatformAudit({
      action: "platform.login.failed",
      actorEmail: email,
      outcome: "failure",
      meta: { reason: found ? "bad-password-or-disabled" : "unknown-email" },
      ...context,
    });
    throw new InvalidCredentialsError();
  }

  await repo.recordPlatformLogin(found.id);
  await repo.recordPlatformAudit({
    action: "platform.login.succeeded",
    actorId: found.id,
    actorEmail: found.email,
    meta: { roles: found.roles },
    ...context,
  });

  const token = await signPlatformToken({
    userId: found.id,
    email: found.email,
    roles: found.roles,
  });

  return {
    accessToken: token.token,
    expiresIn: token.expiresInSeconds,
    operator: {
      id: found.id,
      email: found.email,
      name: found.name,
      roles: found.roles,
      mustChangePassword: found.mustChangePassword,
    },
  };
}

export async function logoutOperator(jti: string, expiresAt: number): Promise<void> {
  const ttl = Math.max(1, expiresAt - Math.floor(Date.now() / 1000));
  await cacheSet(cacheKeys.revokedToken(jti), 1, ttl);
}

export async function changeOperatorPassword(
  operatorId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const operator = await repo.findPlatformUserById(operatorId);
  if (!operator) throw new InvalidCredentialsError();

  const credential = await repo.findCredentialByEmail(operator.email);
  if (!credential || !(await verifyPassword(credential.passwordHash, currentPassword))) {
    throw new InvalidCredentialsError();
  }

  await repo.setPlatformPassword(operatorId, await hashPassword(newPassword), false);
  await repo.recordPlatformAudit({
    action: "platform.password.changed",
    actorId: operatorId,
    actorEmail: operator.email,
  });
}

/* ── the fleet ────────────────────────────────────────────────────────────── */

export interface HospitalSummary {
  id: string;
  slug: string;
  hospitalName: string;
  status: TenantStatus;
  planCode?: string;
  databaseName: string;
  /** Where this hospital is reachable — assembled here so no UI has to guess. */
  url: string;
}

function hospitalUrl(slug: string, baseDomain: string): string {
  const local = baseDomain === "localhost" || baseDomain.endsWith(".localhost");
  return local ? `http://${slug}.${baseDomain}:3000` : `https://${slug}.${baseDomain}`;
}

export async function listHospitals(baseDomain: string): Promise<HospitalSummary[]> {
  const tenants = await listServable();
  return tenants.map((t) => toSummary(t, baseDomain));
}

function toSummary(tenant: TenantRegistryEntry, baseDomain: string): HospitalSummary {
  return {
    id: tenant.id,
    slug: tenant.slug,
    hospitalName: tenant.hospitalName,
    status: tenant.status,
    ...(tenant.planCode ? { planCode: tenant.planCode } : {}),
    databaseName: tenant.databaseName,
    url: hospitalUrl(tenant.slug, baseDomain),
  };
}

/**
 * Usage and entitlements for one hospital.
 *
 * Reads the TENANT's database (to count seats), which means it needs a tenant
 * context — the one place the control plane legitimately enters a hospital's data
 * store. It counts rows; it never reads them.
 */
export async function getHospital(
  tenantId: string,
  baseDomain: string,
): Promise<HospitalSummary & { usage: unknown; features: string[] }> {
  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new AppError("HMS-GEN-404", 404, "Hospital not found", { tenantId });

  const view = await withTenant(tenant, () => getSubscription(tenant.id));

  return {
    ...toSummary(tenant, baseDomain),
    usage: view.usage,
    features: view.features,
  };
}

/** Binds a tenant connection for the duration of one operation. */
async function withTenant<T>(tenant: TenantRegistryEntry, fn: () => Promise<T>): Promise<T> {
  const connection = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
    ...(tenant.dbUri ? { dbUri: tenant.dbUri } : {}),
  });

  return runWithContext(
    {
      traceId: `platform-${tenant.slug}`,
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      connection,
    },
    fn,
  );
}

/* ── provisioning: what this whole milestone exists for ───────────────────── */

export interface CreateHospitalInput {
  slug: string;
  hospitalName: string;
  planCode: string;
  adminEmail: string;
  adminName?: string;
  /** Omit and one is generated and returned ONCE. */
  adminPassword?: string;
  trial?: boolean;
  /**
   * What kind of hospital this is (ADR-0013 §6). Selects a policy preset; after
   * provisioning it is descriptive only, and no code may branch on it.
   *
   * `government_hospital` → `billingMode: zero_tariff`: the patient pays nothing
   * and every charge is still posted at ₹0, because the hospital must report drug
   * consumption and per-patient cost even when nobody pays.
   */
  organizationType?: OrganizationType;
}

export interface CreateHospitalResult {
  hospital: HospitalSummary;
  admin: { email: string; temporaryPassword?: string };
}

/**
 * Creates a hospital and the administrator who can log into it.
 *
 * This is deliberately ONE operation. A hospital without an administrator is a
 * database nobody can enter — an empty room with the door locked from inside —
 * and every previous route to that state (provision now, seed the admin later)
 * produced exactly that when the second step was forgotten.
 *
 * The generated password is returned exactly once and is marked
 * `mustChangePassword`: whoever created the account has seen it, so it is a
 * handover token, not a credential.
 */
export async function createHospital(
  input: CreateHospitalInput,
  actor: { id: string; email: string },
  context: { ip?: string; traceId?: string },
  baseDomain: string,
): Promise<CreateHospitalResult> {
  const result = await provisionTenant({
    slug: input.slug,
    hospitalName: input.hospitalName,
    planCode: input.planCode,
    trial: input.trial ?? false,
    ...(input.organizationType ? { organizationType: input.organizationType } : {}),
  });

  const tenant = result.tenant;
  const password = input.adminPassword ?? generatePassword();

  const connection = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
    ...(tenant.dbUri ? { dbUri: tenant.dbUri } : {}),
  });

  const admin = await seedTenantAdmin({
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    connection,
    email: input.adminEmail,
    ...(input.adminName ? { name: input.adminName } : {}),
    password,
  });

  /**
   * ── THE SECOND STEP THAT WAS BEING FORGOTTEN ──────────────────────────────
   * Without this, a hospital created through the API has NO notification templates:
   * no welcome message, no appointment confirmation, no reminder, and no
   * critical-result alert. Every one of them fails with "no such template" — logged,
   * and otherwise silent.
   *
   * The CLI provisioning script has always seeded them. This path did not, and the
   * divergence went unnoticed because nothing had yet tried to SEND anything from a
   * hospital provisioned over HTTP. It surfaced the first time a critical potassium
   * had nowhere to go (Orders, ADR-0013 §3).
   *
   * This function's own header warns about exactly this failure — "provision now,
   * seed later, and the second step is forgotten" — which it is, again. The lesson is
   * that a provisioning path is only correct if it is the ONLY one, and these two are
   * now kept in step by this call and by `migrateTenants`, which re-seeds every
   * existing hospital so the ones already provisioned are healed on the next migrate.
   */
  await seedNotificationTemplates(tenant.id, tenant.slug, connection);

  // OUR trail.
  await repo.recordPlatformAudit({
    action: "platform.hospital.created",
    actorId: actor.id,
    actorEmail: actor.email,
    tenantSlug: tenant.slug,
    meta: { plan: input.planCode, adminEmail: input.adminEmail, trial: input.trial ?? false },
    ...context,
  });

  // THEIR trail. The first entry in a hospital's audit log says who created it and
  // who was given the keys — which is exactly where an auditor starts reading.
  await withTenant(tenant, () =>
    recordAudit({
      action: "hospital.provisioned",
      category: "admin",
      resource: "hospital",
      resourceId: tenant.id,
      actorEmail: actor.email,
      meta: {
        by: "platform operator",
        plan: input.planCode,
        firstAdmin: input.adminEmail,
      },
    }),
  );

  logger.info(
    { slug: tenant.slug, plan: input.planCode, operator: actor.email },
    "hospital provisioned from the operator console",
  );

  return {
    hospital: toSummary(tenant, baseDomain),
    admin: {
      email: admin.email,
      ...(input.adminPassword ? {} : { temporaryPassword: password }),
    },
  };
}

/**
 * Suspends or reactivates a hospital.
 *
 * Suspension is not a soft signal: `resolveTenant` refuses any host that maps to
 * a non-servable tenant, so a suspended hospital's staff cannot log in at all.
 * That is the correct behaviour for non-payment and for a security incident, and
 * it is also why it needs SUPER_ADMIN — this button takes a hospital offline.
 */
export async function setHospitalStatus(
  tenantId: string,
  status: TenantStatus,
  actor: { id: string; email: string },
  context: { ip?: string; traceId?: string },
  baseDomain: string,
): Promise<HospitalSummary> {
  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new AppError("HMS-GEN-404", 404, "Hospital not found", { tenantId });

  const updated = await transitionStatus(tenantId, status);

  await repo.recordPlatformAudit({
    action: "platform.hospital.statusChanged",
    actorId: actor.id,
    actorEmail: actor.email,
    tenantSlug: tenant.slug,
    meta: { from: tenant.status, to: status },
    ...context,
  });

  // Recorded in the hospital's own trail too — a customer taken offline is
  // entitled to see who did it and when.
  await withTenant(tenant, () =>
    recordAudit({
      action: "hospital.statusChanged",
      category: "admin",
      resource: "hospital",
      resourceId: tenantId,
      actorEmail: actor.email,
      before: { status: tenant.status },
      after: { status },
      meta: { by: "platform operator" },
    }),
  );

  return toSummary(updated, baseDomain);
}

/**
 * Changes a hospital's edition. The permission `plan:manage` exists for exactly
 * this and is held by NO hospital role — a customer cannot upgrade itself into
 * software it has not paid for (the hole A2 exposed).
 */
export async function setHospitalPlan(
  tenantId: string,
  planCode: string,
  actor: { id: string; email: string },
  context: { ip?: string; traceId?: string },
): Promise<unknown> {
  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new AppError("HMS-GEN-404", 404, "Hospital not found", { tenantId });

  // `changePlan` refuses a downgrade that would strand people (12 staff → a
  // 10-seat plan) and audits itself inside the tenant's trail.
  const view = await withTenant(tenant, () => changePlan(tenantId, planCode));

  await repo.recordPlatformAudit({
    action: "platform.hospital.planChanged",
    actorId: actor.id,
    actorEmail: actor.email,
    tenantSlug: tenant.slug,
    meta: { from: tenant.planCode, to: planCode },
    ...context,
  });

  return view;
}

/**
 * Issues a fresh password for a hospital's administrator — the "we are locked
 * out" call, which today is the single most common reason a customer phones a
 * SaaS vendor.
 *
 * Deliberately re-uses `seedTenantAdmin`, which is idempotent: if the account
 * exists it resets the password, and if it does not it creates it. One code path
 * for "give this hospital an administrator", whatever state it is in.
 */
export async function issueHospitalAdmin(
  tenantId: string,
  input: { email: string; name?: string },
  actor: { id: string; email: string },
  context: { ip?: string; traceId?: string },
): Promise<{ email: string; temporaryPassword: string }> {
  const tenant = await getTenantById(tenantId);
  if (!tenant) throw new AppError("HMS-GEN-404", 404, "Hospital not found", { tenantId });

  const password = generatePassword();

  const connection = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
    ...(tenant.dbUri ? { dbUri: tenant.dbUri } : {}),
  });

  const admin = await seedTenantAdmin({
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    connection,
    email: input.email,
    ...(input.name ? { name: input.name } : {}),
    password,
  });

  await repo.recordPlatformAudit({
    action: "platform.hospital.adminIssued",
    actorId: actor.id,
    actorEmail: actor.email,
    tenantSlug: tenant.slug,
    meta: { adminEmail: input.email, created: admin.created },
    ...context,
  });

  /**
   * The hospital MUST see this. An operator handing out administrator credentials
   * to a hospital is the highest-privilege action the platform supports, and a
   * customer who cannot see it in their own audit trail has no way to detect us
   * doing it improperly. This entry is the check on our own power.
   */
  await withTenant(tenant, () =>
    recordAudit({
      action: "hospital.adminIssued",
      category: "security",
      resource: "user",
      actorEmail: actor.email,
      meta: {
        by: "platform operator",
        adminEmail: input.email,
        created: admin.created,
        note: "a platform operator issued or reset an administrator credential",
      },
    }),
  );

  return { email: admin.email, temporaryPassword: password };
}

export const editions = listPlans;
export const operatorAudit = repo.listPlatformAudit;
export const listOperators = repo.listPlatformUsers;

/* ── operator accounts ────────────────────────────────────────────────────── */

export async function createOperator(
  input: { email: string; name: string; roles: PlatformRole[] },
  actor: { id: string; email: string },
  context: { ip?: string; traceId?: string },
): Promise<{ email: string; temporaryPassword: string }> {
  const password = generatePassword();
  const user = await repo.createPlatformUser({
    email: input.email,
    name: input.name,
    passwordHash: await hashPassword(password),
    roles: input.roles,
    mustChangePassword: true,
  });

  await repo.recordPlatformAudit({
    action: "platform.operator.created",
    actorId: actor.id,
    actorEmail: actor.email,
    meta: { email: input.email, roles: input.roles },
    ...context,
  });

  return { email: user.email, temporaryPassword: password };
}

/** Bootstrap: the very first operator, created by CLI. See scripts/createOperator.ts. */
export async function bootstrapFirstOperator(input: {
  email: string;
  name: string;
  password: string;
}): Promise<{ created: boolean; email: string }> {
  const existing = await repo.countPlatformUsers();
  if (existing > 0) {
    throw new AppError("HMS-VAL-001", 409, "Operators already exist", {
      hint: "Create further operators from the console, not the bootstrap CLI.",
    });
  }

  const user = await repo.createPlatformUser({
    email: input.email,
    name: input.name,
    passwordHash: await hashPassword(input.password),
    roles: ["SUPER_ADMIN"],
    mustChangePassword: false,
  });

  await repo.recordPlatformAudit({
    action: "platform.operator.bootstrapped",
    actorEmail: input.email,
    meta: { note: "the first operator, created from the CLI" },
  });

  return { created: true, email: user.email };
}
