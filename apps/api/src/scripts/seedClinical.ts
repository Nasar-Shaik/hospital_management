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
import { Types } from "mongoose";
import { getPatientModel } from "../modules/patients/patient.model.js";
import { listBranches } from "../modules/branches/index.js";
import { getTenantDb } from "../core/context/requestContext.js";
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
/** `--patients 300` adds a register big enough for paging and date ranges to be visible. */
const BULK = Number(arg("--patients") ?? 0);

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
 * ── A REGISTER BIG ENOUGH TO BEHAVE LIKE A REGISTER ─────────────────────────
 * `pnpm seed:clinical -- --patients 300`
 *
 * The six specs above are a cross-section of ONE DAY, and they are the right shape for testing
 * the queue. They are the wrong shape for testing the patient register: with six rows, paging,
 * newest-first ordering and a date range are all invisible — the page looks identical whether it
 * works or not. That is how manual testing reported "it loads every patient" against a screen
 * that has paged at 50 since it was written.
 *
 * These are deliberately BORING. No encounters, no orders, no bills — just identities in the MPI,
 * which is exactly what the register lists. Anything else would make the queue screens lie.
 *
 * ── WHY createdAt IS BACKDATED ──────────────────────────────────────────────
 * Mongoose stamps `createdAt` at insert, so a bulk seed lands three hundred patients inside one
 * second. Every one of them then matches every date range, and the filter cannot be told from a
 * no-op. Spread over the last six months instead, weighted towards recent, the way a real
 * hospital's register grows. `timestamps: false` on the update is required or Mongoose overwrites
 * the value we just set.
 */
const GIVEN = [
  "Aarav",
  "Vivaan",
  "Aditya",
  "Arjun",
  "Reyansh",
  "Krishna",
  "Ishaan",
  "Rohan",
  "Ananya",
  "Diya",
  "Saanvi",
  "Aadhya",
  "Kavya",
  "Meera",
  "Priya",
  "Riya",
  "Fatima",
  "Zainab",
  "Ayesha",
  "Imran",
  "Rizwan",
  "Farhan",
  "Lakshmi",
  "Padma",
  "Sunita",
  "Kamala",
  "Radha",
  "Geeta",
] as const;
const FAMILY = [
  "Sharma",
  "Verma",
  "Reddy",
  "Naidu",
  "Iyer",
  "Nair",
  "Menon",
  "Pillai",
  "Kumar",
  "Singh",
  "Patel",
  "Shah",
  "Desai",
  "Joshi",
  "Rao",
  "Gupta",
  "Sheikh",
  "Khan",
  "Ansari",
  "Das",
  "Bose",
  "Chatterjee",
] as const;

/** Deterministic, so a re-run produces the same register rather than a second one. */
function syntheticSpec(n: number): {
  name: string;
  gender: Gender;
  ageYears: number;
  phone: string;
  dob: Date;
} {
  const given = GIVEN[n % GIVEN.length] as string;
  const family = FAMILY[(n * 7) % FAMILY.length] as string;
  // The name alone repeats every ~600; the serial keeps them distinct for duplicate detection
  // without making the list look generated.
  const name = `${given} ${family}`;
  const female = [
    "Ananya",
    "Diya",
    "Saanvi",
    "Aadhya",
    "Kavya",
    "Meera",
    "Priya",
    "Riya",
    "Fatima",
    "Zainab",
    "Ayesha",
    "Lakshmi",
    "Padma",
    "Sunita",
    "Kamala",
    "Radha",
    "Geeta",
  ];
  return {
    name,
    gender: female.includes(given) ? "female" : "male",
    ageYears: 6 + ((n * 13) % 78),
    // 9 8 …: a valid Indian mobile shape, unique per index so no two collide.
    phone: `98${String(10_000_000 + n * 37).slice(0, 8)}`,
    /**
     * A real birthday, not `dobForAge` — which returns TODAY minus N years, so every synthetic
     * patient of the same age shares one date. `findCandidates` matches on exact `dob`, so that
     * handed the duplicate detector a pile of same-birthday, same-gender people and it refused
     * 17 of the first 20 registrations. The detector was right; the data was wrong.
     */
    dob: birthday(n, 6 + ((n * 13) % 78)),
  };
}

