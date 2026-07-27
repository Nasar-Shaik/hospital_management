/**
 * RBAC MATRIX SUITE — release-gating (ADR-0010, Doc 05 §4.2, RISK_REGISTER).
 *
 * ── WHAT THIS DEFENDS, AND WHY IT EXISTS NOW ─────────────────────────────────
 * Authorization is the only thing standing between a hospital's patient records
 * and everybody else. It is enforced by three layers (entitlement → permission →
 * row scope), and every one of them is a per-route decision a developer has to
 * remember to make. The failure mode is silent by construction: a route with no
 * `authorize()` does not throw, does not warn, and looks fine in review — it just
 * quietly answers everyone.
 *
 * This project has now shipped TWO authorization bugs that were found by accident
 * rather than by testing, and both are the kind this suite catches mechanically:
 *
 *   A2  `plan:manage` sat in the wrong permission group, so TENANT_ADMIN inherited
 *       it and a hospital could upgrade ITSELF to Enterprise — for free.
 *   P2  `patients` became the first `branch`-scoped resource, and an empty
 *       `branchIds` meant "everywhere" to RBAC and "nowhere" to the row filter.
 *       The patient list came back EMPTY for every user in every hospital.
 *
 * Neither was caught by review. Both would have been caught here, on the first run.
 *
 * ── THE PART THAT MATTERS MOST IS THE COVERAGE TEST ──────────────────────────
 * Any suite can assert that a route we thought about is protected. The hard problem
 * is the route nobody thought about. So this suite does not hold a hand-written list
 * of routes — it reads the SHIPPED Express app (`routeInventory`) and asserts:
 *
 *   1. Every `/api/v1` route is either declared PUBLIC here, or carries both
 *      `authenticate()` and a permission. A new unprotected route FAILS CI.
 *   2. Every protected route's permission exists in the catalog. A typo'd constant
 *      cannot silently create a permission nobody holds (or worse, everybody does).
 *
 * That is the difference between testing our authorization and testing the
 * authorization we remembered to test.
 *
 * ── AND THE EXPECTATIONS ARE DERIVED, NOT TYPED ──────────────────────────────
 * The per-role expectations below are computed FROM `DEFAULT_ROLES` in the
 * permission catalog — the same data the app seeds from. A hand-written expectation
 * table would be a second source of truth that drifts, and a test that drifts
 * toward the code it is testing eventually asserts nothing. Here, if someone widens
 * a role, the expected outcome changes with it AND the guard tests below (which
 * assert specific, deliberate facts — "a nurse cannot create users", "a tenant admin
 * cannot re-price its own hospital") fail loudly.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createLogger } from "@medicore/logger";
import { DEFAULT_ROLES, PERMISSIONS, ALL_PERMISSION_CODES } from "@medicore/permissions";
import { assertMongoReachable, dropDatabases, TEST_MONGO_URI } from "./test/mongoTestEnv.js";
import { assertRedisReachable, flushTestCache, testRedisUrl } from "./test/redisTestEnv.js";

process.env.MONGO_URI = TEST_MONGO_URI;
process.env.REDIS_URL = testRedisUrl("rbac");
process.env.MONGO_MASTER_DB = "test_rbac_master";
process.env.TENANT_BASE_DOMAIN = "medicore.test";

const { createApp } = await import("./app.js");
const { routeInventory } = await import("./core/http/routeInventory.js");
const { provisionTenant } = await import("./modules/tenants/index.js");
const { getTenantConnection, closeAllTenantConnections } =
  await import("./core/db/connectionManager.js");
const { closeMaster } = await import("./core/db/masterDb.js");
const { closeRedis } = await import("./core/redis/redis.js");
const { runWithContext } = await import("./core/context/requestContext.js");
const { createUser, transitionStatus } = await import("./modules/users/index.js");
const { assignRoleByCode, seedRbac } = await import("./modules/rbac/index.js");
const { setPassword } = await import("./modules/auth/index.js");
const { signPlatformToken } = await import("./core/crypto/jwt.js");

const SLUG_A = "test-rbac-apollo";
const SLUG_B = "test-rbac-sunshine";
const DB_A = `hms_${SLUG_A}`;
const DB_B = `hms_${SLUG_B}`;
const HOST_A = `${SLUG_A}.medicore.test`;
const HOST_B = `${SLUG_B}.medicore.test`;

const PASSWORD = "V4lid!Password#2026";

const app = createApp(createLogger({ service: "rbac-int-test" }));

interface Tenant {
  id: string;
  slug: string;
  databaseName: string;
}
let tenantA: Tenant;
let tenantB: Tenant;

/**
 * The `/api/v1` routes that may be reached with NO token.
 *
 * This list is the entire unauthenticated attack surface of a hospital, and it is
 * declared here on purpose: adding a route to it is a deliberate, reviewable act,
 * not something that happens by forgetting a middleware.
 */
const PUBLIC_ROUTES = new Set([
  "POST /api/v1/auth/login",
  "POST /api/v1/auth/refresh",
  "POST /api/v1/auth/mfa/verify",
  // Password reset is reached with no session, by definition — the user cannot log in.
  "POST /api/v1/auth/forgot-password",
  "POST /api/v1/auth/reset-password",
  // The hospital's public website content — served to a logged-out visitor (resolved by host).
  "GET /api/v1/site",
]);

/**
 * Routes behind `authenticate()` that intentionally carry NO permission: things
 * every signed-in person may do to their OWN account. A permission here would be
 * absurd (you would need `session:read` to see your own sessions), but the list is
 * still explicit — "no permission required" must be a decision, never a gap.
 */
const SELF_SERVICE_ROUTES = new Set([
  "POST /api/v1/auth/logout",
  "GET /api/v1/auth/me",
  "POST /api/v1/auth/change-password",
  "GET /api/v1/auth/sessions",
  "DELETE /api/v1/auth/sessions/:id",
  "POST /api/v1/auth/mfa/setup",
  "POST /api/v1/auth/mfa/activate",
  "POST /api/v1/auth/mfa/disable",
  // A clinician's OWN activity for the day — self-scoped to the caller, so no permission (you can
  // always see what you did). Authenticated, deliberately unpermissioned. See reporting.routes.ts.
  "GET /api/v1/reports/my-activity",
  // The branch switcher — the caller's OWN allowed branches, like `/auth/me`. Self-service,
  // authenticated, deliberately unpermissioned (ADR-0015). See branch.routes.ts.
  "GET /api/v1/me/branches",
]);

/** A concrete, callable request for each protected route — the matrix's probes. */
interface Probe {
  method: "get" | "post" | "patch" | "put" | "delete";
  /** A real URL (params substituted). */
  url: string;
  body?: Record<string, unknown>;
}

/**
 * One probe per protected route. Keyed by the SAME `METHOD /path` string the route
 * inventory produces, which is what lets the coverage test prove every route has one.
 *
 * The bodies are deliberately valid-ish but harmless. We are testing the
 * authorization decision, which happens BEFORE the handler — a 400 from validation
 * would still prove we got past `authorize`, and a 403 proves we did not. Nothing
 * here needs to succeed for the matrix to be meaningful; it needs to be *reached*.
 */
