/**
 * Clinical demo data — patients already moving through the hospital (dev only).
 *
 *     pnpm --filter @medicore/api seed:clinical
 *
 * `seed:demo` staffs a hospital and prices it, but leaves it EMPTY — no patients, no visits. This
 * fills Sunrise with a handful of patients frozen at each stage of the OPD flow, so a tester opening
 * the app finds a populated reception register, a doctor's queue with people waiting, and a lab
 * worklist with tests to run — instead of a blank screen they must click their way out of.
 *
 * ── WHY SUNRISE ONLY ────────────────────────────────────────────────────────
 * Sunrise routes patients to a NAMED DOCTOR (Dr Rao), which this script has. District General routes
 * to a DEPARTMENT, and no departments are seeded there — so clinical data would need a department to
 * hang off first. District stays the empty ₹0 comparison; the clinical story lives at Sunrise.
 *
 * ── WHY SOME BILLS APPEAR A MOMENT LATER ────────────────────────────────────
 * Billing is event-driven: the consultation and each test are charged by a WORKER reacting to the
 * events these service calls publish. Run this with `pnpm dev` up and the charges land within a
 * second or two. Run it alone and the visits exist immediately; the bills follow when the workers do.
 *
 * ── DEV ONLY ────────────────────────────────────────────────────────────────
 * Refuses to run in production, like `seed:demo`.
 */
import { createLogger } from "@medicore/logger";
import { env } from "../config/env.js";
import { runWithContext } from "../core/context/requestContext.js";
import { getTenantConnection, closeAllTenantConnections } from "../core/db/connectionManager.js";
import { closeMaster } from "../core/db/masterDb.js";
import { closeRedis } from "../core/redis/redis.js";
import { getBySlug } from "../modules/tenants/index.js";
import { getByEmail } from "../modules/users/index.js";
import { registerPatient, type Gender } from "../modules/patients/index.js";
import {
  startEncounter,
  queuePatient,
  startConsultation,
  sendForInvestigations,
} from "../modules/encounters/index.js";
import { placeOrder } from "../modules/orders/index.js";

const logger = createLogger({ service: "seed-clinical" });

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

// Defaults target the ready-made Sunrise demo; override to seed a hospital you provisioned yourself.
//   pnpm --filter @medicore/api seed:clinical -- --slug apollo --doctor drx@apollo.test
const SLUG = arg("--slug") ?? "sunrise";
const DOCTOR_EMAIL = arg("--doctor") ?? `drrao@${SLUG}.test`;

/** A test the doctor can order — the code resolves against Sunrise's seeded tariff. */
interface OrderSpec {
  category: "lab" | "radiology";
  code: string;
  name: string;
}
const CBC: OrderSpec = { category: "lab", code: "CBC", name: "Complete Blood Count" };
const XRAY: OrderSpec = {
  category: "radiology",
  code: "XRAY_CHEST_PA",
  name: "X-ray Chest PA View",
};

/** How far along the flow to leave each patient. */
type Stage = "registered" | "queued" | "consulting" | "ordered" | "investigations";

interface PatientSpec {
  name: string;
  gender: Gender;
  ageYears: number;
  phone: string;
  reason: string;
  stage: Stage;
  orders?: OrderSpec[];
}

/** A cross-section of the day: some just arrived, some waiting, some mid-consult, some at the lab. */
const PATIENTS: PatientSpec[] = [
  {
    name: "Fatima Sheikh",
    gender: "female",
    ageYears: 34,
    phone: "9800000001",
    reason: "fever and body ache",
    stage: "registered",
  },
  {
    name: "Anil Kumar",
    gender: "male",
    ageYears: 52,
    phone: "9800000002",
    reason: "follow-up, blood pressure",
    stage: "queued",
  },
  {
    name: "Sunita Devi",
    gender: "female",
    ageYears: 41,
    phone: "9800000003",
    reason: "cough for two weeks",
    stage: "queued",
  },
  {
    name: "Mohammed Farah",
    gender: "male",
    ageYears: 28,
    phone: "9800000004",
    reason: "abdominal pain",
    stage: "consulting",
  },
  {
    name: "Lakshmi Nair",
    gender: "female",
    ageYears: 60,
    phone: "9800000005",
    reason: "fatigue, ? anaemia",
    stage: "ordered",
    orders: [CBC],
  },
  {
    name: "Rajesh Gupta",
    gender: "male",
    ageYears: 47,
    phone: "9800000006",
    reason: "chest pain, breathless",
    stage: "investigations",
    orders: [CBC, XRAY],
  },
];