/** Spread across the year and the month, so no two synthetic patients share a birthday by accident. */
function birthday(n: number, ageYears: number): Date {
  const d = new Date();
  d.setFullYear(d.getFullYear() - ageYears);
  d.setMonth(n % 12, 1 + ((n * 11) % 28));
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Weighted towards the present: half the register arrived in the last six weeks, the rest trails
 * back six months. A flat spread would make "last 7 days" and "last 6 months" return suspiciously
 * similar counts, which is the sort of thing that makes a tester doubt a working filter.
 */
function backdatedAt(n: number, total: number): Date {
  const fraction = n / Math.max(1, total - 1);
  const daysAgo = Math.round(180 * fraction ** 2);
  const at = new Date();
  at.setDate(at.getDate() - daysAgo);
  at.setHours(8 + (n % 10), (n * 17) % 60, 0, 0);
  return at;
}

async function seedRegister(count: number): Promise<void> {
  const model = getPatientModel(getTenantDb());
  const skipped: string[] = [];
  let made = 0;

  for (let n = 0; n < count; n++) {
    const spec = syntheticSpec(n);
    let id: string;
    try {
      const { patient } = await registerPatient({
        name: spec.name,
        gender: spec.gender,
        dob: spec.dob,
        contact: { phone: spec.phone },
        /**
         * A seed asked for N distinct people and knows they are distinct — the names come from a
         * fixed pool, so a big enough register WILL eventually re-use one, and the detector will
         * correctly flag it. Forcing here is the same judgement a clerk makes on the review
         * screen, made once, in writing. It is not a workaround for the bug above: that was a
         * shared birthday, and it is fixed at the source.
         */
        force: true,
      });
      id = patient.id;
    } catch (err) {
      /**
       * SAYS WHY. The first version of this loop was `catch { continue }` with a comment
       * assuring the reader it was fine — and it silently skipped 17 of 20 patients while
       * reporting nothing, in a repository whose recurring defect is a step that reports success
       * and does nothing. The reason is almost always the duplicate detector doing its job on a
       * re-run; if it is anything else, this is where you find out.
       */
      skipped.push(`${spec.name} (${spec.phone}): ${(err as Error).message}`);
      continue;
    }

    /**
     * Mongoose stamps `createdAt` on insert, so without this every synthetic patient shares one
     * second and no date range can be distinguished from a no-op. `timestamps: false` stops the
     * update itself re-stamping `updatedAt` over the value.
     *
     * The result is CHECKED. A filter that matches nothing is the same silence as the catch above.
     */
    const at = backdatedAt(n, count);
    /**
     * `model.collection`, not `model` — the RAW driver, deliberately.
     *
     * `patientSchema` carries `auditPlugin`, which hooks `updateOne` and wrote back a result with
     * no `matchedCount` (this loop caught that, because it checks). Two reasons not to fight it:
     * the audit trail is a record of what people did to a patient, and three hundred rows saying
     * "patient updated" would be noise in a log somebody has to read; and correcting the insert
     * timestamp of a row this same function just inserted is not a clinical event. The model is
     * already bound to the tenant connection, so this is the right collection either way.
     */
    const result = await model.collection.updateOne(
      { _id: new Types.ObjectId(id) },
      { $set: { createdAt: at } },
    );
    if (result.matchedCount !== 1) {
      throw new Error(
        `could not backdate ${spec.name} (${id}) — matched ${String(result.matchedCount)}`,
      );
    }

    made++;
    if (made % 50 === 0) logger.info({ made, of: count }, "registering…");
  }

  logger.info({ requested: count, created: made, skipped: skipped.length }, "register seeded");
  for (const reason of skipped.slice(0, 5)) logger.info({ reason }, "skipped");
  if (skipped.length > 5) logger.info({ more: skipped.length - 5 }, "…and more skipped");
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

      /**
       * ── THE SITE THE WRITES BELONG TO (ADR-0015) ──────────────────────────
       * This script predates the branch model and never set one, so every `startEncounter` it
       * attempted died on `branchId: Path \`branchId\` is required` — after the first patient had
       * already been registered, leaving a half-seeded hospital and an exit code nobody reads in a
       * seed script. A request carries the site in `X-Active-Branch`; a script has to say it out
       * loud, exactly as `seedValidation` does.
       */
      const branches = await listBranches();
      const site = branches.find((b) => b.isMain) ?? branches[0];
      if (!site) {
        throw new Error(`${SLUG} has no branch — provisioning did not finish`);
      }
      // The clinical actions are attributed to Dr Rao — orders carry them as the requester.
      await runWithContext(
        {
          traceId: `seed-clinical-${SLUG}`,
          tenantId: tenant.id,
          tenantSlug: SLUG,
          connection,
          userId: doctor.id,
          activeBranchId: site.id,
        },
        async () => {
          for (const spec of PATIENTS) await seedPatient(spec, doctor.id);
          if (BULK > 0) await seedRegister(BULK);
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