const PROBES: Record<string, Probe> = {
  "GET /api/v1/permissions": { method: "get", url: "/api/v1/permissions" },
  "GET /api/v1/roles": { method: "get", url: "/api/v1/roles" },
  "GET /api/v1/roles/:id": { method: "get", url: "/api/v1/roles/64b7f0000000000000000001" },
  "POST /api/v1/roles": { method: "post", url: "/api/v1/roles", body: { code: "X", name: "X" } },
  "PUT /api/v1/roles/:id/permissions": {
    method: "put",
    url: "/api/v1/roles/64b7f0000000000000000001/permissions",
    body: { permissions: [] },
  },
  "DELETE /api/v1/roles/:id": {
    method: "delete",
    url: "/api/v1/roles/64b7f0000000000000000001",
  },
  "POST /api/v1/users/:id/roles": {
    method: "post",
    url: "/api/v1/users/64b7f0000000000000000001/roles",
    body: { role: "NURSE" },
  },
  "DELETE /api/v1/users/:id/roles/:roleCode": {
    method: "delete",
    url: "/api/v1/users/64b7f0000000000000000001/roles/NURSE",
  },
  "GET /api/v1/users": { method: "get", url: "/api/v1/users" },
  "GET /api/v1/users/:id": { method: "get", url: "/api/v1/users/64b7f0000000000000000001" },
  "POST /api/v1/users": {
    method: "post",
    url: "/api/v1/users",
    body: { email: "probe@x.test", name: "Probe" },
  },
  "PATCH /api/v1/users/:id": {
    method: "patch",
    url: "/api/v1/users/64b7f0000000000000000001",
    body: { name: "Probe" },
  },
  "POST /api/v1/users/:id/status": {
    method: "post",
    url: "/api/v1/users/64b7f0000000000000000001/status",
    body: { status: "disabled" },
  },
  "POST /api/v1/users/:id/reset-password": {
    method: "post",
    url: "/api/v1/users/64b7f0000000000000000001/reset-password",
    body: {},
  },
  "GET /api/v1/subscription": { method: "get", url: "/api/v1/subscription" },
  "GET /api/v1/plans": { method: "get", url: "/api/v1/plans" },
  "POST /api/v1/subscription/plan": {
    method: "post",
    url: "/api/v1/subscription/plan",
    body: { planCode: "PLAN_CLINIC" },
  },
  "POST /api/v1/feature-flags": {
    method: "post",
    url: "/api/v1/feature-flags",
    body: { feature: "module.ops.appointments", enabled: true },
  },
  "GET /api/v1/audit": { method: "get", url: "/api/v1/audit" },
  "GET /api/v1/audit/export": { method: "get", url: "/api/v1/audit/export" },
  "GET /api/v1/audit/integrity": { method: "get", url: "/api/v1/audit/integrity" },
  "GET /api/v1/patients": { method: "get", url: "/api/v1/patients" },
  "GET /api/v1/patients/by-uhid/:uhid": { method: "get", url: "/api/v1/patients/by-uhid/UH000001" },
  "GET /api/v1/patients/:id": {
    method: "get",
    url: "/api/v1/patients/64b7f0000000000000000001",
  },
  "POST /api/v1/patients": {
    method: "post",
    url: "/api/v1/patients",
    body: { name: "Probe Patient", gender: "female" },
  },
  "POST /api/v1/patients/check-duplicates": {
    method: "post",
    url: "/api/v1/patients/check-duplicates",
    body: { name: "Probe Patient" },
  },
  "PATCH /api/v1/patients/:id": {
    method: "patch",
    url: "/api/v1/patients/64b7f0000000000000000001",
    body: { name: "Probe Patient" },
  },
  "POST /api/v1/patients/merge": {
    method: "post",
    url: "/api/v1/patients/merge",
    body: {
      survivorId: "64b7f0000000000000000001",
      duplicateId: "64b7f0000000000000000002",
      reason: "matrix probe",
    },
  },
  "GET /api/v1/appointments": { method: "get", url: "/api/v1/appointments" },
  "GET /api/v1/appointments/availability": {
    method: "get",
    url: "/api/v1/appointments/availability?doctorId=64b7f0000000000000000001&date=2026-08-03",
  },
  "GET /api/v1/appointments/:id": {
    method: "get",
    url: "/api/v1/appointments/64b7f0000000000000000001",
  },
  "POST /api/v1/appointments": {
    method: "post",
    url: "/api/v1/appointments",
    body: {
      patientId: "64b7f0000000000000000001",
      doctorId: "64b7f0000000000000000002",
      startAt: "2099-01-01T09:00:00.000Z",
    },
  },
  "POST /api/v1/appointments/:id/confirm": {
    method: "post",
    url: "/api/v1/appointments/64b7f0000000000000000001/confirm",
  },
  "POST /api/v1/appointments/:id/check-in": {
    method: "post",
    url: "/api/v1/appointments/64b7f0000000000000000001/check-in",
  },
  "POST /api/v1/appointments/:id/start": {
    method: "post",
    url: "/api/v1/appointments/64b7f0000000000000000001/start",
  },
  "POST /api/v1/appointments/:id/complete": {
    method: "post",
    url: "/api/v1/appointments/64b7f0000000000000000001/complete",
  },
  "POST /api/v1/appointments/:id/reschedule": {
    method: "post",
    url: "/api/v1/appointments/64b7f0000000000000000001/reschedule",
    body: { startAt: "2099-01-01T09:00:00.000Z", reason: "matrix probe" },
  },
  "POST /api/v1/appointments/:id/no-show": {
    method: "post",
    url: "/api/v1/appointments/64b7f0000000000000000001/no-show",
    body: {},
  },
  "POST /api/v1/appointments/:id/cancel": {
    method: "post",
    url: "/api/v1/appointments/64b7f0000000000000000001/cancel",
    body: { reason: "matrix probe" },
  },
  "POST /api/v1/encounters": {
    method: "post",
    url: "/api/v1/encounters",
    body: { patientId: "64b7f0000000000000000001", doctorId: "64b7f0000000000000000002" },
  },
  "GET /api/v1/encounters": { method: "get", url: "/api/v1/encounters" },
  "GET /api/v1/encounters/:id": {
    method: "get",
    url: "/api/v1/encounters/64b7f0000000000000000001",
  },
  "GET /api/v1/episodes/:id/timeline": {
    method: "get",
    url: "/api/v1/episodes/64b7f0000000000000000001/timeline",
  },
  "POST /api/v1/encounters/:id/queue": {
    method: "post",
    url: "/api/v1/encounters/64b7f0000000000000000001/queue",
  },
  "POST /api/v1/encounters/:id/start": {
    method: "post",
    url: "/api/v1/encounters/64b7f0000000000000000001/start",
  },
  "POST /api/v1/encounters/:id/investigations": {
    method: "post",
    url: "/api/v1/encounters/64b7f0000000000000000001/investigations",
  },
  "POST /api/v1/encounters/:id/close": {
    method: "post",
    url: "/api/v1/encounters/64b7f0000000000000000001/close",
    body: {},
  },
  "POST /api/v1/encounters/:id/summary": {
    method: "post",
    url: "/api/v1/encounters/64b7f0000000000000000001/summary",
    body: {},
  },
  "POST /api/v1/encounters/:id/cancel": {
    method: "post",
    url: "/api/v1/encounters/64b7f0000000000000000001/cancel",
    body: { reason: "matrix probe" },
  },
  "POST /api/v1/encounters/:id/left": {
    method: "post",
    url: "/api/v1/encounters/64b7f0000000000000000001/left",
  },
  /**
   * Orders (ADR-0013 §3). The interesting rows in the matrix are the ones a DOCTOR
   * is DENIED: a doctor may place an order and read it, but may not perform, verify
   * or release one. A doctor who could verify their own result would be the only pair
   * of eyes on it — and the second pair of eyes is the entire mechanism by which a
   * wrong number is caught before somebody acts on it.
   */
  "POST /api/v1/orders": {
    method: "post",
    url: "/api/v1/orders",
    body: {
      encounterId: "64b7f0000000000000000001",
      category: "lab",
      code: "CBC",
      name: "Complete Blood Count",
    },
  },
  "GET /api/v1/orders": { method: "get", url: "/api/v1/orders" },
  "GET /api/v1/orders/:id": {
    method: "get",
    url: "/api/v1/orders/64b7f0000000000000000001",
  },
  "POST /api/v1/orders/:id/accept": {
    method: "post",
    url: "/api/v1/orders/64b7f0000000000000000001/accept",
  },
  "POST /api/v1/orders/:id/start": {
    method: "post",
    url: "/api/v1/orders/64b7f0000000000000000001/start",
  },
  "POST /api/v1/orders/:id/complete": {
    method: "post",
    url: "/api/v1/orders/64b7f0000000000000000001/complete",
    body: { summary: "matrix probe" },
  },
  "POST /api/v1/orders/:id/verify": {
    method: "post",
    url: "/api/v1/orders/64b7f0000000000000000001/verify",
  },
  "POST /api/v1/orders/:id/release": {
    method: "post",
    url: "/api/v1/orders/64b7f0000000000000000001/release",
  },
  "POST /api/v1/orders/:id/cancel": {
    method: "post",
    url: "/api/v1/orders/64b7f0000000000000000001/cancel",
    body: { reason: "matrix probe" },
  },
  /**
   * Billing (F-group). The row that matters: a DOCTOR cannot see a bill and cannot
   * take money — clinical judgement must not be shaped by what the patient can pay,
   * and the person who prices the care should never be the one pocketing it.
   */
  /**
   * The doctors directory. Gated on `encounter:read`, NOT `user:read` — the front
   * desk must be able to pick a doctor without being handed a personnel file.
   */
  "GET /api/v1/doctors": { method: "get", url: "/api/v1/doctors" },
  "GET /api/v1/doctors/:id": {
    method: "get",
    url: "/api/v1/doctors/64b7f0000000000000000001",
  },
  "GET /api/v1/services": { method: "get", url: "/api/v1/services" },
  /**
   * The catalogue is the DOCTOR's view of the same collection, price-free. It is
   * gated on `order:create` precisely so a doctor can see what is orderable without
   * `billing:read` — the rate card is not the bill.
   */
  "GET /api/v1/services/catalogue": { method: "get", url: "/api/v1/services/catalogue" },
  "GET /api/v1/encounters/:id/billing": {
    method: "get",
    url: "/api/v1/encounters/64b7f0000000000000000001/billing",
  },
  "GET /api/v1/encounters/:id/bill": {
    method: "get",
    url: "/api/v1/encounters/64b7f0000000000000000001/bill",
  },
  "POST /api/v1/charges": {
    method: "post",
    url: "/api/v1/charges",
    body: {
      encounterId: "64b7f0000000000000000001",
      code: "DRESS",
      category: "procedure",
      quantity: 1,
    },
  },
  "POST /api/v1/charges/:id/void": {
    method: "post",
    url: "/api/v1/charges/64b7f0000000000000000001/void",
    body: { reason: "matrix probe" },
  },
  "POST /api/v1/encounters/:id/bill/finalize": {
    method: "post",
    url: "/api/v1/encounters/64b7f0000000000000000001/bill/finalize",
  },
  "GET /api/v1/invoices": { method: "get", url: "/api/v1/invoices" },
  "GET /api/v1/invoices/:id": {
    method: "get",
    url: "/api/v1/invoices/64b7f0000000000000000001",
  },
  "POST /api/v1/invoices/:id/payments": {
    method: "post",
    url: "/api/v1/invoices/64b7f0000000000000000001/payments",
    body: { amount: 50000, method: "cash" },
  },
  /* ── Admissions (ADR-0013 §4) ───────────────────────────────────────────────
   * `admission:create` / `admission:discharge` — DOCTOR only: deciding a patient needs a
   * bed, and deciding they are well enough to leave, are clinical judgements. Ward notes
   * are `emr:write` because the ward round is nursing work as much as medical.
   */
  "GET /api/v1/inpatients": { method: "get", url: "/api/v1/inpatients" },
  "POST /api/v1/encounters/:id/admit": {
    method: "post",
    url: "/api/v1/encounters/64b7f0000000000000000001/admit",
    body: { ward: "General Ward", bedCode: "A-1", tariffCode: "BED_GEN" },
  },
  "POST /api/v1/encounters/:id/transfer": {
    method: "post",
    url: "/api/v1/encounters/64b7f0000000000000000001/transfer",
    body: { doctorId: "64b7f0000000000000000002", reason: "matrix probe" },
  },
  "POST /api/v1/encounters/:id/notes": {
    method: "post",
    url: "/api/v1/encounters/64b7f0000000000000000001/notes",
    body: { text: "matrix probe" },
  },
  "GET /api/v1/encounters/:id/notes": {
    method: "get",
    url: "/api/v1/encounters/64b7f0000000000000000001/notes",
  },
  "POST /api/v1/encounters/:id/outcome": {
    method: "post",
    url: "/api/v1/encounters/64b7f0000000000000000001/outcome",
    body: { outcome: "lama", text: "matrix probe" },
  },
  "POST /api/v1/encounters/:id/discharge": {
    method: "post",
    url: "/api/v1/encounters/64b7f0000000000000000001/discharge",
    body: { text: "matrix probe" },
  },

  /* ── Prescriptions (STATE_MACHINE_CATALOG §6) ───────────────────────────────
   * Reading is `emr:read` — a pharmacist and a nurse must read what the patient is on,
   * and must never be able to write it. Composing is `prescription:create`; the SIGNATURE
   * is `prescription:sign`, separately, because signing is what makes a document the
   * authority for a drug to leave a shelf.
   */
  "POST /api/v1/prescriptions": {
    method: "post",
    url: "/api/v1/prescriptions",
    body: {
      encounterId: "64b7f0000000000000000001",
      lines: [
        {
          drugCode: "DRUG_PARA_500",
          drugName: "Paracetamol 500mg Tablet",
          dose: "500 mg",
          route: "oral",
          frequency: "TDS",
          quantity: 15,
        },
      ],
    },
  },
  "GET /api/v1/prescriptions": { method: "get", url: "/api/v1/prescriptions" },
  "GET /api/v1/prescriptions/:id": {
    method: "get",
    url: "/api/v1/prescriptions/64b7f0000000000000000001",
  },
  "PATCH /api/v1/prescriptions/:id": {
    method: "patch",
    url: "/api/v1/prescriptions/64b7f0000000000000000001",
    body: { lines: [] },
  },
  "GET /api/v1/prescriptions/:id/screen": {
    method: "get",
    url: "/api/v1/prescriptions/64b7f0000000000000000001/screen",
  },
  "POST /api/v1/prescriptions/:id/sign": {
    method: "post",
    url: "/api/v1/prescriptions/64b7f0000000000000000001/sign",
  },
  "POST /api/v1/prescriptions/:id/cancel": {
    method: "post",
    url: "/api/v1/prescriptions/64b7f0000000000000000001/cancel",
    body: { reason: "matrix probe" },
  },
  "POST /api/v1/prescriptions/:id/discard": {
    method: "post",
    url: "/api/v1/prescriptions/64b7f0000000000000000001/discard",
  },
  "POST /api/v1/prescriptions/:id/amend": {
    method: "post",
    url: "/api/v1/prescriptions/64b7f0000000000000000001/amend",
  },

  /* ── Pharmacy ───────────────────────────────────────────────────────────────
   * `pharmacy:dispense` — the authority to hand a drug over against somebody ELSE's
   * signature. Deliberately held by no clinical role: a doctor who could dispense their
   * own prescription would erase the second pair of eyes the pharmacy exists to be.
   */
  "POST /api/v1/prescriptions/:id/dispense": {
    method: "post",
    url: "/api/v1/prescriptions/64b7f0000000000000000001/dispense",
    body: { items: [{ lineIndex: 0, quantity: 1 }] },
  },
  "GET /api/v1/prescriptions/:id/dispenses": {
    method: "get",
    url: "/api/v1/prescriptions/64b7f0000000000000000001/dispenses",
  },

  /* ── Allergies ──────────────────────────────────────────────────────────────
   * `allergy:read` — everyone clinical, INCLUDING the pharmacist (the last check before a
   * drug is handed over). `allergy:manage` — doctors and nurses record a finding; a
   * pharmacist reads it but does not edit it.
   */
  "GET /api/v1/patients/:patientId/allergies": {
    method: "get",
    url: "/api/v1/patients/64b7f0000000000000000001/allergies",
  },
  "POST /api/v1/patients/:patientId/allergies": {
    method: "post",
    url: "/api/v1/patients/64b7f0000000000000000001/allergies",
    body: { allergen: "penicillins" },
  },
  "POST /api/v1/allergies/:id/refute": {
    method: "post",
    url: "/api/v1/allergies/64b7f0000000000000000001/refute",
    body: { reason: "matrix probe" },
  },

  /*
   * ── Vitals ─────────────────────────────────────────────────────────────────
   * `vitals:record` writes (nurses above all, and doctors); `emr:read` reads, because a
   * reading is clinical PHI — the desk can see THAT a visit exists without being shown the
   * patient's blood pressure.
   */
  "POST /api/v1/encounters/:encounterId/vitals": {
    method: "post",
    url: "/api/v1/encounters/64b7f0000000000000000001/vitals",
    body: { pulse: 72 },
  },
  "GET /api/v1/encounters/:encounterId/vitals": {
    method: "get",
    url: "/api/v1/encounters/64b7f0000000000000000001/vitals",
  },
  "GET /api/v1/patients/:patientId/vitals": {
    method: "get",
    url: "/api/v1/patients/64b7f0000000000000000001/vitals",
  },

  /* ── Branches (ADR-0015) — the admin surface is `branch:manage`; the switcher is self-service. */
  "GET /api/v1/branches": {
    method: "get",
    url: "/api/v1/branches",
  },
  "POST /api/v1/branches": {
    method: "post",
    url: "/api/v1/branches",
    body: { name: "Matrix Probe Branch", code: "MPB" },
  },
  "PATCH /api/v1/branches/:id": {
    method: "patch",
    url: "/api/v1/branches/64b7f0000000000000000001",
    body: { name: "Renamed" },
  },

  /* ── Bed inventory & board (B4) ──────────────────────────────────────────────
   * READS are `emr:read` (the doctor about to admit and the nurse on the ward both see the free
   * beds); WRITES are `bed:manage` (configuring the estate — TENANT_ADMIN, not the ward staff).
   */
  "GET /api/v1/bed-board": { method: "get", url: "/api/v1/bed-board" },
  "GET /api/v1/wards": { method: "get", url: "/api/v1/wards" },
  "POST /api/v1/wards": {
    method: "post",
    url: "/api/v1/wards",
    body: { name: "Matrix Ward", kind: "general", tariffCode: "BED_GEN" },
  },
  "PATCH /api/v1/wards/:id": {
    method: "patch",
    url: "/api/v1/wards/64b7f0000000000000000001",
    body: { name: "Renamed Ward" },
  },
  "GET /api/v1/beds": { method: "get", url: "/api/v1/beds" },
  "POST /api/v1/beds": {
    method: "post",
    url: "/api/v1/beds",
    body: { wardId: "64b7f0000000000000000001", code: "A-1" },
  },
  "PATCH /api/v1/beds/:id": {
    method: "patch",
    url: "/api/v1/beds/64b7f0000000000000000001",
    body: { code: "A-2" },
  },

  /* ── Diagnostic reports ─────────────────────────────────────────────────────
   * `order:perform` uploads a report (the technician/radiologist who ran the test);
   * `emr:read` lists a patient's reports and opens a file (every clinical reader).
   */
  "POST /api/v1/orders/:id/reports": {
    method: "post",
    url: "/api/v1/orders/64b7f0000000000000000001/reports",
    body: { filename: "r.pdf", contentType: "application/pdf", dataBase64: "aGVsbG8=" },
  },
  "GET /api/v1/patients/:patientId/reports": {
    method: "get",
    url: "/api/v1/patients/64b7f0000000000000000001/reports",
  },
  "GET /api/v1/reports/:id/file": {
    method: "get",
    url: "/api/v1/reports/64b7f0000000000000000001/file",
  },

  /* ── Patient documents (A7) ──────────────────────────────────────────────────
   * `file:upload` attaches, `file:read` lists + opens, `file:delete` removes (deleting PHI is
   * heavier than reading it, so its own permission).
   */
  "POST /api/v1/patients/:patientId/documents": {
    method: "post",
    url: "/api/v1/patients/64b7f0000000000000000001/documents",
    body: {
      category: "id_proof",
      title: "Matrix probe",
      filename: "id.pdf",
      contentType: "application/pdf",
      dataBase64: "aGVsbG8=",
    },
  },
  "GET /api/v1/patients/:patientId/documents": {
    method: "get",
    url: "/api/v1/patients/64b7f0000000000000000001/documents",
  },
  "GET /api/v1/documents/:id/file": {
    method: "get",
    url: "/api/v1/documents/64b7f0000000000000000001/file",
  },
  "DELETE /api/v1/documents/:id": {
    method: "delete",
    url: "/api/v1/documents/64b7f0000000000000000001",
  },

  /* ── Tariff management ───────────────────────────────────────────────────────
   * `tariff:manage` — the administrator's price list. Prices are visible and editable here.
   */
  "GET /api/v1/tariff": { method: "get", url: "/api/v1/tariff" },
  "POST /api/v1/tariff": {
    method: "post",
    url: "/api/v1/tariff",
    body: { code: "PROC_DRESSING", name: "Wound dressing", category: "procedure", price: 15000 },
  },
  "PATCH /api/v1/tariff/:id": {
    method: "patch",
    url: "/api/v1/tariff/64b7f0000000000000000001",
    body: { price: 20000 },
  },

  /* ── Pharmacy medicine master & stock ───────────────────────────────────────
   * `pharmacy:stock` throughout — maintaining the shelf, gated on module.pharmacy.full.
   * Stock decrements from a dispense are an EVENT, not a route, so they are not probed here.
   */
  "GET /api/v1/medicines": { method: "get", url: "/api/v1/medicines" },
  "GET /api/v1/medicines/stock-report": { method: "get", url: "/api/v1/medicines/stock-report" },
  "GET /api/v1/medicines/:id": {
    method: "get",
    url: "/api/v1/medicines/64b7f0000000000000000001",
  },
  "GET /api/v1/medicines/:id/movements": {
    method: "get",
    url: "/api/v1/medicines/64b7f0000000000000000001/movements",
  },
  "POST /api/v1/medicines": {
    method: "post",
    url: "/api/v1/medicines",
    body: { code: "PARA_500", name: "Paracetamol 500", form: "tablet" },
  },
  "PATCH /api/v1/medicines/:id": {
    method: "patch",
    url: "/api/v1/medicines/64b7f0000000000000000001",
    body: { reorderLevel: 20 },
  },
  "POST /api/v1/medicines/:id/receive": {
    method: "post",
    url: "/api/v1/medicines/64b7f0000000000000000001/receive",
    body: { quantity: 100 },
  },
  "POST /api/v1/medicines/:id/adjust": {
    method: "post",
    url: "/api/v1/medicines/64b7f0000000000000000001/adjust",
    body: { delta: -6, reason: "breakage" },
  },

  /* ── Reporting (the audit/register suite) ────────────────────────────────────
   * `report:view` — a hospital-wide read. Each takes a from/to range.
   */
  "GET /api/v1/reports/pharmacy-stock": {
    method: "get",
    url: "/api/v1/reports/pharmacy-stock?from=2026-01-01&to=2026-02-01",
  },
  "GET /api/v1/reports/patient-visits": {
    method: "get",
    url: "/api/v1/reports/patient-visits?from=2026-01-01&to=2026-02-01",
  },
  "GET /api/v1/reports/doctor-load": {
    method: "get",
    url: "/api/v1/reports/doctor-load?from=2026-01-01&to=2026-02-01",
  },
  "GET /api/v1/reports/diagnostics": {
    method: "get",
    url: "/api/v1/reports/diagnostics?from=2026-01-01&to=2026-02-01",
  },
  "GET /api/v1/reports/collections": {
    method: "get",
    url: "/api/v1/reports/collections?from=2026-01-01&to=2026-02-01",
  },
  "GET /api/v1/reports/wallet": {
    method: "get",
    url: "/api/v1/reports/wallet?from=2026-01-01&to=2026-02-01",
  },
  "GET /api/v1/reports/discharge-outcomes": {
    method: "get",
    url: "/api/v1/reports/discharge-outcomes?from=2026-01-01&to=2026-02-01",
  },
  "GET /api/v1/billing/order-payments": {
    method: "get",
    url: "/api/v1/billing/order-payments?orderIds=64b7f0000000000000000001",
  },
  "GET /api/v1/billing/consultation-payments": {
    method: "get",
    url: "/api/v1/billing/consultation-payments?encounterIds=64b7f0000000000000000001",
  },
  "GET /api/v1/billing/order-settlement": {
    method: "get",
    url: "/api/v1/billing/order-settlement?orderIds=64b7f0000000000000000001",
  },
  "GET /api/v1/wallet/entries/:id": {
    method: "get",
    url: "/api/v1/wallet/entries/64b7f0000000000000000001",
  },
  "GET /api/v1/encounters/:id/charges": {
    method: "get",
    url: "/api/v1/encounters/64b7f0000000000000000001/charges",
  },
  "GET /api/v1/reports/receipts": {
    method: "get",
    url: "/api/v1/reports/receipts?from=2026-07-01&to=2026-07-31",
  },
  "POST /api/v1/billing/orders/:id/settle-from-advance": {
    method: "post",
    url: "/api/v1/billing/orders/64b7f0000000000000000001/settle-from-advance",
    body: {},
  },
  "GET /api/v1/site/settings": { method: "get", url: "/api/v1/site/settings" },
  "PATCH /api/v1/site/settings": { method: "patch", url: "/api/v1/site/settings", body: {} },
  "GET /api/v1/patients/:patientId/wallet": {
    method: "get",
    url: "/api/v1/patients/64b7f0000000000000000001/wallet",
  },
  "POST /api/v1/patients/:patientId/wallet/deposits": {
    method: "post",
    url: "/api/v1/patients/64b7f0000000000000000001/wallet/deposits",
    body: { amount: 1000, method: "cash" },
  },
  "POST /api/v1/patients/:patientId/wallet/refunds": {
    method: "post",
    url: "/api/v1/patients/64b7f0000000000000000001/wallet/refunds",
    body: { amount: 1000, method: "cash" },
  },

  "GET /api/v1/notifications": { method: "get", url: "/api/v1/notifications" },
  "GET /api/v1/notifications/templates": {
    method: "get",
    url: "/api/v1/notifications/templates",
  },
  "PUT /api/v1/notifications/templates/:key": {
    method: "put",
    url: "/api/v1/notifications/templates/appointment.reminder",
    body: { enabled: true },
  },
  "GET /api/v1/doctors/:doctorId/schedule": {
    method: "get",
    url: "/api/v1/doctors/64b7f0000000000000000001/schedule",
  },
  "PUT /api/v1/doctors/schedule": {
    method: "put",
    url: "/api/v1/doctors/schedule",
    body: {
      doctorId: "64b7f0000000000000000001",
      weekday: 1,
      startMinute: 540,
      endMinute: 780,
      slotMinutes: 15,
    },
  },
  "DELETE /api/v1/doctors/schedule/:id": {
    method: "delete",
    url: "/api/v1/doctors/schedule/64b7f0000000000000000001",
  },
};

