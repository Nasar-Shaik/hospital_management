/**
 * The demo hospital — one command, a whole clinic (dev only).
 *
 *     pnpm --filter @medicore/api seed:demo
 *
 * Provisions a hospital and staffs it with one of every role, so the full flow —
 * reception → doctor → lab → pharmacy → bill — can be demonstrated without an hour of
 * clicking through the staff screen first.
 *
 * ── WHY THIS IS A SCRIPT AND NOT A TEST FIXTURE ─────────────────────────────
 * A fixture proves the code works. This exists so a HUMAN can log in as each role and
 * see the software behave, which is a different job and the one that sells it.
 *
 * ── DEV PASSWORDS ONLY ──────────────────────────────────────────────────────
 * Everyone gets `123456`, which the password policy would normally refuse — the script
 * sets it deliberately and it must never run against production. It refuses to run when
 * NODE_ENV is production; that check is the only thing standing between a demo
 * convenience and a breach, so do not remove it.
 */
import { createLogger } from "@medicore/logger";
import type { OrganizationType } from "@medicore/permissions";
import { env } from "../config/env.js";
import { runWithContext } from "../core/context/requestContext.js";
import { getTenantConnection, closeAllTenantConnections } from "../core/db/connectionManager.js";
import { closeMaster } from "../core/db/masterDb.js";
import { closeRedis } from "../core/redis/redis.js";
import { provisionTenant, getBySlug } from "../modules/tenants/index.js";
import { createUser, transitionStatus, getByEmail } from "../modules/users/index.js";
import { assignRoleByCode, seedRbac } from "../modules/rbac/index.js";
import { setPassword } from "../modules/auth/index.js";
import { seedNotificationTemplates } from "../seed/notificationTemplates.js";
import { seedTariff } from "../seed/tariff.js";
import { seedFormulary } from "../seed/formulary.js";
import { listMedicines, receiveStock } from "../modules/medicines/index.js";

const logger = createLogger({ service: "seed-demo" });

/** The one password every demo account uses. Dev only — see the header. */
const PASSWORD = "123456";

interface StaffSeed {
  key: string;
  name: string;
  role: string;
  /** What this person does in the demo, printed at the end so nobody has to guess. */
  does: string;
}

const STAFF: StaffSeed[] = [
  {
    key: "admin",
    name: "Hospital Administrator",
    role: "TENANT_ADMIN",
    does: "everything; staff, roles, audit, subscription",
  },
  {
    key: "reception",
    name: "Priya (Front Desk)",
    role: "RECEPTIONIST",
    does: "register patients, start visits, see the queue, see bills",
  },
  {
    key: "drrao",
    name: "Dr Rao (General Medicine)",
    role: "DOCTOR",
    does: "see the waiting list, consult, order labs/x-ray, prescribe",
  },
  {
    key: "drkhan",
    name: "Dr Khan (Surgery)",
    role: "DOCTOR",
    does: "the second doctor — for transferring a case",
  },
  {
    key: "labtech",
    name: "Kumar (Lab)",
    role: "LAB_TECHNICIAN",
    does: "the blood worklist: accept, run, enter results",
  },
  {
    key: "pathologist",
    name: "Dr Iyer (Pathology)",
    role: "PATHOLOGIST",
    does: "verify and release BLOOD results",
  },
  {
    key: "radiologist",
    name: "Dr Sharma (Radiology)",
    role: "RADIOLOGIST",
    does: "the x-ray worklist; verify and release IMAGING",
  },
  {
    key: "pharmacy",
    name: "Nisha (Pharmacy)",
    role: "PHARMACIST",
    does: "dispense prescriptions, take money",
  },
  { key: "cashier", name: "Ravi (Billing)", role: "CASHIER", does: "finalize bills, take payment" },
];

interface DemoHospital {
  slug: string;
  name: string;
  type: OrganizationType;
}

/**
 * BOTH hospital types, deliberately.
 *
 * The single strongest thing to show a customer is the same software running a private
 * hospital that charges ₹500 for a consultation and a government hospital that charges
 * ₹0 for the identical care — driven by a preset, not a fork. Two logins, side by side.
 */
const HOSPITALS: DemoHospital[] = [
  { slug: "sunrise", name: "Sunrise Multispeciality", type: "private_hospital" },
  { slug: "district", name: "District General Hospital", type: "government_hospital" },
];