function dobForAge(years: number): Date {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d;
}

/**
 * Drive one patient to their target stage through the SAME services the app uses — register, start a
 * walk-in for Dr Rao, queue them, call them in, order tests, send for investigations. Each step only
 * runs if the stage calls for it. Re-running is safe: a would-be duplicate registration is caught and
 * that patient is skipped, so the seed never blows up on data it already created.
 */
async function seedPatient(spec: PatientSpec, doctorId: string): Promise<void> {
  let patientId: string;
  try {
    const { patient } = await registerPatient({
      name: spec.name,
      gender: spec.gender,
      dob: dobForAge(spec.ageYears),
      contact: { phone: spec.phone },
    });
    patientId = patient.id;
  } catch (err) {
    logger.info(
      { name: spec.name, err: (err as Error).message },
      "patient exists already — skipping",
    );
    return;
  }

  if (spec.stage === "registered") {
    logger.info({ name: spec.name }, "registered");
    return;
  }

  const { encounter } = await startEncounter({
    patientId,
    origin: "walk_in",
    doctorId,
    reason: spec.reason,
  });
  let status = encounter.status;

  // Reception's "Add to queue": a private hospital starts a walk-in as `arrived`, so queue it.
  if (status === "arrived") {
    status = (await queuePatient(encounter.id)).status;
  }
  if (spec.stage === "queued") {
    logger.info({ name: spec.name }, "waiting in the doctor's queue");
    return;
  }

  // Call them in.
  if (status === "in_queue" || status === "arrived") {
    status = (await startConsultation(encounter.id)).status;
  }
  if (spec.stage === "consulting") {
    logger.info({ name: spec.name }, "called in — with the doctor");
    return;
  }

  // Order the tests.
  for (const o of spec.orders ?? []) {
    await placeOrder({
      encounterId: encounter.id,
      category: o.category,
      code: o.code,
      name: o.name,
      requestId: `seed:${encounter.id}:${o.code}`,
    });
  }
  if (spec.stage === "ordered") {
    logger.info(
      { name: spec.name, tests: spec.orders?.length ?? 0 },
      "tests ordered — with the doctor",
    );
    return;
  }

  // Send them to the lab to wait for results.
  await sendForInvestigations(encounter.id);
  logger.info({ name: spec.name, tests: spec.orders?.length ?? 0 }, "at the lab, awaiting results");
}

async function main(): Promise<void> {
  if (env.NODE_ENV === "production") {
    throw new Error("seed:clinical creates demo patients — never in production");
  }

  const tenant = await getBySlug(SLUG);
  if (!tenant) {
    throw new Error(
      `Hospital "${SLUG}" not found — run \`pnpm --filter @medicore/api seed:demo\` first`,
    );
  }

  const connection = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
    ...(tenant.dbUri ? { dbUri: tenant.dbUri } : {}),
  });

  await runWithContext(
    { traceId: `seed-clinical-${SLUG}`, tenantId: tenant.id, tenantSlug: SLUG, connection },
    async () => {
      const doctor = await getByEmail(DOCTOR_EMAIL);
      if (!doctor) {
        throw new Error(`${DOCTOR_EMAIL} not found — run \`seed:demo\` first`);
      }
      // The clinical actions are attributed to Dr Rao — orders carry them as the requester.
      await runWithContext(
        {
          traceId: `seed-clinical-${SLUG}`,
          tenantId: tenant.id,
          tenantSlug: SLUG,
          connection,
          userId: doctor.id,
        },
        async () => {
          for (const spec of PATIENTS) await seedPatient(spec, doctor.id);
        },
      );
    },
  );

  process.stdout.write(
    "\n" +
      "  ┌─ Clinical demo data ready (Sunrise) ─────────────────────────┐\n" +
      "     Reception  http://sunrise.localhost:3000/reception   — the day's register\n" +
      "     Doctor     drrao@sunrise.test → My patients          — a queue with people\n" +
      "     Lab        labtech@sunrise.test → Worklist           — CBC + X-ray to run\n" +
      "     (Bills appear once the workers relay the events — run `pnpm dev`.)\n" +
      "  └───────────────────────────────────────────────────────────────┘\n\n",
  );
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, "seed:clinical failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([closeAllTenantConnections(), closeMaster(), closeRedis()]);
  });