/** The roles under test. Chosen to span the privilege range, not to be exhaustive. */
/**
 * PHARMACIST is here because it is the only role that may hand a controlled drug to a
 * human being, and until the pharmacy shipped it had never had a single route tested.
 * The matrix is derived from `DEFAULT_ROLES`, so adding the name is enough — every route
 * is now probed against it.
 */
const ROLES_UNDER_TEST = ["TENANT_ADMIN", "DOCTOR", "NURSE", "RECEPTIONIST", "PHARMACIST"] as const;
type TestedRole = (typeof ROLES_UNDER_TEST)[number];

/** Permission codes each role holds — read from the catalog the app itself seeds from. */
function permissionsOf(roleCode: string): Set<string> {
  const role = DEFAULT_ROLES.find((r) => r.code === roleCode);
  if (!role) throw new Error(`unknown role in matrix: ${roleCode}`);

  const held = new Set(role.permissions);

  /**
   * A guard against the subtlest way this whole suite could rot: if `permissions`
   * ever changed shape (objects instead of codes, say), this would silently become
   * an empty set — and an empty set means "expect 403 everywhere", which every
   * denied route would happily satisfy. The suite would go green while asserting
   * that nobody can do anything. A test that passes vacuously is worse than no test.
   */
  if (held.size === 0) {
    throw new Error(`role ${roleCode} resolved to ZERO permissions — the catalog shape changed`);
  }
  return held;
}