async function seedHospital(h: DemoHospital): Promise<void> {
  const existing = await getBySlug(h.slug);

  const tenant =
    existing ??
    (
      await provisionTenant({
        hospitalName: h.name,
        slug: h.slug,
        planCode: "PLAN_HOSPITAL",
        organizationType: h.type,
      })
    ).tenant;

  if (existing) logger.info({ slug: h.slug }, "hospital already exists — topping up staff");

  const connection = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
    ...(tenant.dbUri ? { dbUri: tenant.dbUri } : {}),
  });

  await runWithContext(
    { traceId: `seed-demo-${h.slug}`, tenantId: tenant.id, tenantSlug: h.slug, connection },
    async () => {
      await seedRbac();

      for (const person of STAFF) {
        const email = `${person.key}@${h.slug}.test`;

        // Idempotent: re-running must top up what is missing, never blow up on what is
        // already there. A demo script you are afraid to re-run is a demo script nobody
        // runs.
        const already = await getByEmail(email);
        if (already) {
          /**
           * The admin is the one account provisioning creates BEFORE this loop — with its
           * own generated password, not ours. So `continue` here left exactly one dev login
           * (`admin@<slug>.test`) that was NOT `123456`, silently breaking the rule that every
           * demo account shares that password. Re-set it so the promise holds for everyone.
           *
           * If it is ALREADY `123456`, the password-history guard rejects "reusing" it —
           * which is exactly the state we wanted, so that one validation error is success,
           * not a failure. Anything else still throws. This keeps the seed re-runnable.
           */
          try {
            await setPassword(already.id, PASSWORD, { mustChangePassword: false });
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (code !== "HMS-VAL-001") throw err;
          }
          continue;
        }

        const user = await createUser({ email, name: person.name, status: "invited" });
        await setPassword(user.id, PASSWORD, { mustChangePassword: false });
        await assignRoleByCode(user.id, person.role, []);
        await transitionStatus(user.id, "active");
      }
    },
  );

  await seedNotificationTemplates(tenant.id, h.slug, connection);
  await seedTariff(tenant.id, h.slug, connection);
  await seedFormulary(tenant.id, h.slug, connection);

  /**
   * Opening stock — DEMO ONLY, and through the real `receiveStock` service so every unit on the
   * shelf has an honest ledger entry behind it (never a raw `stockUnits` write). Idempotent: it
   * tops up only a medicine that has none, so re-running the seed does not inflate the shelf.
   */
  await runWithContext(
    { traceId: `seed-demo-stock-${h.slug}`, tenantId: tenant.id, tenantSlug: h.slug, connection },
    async () => {
      const expiry = new Date();
      expiry.setFullYear(expiry.getFullYear() + 1);
      let stocked = 0;
      for (const m of await listMedicines({})) {
        if (m.stockUnits > 0) continue;
        await receiveStock(m.id, {
          quantity: 200,
          batchNo: `OPEN-${String(expiry.getFullYear())}`,
          expiry,
        });
        stocked += 1;
      }
      if (stocked > 0) logger.info({ slug: h.slug, stocked }, "opening stock received");
    },
  );
}

async function main(): Promise<void> {
  if (env.NODE_ENV === "production") {
    // The only thing between a demo convenience and a breach.
    throw new Error("seed:demo creates accounts with the password '123456' — never in production");
  }

  for (const h of HOSPITALS) await seedHospital(h);

  const base = env.TENANT_BASE_DOMAIN;
  const port = 3000;
  const out: string[] = [
    "",
    "═".repeat(78),
    "  DEMO READY — every account's password is: 123456",
    "═".repeat(78),
  ];

  for (const h of HOSPITALS) {
    const billing =
      h.type === "government_hospital" ? "zero_tariff — every bill ₹0" : "prepaid — real prices";
    out.push(
      "",
      `  ${h.name}   (${h.type})`,
      `  http://${h.slug}.${base}:${String(port)}`,
      `  billing: ${billing}`,
      "",
    );
    for (const p of STAFF) {
      out.push(`    ${`${p.key}@${h.slug}.test`.padEnd(30)} ${p.role.padEnd(15)} ${p.does}`);
    }
  }

  out.push(
    "",
    "─".repeat(78),
    "  Operator console:  http://localhost:3001    ops@paperlesstech.in / 123456",
    "  Mailbox (all mail): http://localhost:8025",
    "─".repeat(78),
    "",
  );

  // stdout, not the logger: logs are shipped, indexed and retained, and this is a
  // block of credentials. It is meant for the terminal of the person who ran it.
  process.stdout.write(out.join("\n"));
}

main()
  .then(async () => {
    await closeAllTenantConnections();
    await closeMaster();
    await closeRedis();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    logger.error({ err }, "demo seed failed");
    await closeAllTenantConnections().catch(() => undefined);
    await closeMaster().catch(() => undefined);
    await closeRedis().catch(() => undefined);
    process.exit(1);
  });