const tokens: Record<TestedRole | "noRole", string> = {} as never;
let tokenTenantB = "";

/**
 * Seeds the permission catalog and the 11 default roles into a tenant.
 *
 * `provisionTenant` creates the database and runs migrations; it does NOT seed
 * RBAC — that is `seedTenantAdmin`'s job in the real flow. Calling it explicitly
 * here keeps the suite honest about what it is testing: the roles under test are
 * the ones the product actually ships, seeded by the code that actually ships.
 */
async function seedRoles(tenant: Tenant): Promise<void> {
  const connection = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
  });
  await runWithContext(
    { traceId: "rbac-setup", tenantId: tenant.id, tenantSlug: tenant.slug, connection },
    async () => {
      await seedRbac();
    },
  );
}

async function createUserWithRole(
  tenant: Tenant,
  email: string,
  roleCode?: string,
  branchIds?: string[],
): Promise<void> {
  const connection = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
  });
  await runWithContext(
    { traceId: "rbac-setup", tenantId: tenant.id, tenantSlug: tenant.slug, connection },
    async () => {
      const user = await createUser({ email, name: email, status: "invited" });
      await setPassword(user.id, PASSWORD, { mustChangePassword: false });
      if (roleCode) await assignRoleByCode(user.id, roleCode, branchIds ?? []);
      await transitionStatus(user.id, "active");
    },
  );
}

async function login(host: string, email: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/auth/login")
    .set("Host", host)
    .send({ email, password: PASSWORD });

  if (res.status !== 200) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.data.accessToken as string;
}

beforeAll(async () => {
  await assertMongoReachable();
  await assertRedisReachable();
  await dropDatabases(["test_rbac_master", DB_A, DB_B]);
  await flushTestCache("rbac");

  /**
   * Apollo buys EVERYTHING; Sunshine has no plan at all. That difference is what makes
   * layer 1 (entitlement) testable — see the entitlement suite at the bottom.
   *
   * ── WHY THE MATRIX TENANT MUST HOLD EVERY FEATURE ─────────────────────────
   * This suite tests LAYER 2 — may this role call this route. It can only do that if
   * layer 1 never interferes, because `authorize` checks entitlement FIRST and both
   * layers answer 403.
   *
   * Apollo was on PLAN_CLINIC, which was fine for exactly as long as every route's
   * feature happened to be in CLINIC_FLAGS. The pharmacy routes gate on
   * `module.pharmacy.dispensing`, which a clinic correctly does NOT buy — so every
   * pharmacy probe started failing with "denied but holds pharmacy:dispense".
   *
   * The dangerous half is the one that did NOT fail: a "may NOT" probe against an
   * unentitled route PASSES, because the route 403s for the wrong reason. The role could
   * have held the permission all along and this suite would have called it denied. On the
   * fullest plan, a 403 is always a permission decision — which is the only thing that
   * makes this matrix mean what it says.
   */
  const a = await provisionTenant({
    hospitalName: "Apollo RBAC",
    slug: SLUG_A,
    planCode: "PLAN_ENTERPRISE",
  });
  const b = await provisionTenant({ hospitalName: "Sunshine RBAC", slug: SLUG_B });
  tenantA = { id: a.tenant.id, slug: SLUG_A, databaseName: a.tenant.databaseName };
  tenantB = { id: b.tenant.id, slug: SLUG_B, databaseName: b.tenant.databaseName };

  await seedRoles(tenantA);
  await seedRoles(tenantB);

  for (const role of ROLES_UNDER_TEST) {
    await createUserWithRole(tenantA, `${role.toLowerCase()}@apollo.test`, role);
  }
  // A user with NO role at all — the baseline. They can authenticate and do nothing,
  // which is the correct default for an account somebody created and forgot to grant.
  await createUserWithRole(tenantA, "norole@apollo.test");

  await createUserWithRole(tenantB, "admin@sunshine.test", "TENANT_ADMIN");

  for (const role of ROLES_UNDER_TEST) {
    tokens[role] = await login(HOST_A, `${role.toLowerCase()}@apollo.test`);
  }
  tokens.noRole = await login(HOST_A, "norole@apollo.test");
  tokenTenantB = await login(HOST_B, "admin@sunshine.test");
}, 120_000);

afterAll(async () => {
  await closeAllTenantConnections();
  await closeMaster();
  await closeRedis();
  await dropDatabases(["test_rbac_master", DB_A, DB_B]);
}, 30_000);

/* ────────────────────────────────────────────────────────────────────────────
 * 1. COVERAGE — the test that makes the rest of the suite trustworthy.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("route coverage (the unprotected-route problem)", () => {
  const routes = routeInventory(app).filter((r) => r.path.startsWith("/api/v1"));
  const key = (r: { method: string; path: string }): string => `${r.method} ${r.path}`;

  it("finds the tenant API surface (guards against the inventory silently returning nothing)", () => {
    // If `routeInventory` ever breaks — an Express upgrade changes the router
    // internals, say — it would return [] and EVERY test below would pass
    // vacuously. This suite would then be green while asserting nothing at all,
    // which is worse than having no suite. So it must find real routes first.
    expect(routes.length).toBeGreaterThan(20);
  });

  it("every /api/v1 route is public by declaration, self-service, or permission-protected", () => {
    const unprotected = routes.filter((route) => {
      const id = key(route);
      if (PUBLIC_ROUTES.has(id) || SELF_SERVICE_ROUTES.has(id)) return false;
      return !route.authenticates || !route.permission;
    });

    expect(
      unprotected.map(key),
      "These routes have no permission. Add `authorize(PERMISSIONS.X)`, or declare them " +
        "in PUBLIC_ROUTES/SELF_SERVICE_ROUTES if that is genuinely intended.",
    ).toEqual([]);
  });

  it("every permission a route requires actually exists in the catalog", () => {
    // Catches a route wired to a permission code that no role can ever hold —
    // which would make the route permanently unreachable (annoying), or, if the
    // check were ever loosened, universally reachable (a breach).
    const unknown = routes
      .filter((r) => r.permission && !ALL_PERMISSION_CODES.includes(r.permission))
      .map((r) => `${key(r)} → ${r.permission ?? ""}`);

    expect(unknown, "Route requires a permission that is not in the catalog").toEqual([]);
  });

  it("every permission-protected route has a probe in the matrix", () => {
    const missing = routes
      .filter((r) => r.permission)
      .map(key)
      .filter((id) => !(id in PROBES));

    expect(
      missing,
      "A new protected route shipped without anyone deciding which roles may call it. " +
        "Add it to PROBES — that is the point of this failure.",
    ).toEqual([]);
  });

  it("no probe refers to a route that no longer exists", () => {
    // The other direction: a stale probe would be a test that passes while
    // exercising nothing.
    const live = new Set(routes.map(key));
    expect(Object.keys(PROBES).filter((id) => !live.has(id))).toEqual([]);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 2. THE MATRIX — every tested role against every protected route.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("the matrix: role × route", () => {
  const routes = routeInventory(app).filter((r) => r.path.startsWith("/api/v1") && r.permission);

  for (const role of ROLES_UNDER_TEST) {
    const held = permissionsOf(role);

    for (const route of routes) {
      const id = `${route.method} ${route.path}`;
      const probe = PROBES[id];
      if (!probe || !route.permission) continue;

      const shouldAllow = held.has(route.permission);

      it(`${role} ${shouldAllow ? "may" : "may NOT"} ${id}`, async () => {
        const res = await request(app)
          [probe.method](probe.url)
          .set("Host", HOST_A)
          .set("Authorization", `Bearer ${tokens[role]}`)
          .send(probe.body ?? {});

        if (shouldAllow) {
          /**
           * "Allowed" means the authorization chain let the request THROUGH — not
           * that the handler succeeded. A probe pointing at a nonexistent id gets a
           * 404, and a deliberately thin body gets a 400; both prove we got past
           * `authorize`, which is the only thing this suite is asking.
           *
           * What must never appear is 403.
           */
          expect(
            res.status,
            `${role} was denied ${id} but holds ${route.permission ?? ""}`,
          ).not.toBe(403);
        } else {
          expect(res.status, `${role} reached ${id} without ${route.permission ?? ""}`).toBe(403);
          expect(res.body.error.code).toBe("HMS-AUTH-005");
        }
      });
    }
  }

  it("a user with no role can authenticate and do nothing", async () => {
    // The safe default. An account created and never granted anything must be
    // useless, not quietly powerful.
    for (const [id, probe] of Object.entries(PROBES)) {
      const res = await request(app)
        [probe.method](probe.url)
        .set("Host", HOST_A)
        .set("Authorization", `Bearer ${tokens.noRole}`)
        .send(probe.body ?? {});

      expect(res.status, `an unroled user reached ${id}`).toBe(403);
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 3. DELIBERATE FACTS — the specific things we must never regress.
 *
 * The matrix above is derived from the catalog, so it moves when the catalog
 * moves. These do not. They are the assertions that would have FAILED on the day
 * each real bug was introduced, and they exist to make that failure loud.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("privilege boundaries that must never move", () => {
  it("TENANT_ADMIN cannot change its own hospital's plan (the A2 escalation hole)", async () => {
    // `plan:manage` lived in the ordinary platform group once, so TENANT_ADMIN
    // inherited it and the demo hospital upgraded ITSELF to Enterprise. A customer
    // could have taken the top edition for free. This is the test that says never again.
    const res = await request(app)
      .post("/api/v1/subscription/plan")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${tokens.TENANT_ADMIN}`)
      .send({ planCode: "PLAN_ENTERPRISE" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("HMS-AUTH-005");
  });

  it("TENANT_ADMIN cannot switch on a feature the hospital never bought", async () => {
    const res = await request(app)
      .post("/api/v1/feature-flags")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${tokens.TENANT_ADMIN}`)
      .send({ feature: "module.clinical.dialysis", enabled: true });

    expect(res.status).toBe(403);
  });

  it("TENANT_ADMIN holds neither superadmin permission, in the catalog itself", () => {
    const admin = permissionsOf("TENANT_ADMIN");
    for (const forbidden of [
      PERMISSIONS.PLAN_MANAGE,
      PERMISSIONS.FEATUREFLAG_MANAGE,
      PERMISSIONS.SUPERADMIN_TENANT_MANAGE,
      PERMISSIONS.TENANT_IMPERSONATE,
      PERMISSIONS.TENANT_EXPORT,
    ]) {
      expect(admin.has(forbidden.code), `TENANT_ADMIN must never hold ${forbidden.code}`).toBe(
        false,
      );
    }
  });

  it("a NURSE cannot create user accounts or assign roles", async () => {
    // The privilege-escalation path: anyone who can grant a role can grant
    // themselves any role. It must not come free with clinical duties.
    for (const probe of [PROBES["POST /api/v1/users"], PROBES["POST /api/v1/users/:id/roles"]]) {
      const res = await request(app)
        [probe!.method](probe!.url)
        .set("Host", HOST_A)
        .set("Authorization", `Bearer ${tokens.NURSE}`)
        .send(probe!.body ?? {});
      expect(res.status).toBe(403);
    }
  });

  it("a RECEPTIONIST may register a patient but may NOT merge two of them", async () => {
    // Registration is the front desk's whole job. Merging is irreversible and is a
    // clinical judgement about identity — it must not arrive free with the till.
    const register = await request(app)
      .post("/api/v1/patients")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${tokens.RECEPTIONIST}`)
      .send({ name: "Walk In", gender: "female" });
    expect(register.status).toBe(201);

    const merge = await request(app)
      .post("/api/v1/patients/merge")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${tokens.RECEPTIONIST}`)
      .send({
        survivorId: "64b7f0000000000000000001",
        duplicateId: "64b7f0000000000000000002",
        reason: "receptionist should not be able to do this",
      });
    expect(merge.status).toBe(403);
    expect(merge.body.error.code).toBe("HMS-AUTH-005");
  });

  it("a DOCTOR cannot START a visit — that is the front desk's job", async () => {
    // A doctor who can conjure an encounter can see a patient who was never
    // registered: no UHID, no queue position, no bill. The desk starts visits;
    // clinicians move them along. (The doctor CAN read and close them.)
    const res = await request(app)
      .post("/api/v1/encounters")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${tokens.DOCTOR}`)
      .send({ patientId: "64b7f0000000000000000001", doctorId: "64b7f0000000000000000002" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("HMS-AUTH-005");
  });

  it("a DOCTOR cannot VERIFY a result — they would be the only pair of eyes on it", async () => {
    // The doctor asks the question and wants a particular answer. The person who
    // certifies that the answer is real cannot be the same person, which is why
    // `order:verify` is not in the DOCTOR grant. This is the check that catches a
    // wrong number before somebody prescribes against it.
    for (const path of ["verify", "release", "complete"]) {
      const res = await request(app)
        .post(`/api/v1/orders/64b7f0000000000000000001/${path}`)
        .set("Host", HOST_A)
        .set("Authorization", `Bearer ${tokens.DOCTOR}`)
        .send({ summary: "doctor should not be able to do this" });

      expect(res.status, `DOCTOR must not be able to ${path} an order`).toBe(403);
      expect(res.body.error.code).toBe("HMS-AUTH-005");
    }
  });

  it("a PHARMACIST cannot write or sign a prescription — they are the second pair of eyes, not the first", async () => {
    /**
     * The whole reason a pharmacy is a safety check and not a hatch is that the person
     * handing the drugs over did not choose them. A pharmacist who could write or amend
     * the prescription they are about to dispense is just a doctor with worse training and
     * no patient in front of them.
     *
     * They hold `emr:read` and can READ it — they must, to dispense it safely.
     */
    const writes: [string, string, object][] = [
      ["post", "/api/v1/prescriptions", { encounterId: "64b7f0000000000000000001", lines: [] }],
      ["patch", "/api/v1/prescriptions/64b7f0000000000000000001", { lines: [] }],
      ["post", "/api/v1/prescriptions/64b7f0000000000000000001/sign", {}],
      ["post", "/api/v1/prescriptions/64b7f0000000000000000001/amend", {}],
    ];

    for (const [method, url, body] of writes) {
      const res = await (request(app) as unknown as Record<string, (u: string) => request.Test>)
        [method](url)
        .set("Host", HOST_A)
        .set("Authorization", `Bearer ${tokens.PHARMACIST}`)
        .send(body);

      expect(res.status, `PHARMACIST must not be able to ${method} ${url}`).toBe(403);
      expect(res.body.error.code).toBe("HMS-AUTH-005");
    }
  });

  it("a DOCTOR cannot dispense their own prescription", async () => {
    // Prescribing and dispensing are two people on purpose. A doctor who could do both
    // removes the only check between a slip of the pen and a patient swallowing it —
    // which is exactly the check `pharmacy:dispense` exists to be.
    const res = await request(app)
      .post("/api/v1/prescriptions/64b7f0000000000000000001/dispense")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${tokens.DOCTOR}`)
      .send({ items: [{ lineIndex: 0, quantity: 1 }] });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("HMS-AUTH-005");
  });

  it("a NURSE cannot admit or discharge — those are clinical judgements", async () => {
    /**
     * A nurse allocates the bed (`bed:allocate`) and writes the ward notes. Deciding that
     * a patient needs a bed, and that they are well enough to go home, is the doctor's
     * call. This is the separation that stops a busy ward discharging someone to free up
     * a bed without a doctor ever seeing them.
     */
    for (const [url, body] of [
      [
        "/api/v1/encounters/64b7f0000000000000000001/admit",
        { ward: "W", bedCode: "1", tariffCode: "BED_GEN" },
      ],
      ["/api/v1/encounters/64b7f0000000000000000001/discharge", { text: "nurse should not" }],
    ] as [string, object][]) {
      const res = await request(app)
        .post(url)
        .set("Host", HOST_A)
        .set("Authorization", `Bearer ${tokens.NURSE}`)
        .send(body);

      expect(res.status, `NURSE must not be able to POST ${url}`).toBe(403);
      expect(res.body.error.code).toBe("HMS-AUTH-005");
    }
  });

  it("a RECEPTIONIST cannot read a prescription — a drug name is a diagnosis", async () => {
    // Lithium says bipolar; tenofovir says HIV; methotrexate says cancer. The front desk
    // books and bills, and the prescription leaks the condition even when no diagnosis was
    // ever written down. They hold no `emr:read`, and this is why.
    const res = await request(app)
      .get("/api/v1/prescriptions")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${tokens.RECEPTIONIST}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("HMS-AUTH-005");
  });

  it("a RECEPTIONIST cannot see the order book — what was ordered is a diagnosis not yet written down", async () => {
    // An order list leaks the SUSPICION even when the result is negative: an HIV test,
    // a beta-hCG, a psychiatric referral. The front desk books and bills; it does not
    // read what the doctor is worried about.
    const res = await request(app)
      .get("/api/v1/orders")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${tokens.RECEPTIONIST}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("HMS-AUTH-005");
  });

  it("a RECEPTIONIST cannot browse the notification ledger — a message body is PHI", async () => {
    // The ledger holds every message we ever sent, and each one names a patient,
    // their doctor and when they are coming in. It is a patient list with extra
    // steps, and "can send appointments out" must not quietly become "can read
    // everyone's".
    const res = await request(app)
      .get("/api/v1/notifications")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${tokens.RECEPTIONIST}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("HMS-AUTH-005");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 4. THE TENANCY BOUNDARY — a permission is worthless if it crosses hospitals.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("permissions do not cross the tenancy boundary", () => {
  it("a fully-privileged admin of one hospital is refused at another", async () => {
    // Sunshine's TENANT_ADMIN holds 139 permissions — at Sunshine. At Apollo they
    // hold nothing, and the refusal happens BEFORE any permission is consulted,
    // because the token's `tid` does not match the host-resolved tenant.
    const res = await request(app)
      .get("/api/v1/patients")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${tokenTenantB}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("HMS-TEN-003");
  });

  it("an OPERATOR token cannot authorize inside a hospital", async () => {
    // A platform token carries no `tid` at all, so it can never match a
    // host-resolved tenant. Structural, not a check somebody could forget.
    const { token: operatorToken } = await signPlatformToken({
      userId: "64b7f0000000000000000009",
      email: "ops@paperlesstech.in",
      roles: ["SUPER_ADMIN"],
    });

    const res = await request(app)
      .get("/api/v1/patients")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${operatorToken}`);

    // 401, not 500: a stale operator tab hitting a tenant route is a routine
    // event, not an exception. (This was a real bug — it used to 500.)
    expect(res.status).toBe(401);
  });

  it("a TENANT token cannot reach the operator console", async () => {
    const res = await request(app)
      .get("/api/platform/v1/hospitals")
      .set("Authorization", `Bearer ${tokens.TENANT_ADMIN}`);

    expect(res.status).toBe(401);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 5. ROW SCOPE (layer 3) — the layer the middleware cannot enforce alone.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("row scope: branch confinement (the P2 bug, pinned)", () => {
  const BRANCH_X = "64b7f0000000000000000aaa";
  const BRANCH_Y = "64b7f0000000000000000bbb";

  it("a hospital-wide binding sees every patient", async () => {
    // The bug: an empty `branchIds` meant "everywhere" to RBAC and "nowhere" to the
    // row filter, so this returned ZERO patients — for the admin who had just
    // registered them. `patient:read` is `branch`-scoped, so this is the exact path.
    await request(app)
      .post("/api/v1/patients")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${tokens.TENANT_ADMIN}`)
      .send({ name: "Scope Visible", gender: "male", branchId: BRANCH_X })
      .expect(201);

    const res = await request(app)
      .get("/api/v1/patients")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${tokens.TENANT_ADMIN}`)
      .expect(200);

    expect(res.body.data.length, "a hospital-wide admin must see patients").toBeGreaterThan(0);
  });

  it("a branch-confined user sees ONLY their branch's patients", async () => {
    await createUserWithRole(tenantA, "branchnurse@apollo.test", "NURSE", [BRANCH_X]);
    const confined = await login(HOST_A, "branchnurse@apollo.test");

    // One patient in each branch, plus the unassigned ones already registered above.
    await request(app)
      .post("/api/v1/patients")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${tokens.TENANT_ADMIN}`)
      .send({ name: "Other Branch Patient", gender: "female", branchId: BRANCH_Y })
      .expect(201);

    const res = await request(app)
      .get("/api/v1/patients")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${confined}`)
      .expect(200);

    const branches = (res.body.data as { branchId?: string }[]).map((p) => p.branchId);
    expect(
      branches.every((b) => b === BRANCH_X),
      `a confined nurse saw ${branches.join(",")}`,
    ).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 6. LAYER 1 — ENTITLEMENT. Until appointments shipped, NO route carried a
 *    feature flag, so this layer of ADR-0010 had never been exercised end to end.
 *    It is the layer that makes editions worth money.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("entitlement (layer 1): a hospital cannot use what it did not buy", () => {
  it("an entitled hospital reaches the appointment book", async () => {
    // Apollo is on PLAN_ENTERPRISE, which includes module.ops.appointments.
    const res = await request(app)
      .get("/api/v1/appointments")
      .set("Host", HOST_A)
      .set("Authorization", `Bearer ${tokens.TENANT_ADMIN}`);

    expect(res.status).toBe(200);
  });

  it("an UNSUBSCRIBED hospital is refused — with HMS-PLAN-002, not HMS-AUTH-005", async () => {
    /**
     * Sunshine has no plan. Its administrator holds `appointment:read` — the
     * permission is not the problem, the SUBSCRIPTION is — so the error must say
     * so. HMS-AUTH-005 would send that admin hunting through the role editor for
     * a permission that can never help them; HMS-PLAN-002 sends them to sales.
     *
     * That is why layer 1 runs BEFORE layer 2 (ADR-0010), and this is the test
     * that proves the order, not just the outcome.
     */
    const res = await request(app)
      .get("/api/v1/appointments")
      .set("Host", HOST_B)
      .set("Authorization", `Bearer ${tokenTenantB}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("HMS-PLAN-002");
  });

  it("no plan does not mean no limits — every appointment route is gated, not just the list", async () => {
    // A gate on the read but not the write is worse than no gate: the hospital
    // simply uses the parts that were forgotten.
    for (const [id, probe] of Object.entries(PROBES)) {
      // Appointment + doctor-SCHEDULE routes are the scheduling feature. The plain doctor
      // directory and a single doctor's card are core (no plan gate), like `GET /doctors`.
      if (!id.includes("/appointments") && !id.includes("/schedule")) continue;

      const res = await request(app)
        [probe.method](probe.url)
        .set("Host", HOST_B)
        .set("Authorization", `Bearer ${tokenTenantB}`)
        .send(probe.body ?? {});

      expect(res.body.error?.code, `${id} was not entitlement-gated`).toBe("HMS-PLAN-002");
    }
  });
});
