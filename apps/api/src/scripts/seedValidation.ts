/**
 * The MANUAL-VALIDATION environment — a ward you can actually round (dev only).
 *
 *     pnpm --filter @medicore/api seed:validation
 *     pnpm --filter @medicore/api seed:validation -- --verify
 *
 * `seed:demo` staffs a hospital. `seed:clinical` fills its OPD. Neither admits anybody, so the
 * nurse checklists (`AI_Workflow/docs/MOBILE_M3_DEVICE_CHECKLIST.md`) had no ward to open: no
 * beds, no admissions, no prescriptions, no second site. This builds exactly the dataset those
 * checklists ask for and nothing else.
 *
 * ── WHY THIS IS A SEPARATE COMMAND AND NOT PART OF `seed:clinical` ──────────
 * `seed:clinical` means "Sunrise's OPD, mid-flow" and people run it to demo a waiting room.
 * Folding forty admissions into it would change what that command produces for everybody who
 * already relies on it, and would tie two unrelated datasets together so neither could be
 * rebuilt without the other. Same directory, same shape, same guards — separate purpose.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * No vitals, no nursing notes, no administered doses. Those are the WRITES the checklist is
 * there to exercise by hand; seeding them would hand the tester a ward where the thing they
 * came to test has already happened. The script prepares the board and does not play the game.
 *
 * ── THE NUMBERS ARE READ FROM THE CODE, NOT INVENTED ────────────────────────
 * `medicationRoundQuerySchema` defaults to 20 rows a page and the web round asks for exactly
 * that, so 42 admissions is three pages with a partial last one — pagination, its footer, and
 * cross-page ordering all become observable. 45 beds leaves three free for a bed-transfer test.
 * The round pages over INPATIENTS and attaches doses afterwards (`medicationRound.ts`), so a
 * patient with no prescription is still a row — which is why only a dozen carry medication and
 * the rest are the "no scheduled doses today" case the checklist also asks for.
 *
 * Bed codes are `GW-1 … GW-45` ON PURPOSE. The server pages in bed order, which is a STRING
 * sort, so `GW-10` arrives before `GW-2`. Putting the natural-numeric fix under the tester's
 * eye is the point: a ward numbered `GW-01` would hide the very thing being checked.
 *
 * ── DEV ONLY ────────────────────────────────────────────────────────────────
 * Refuses to run in production, like its two siblings.
 */
import { createLogger } from "@medicore/logger";
import { env } from "../config/env.js";
import { runWithContext } from "../core/context/requestContext.js";
import { getTenantConnection, closeAllTenantConnections } from "../core/db/connectionManager.js";
import { closeMaster } from "../core/db/masterDb.js";
import { closeRedis } from "../core/redis/redis.js";
import { dayRangeInZone } from "../core/time/day.js";
import { tenantMigrations } from "../core/db/migrations/tenantMigrations.js";
import {
  verifyTenantSchema,
  schemaBlockedMessage,
  CLINICAL_SAFETY_INVARIANTS,
} from "../seed/schemaGuard.js";
import { getBySlug } from "../modules/tenants/index.js";
import { getByEmail } from "../modules/users/index.js";
import { listBranches, createBranch, updateBranch } from "../modules/branches/index.js";
import {
  listWards,
  listRooms,
  listBeds,
  createWard,
  createRoom,
  createBed,
} from "../modules/wards/index.js";
import { registerPatient, listPatients } from "../modules/patients/index.js";
import {
  startEncounter,
  queuePatient,
  startConsultation,
  admitPatient,
  listInpatients,
} from "../modules/encounters/index.js";
import { recordAllergy, activeForPatients } from "../modules/allergies/index.js";
import {
  createPrescription,
  signPrescription,
  listForEncounters,
} from "../modules/prescriptions/index.js";
import { slotsForStay, listByEncounters } from "../modules/mar/index.js";

const logger = createLogger({ service: "seed-validation" });

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}
const has = (flag: string): boolean => process.argv.includes(flag);

const SLUG = arg("--slug") ?? "sunrise";
const NURSE_EMAIL = `nurse@${SLUG}.test`;
const NURSE2_EMAIL = `nurse2@${SLUG}.test`;
const DOCTOR_EMAIL = arg("--doctor") ?? `drrao@${SLUG}.test`;

/**
 * Two sites, two clocks — 9½ hours apart in August.
 *
 * The pair is chosen so the two calendars disagree for most of a working day: Kolkata's midnight
 * is 14:30 in New York, which makes the "day rolls over at the WARD's midnight, not the phone's"
 * rows testable during office hours instead of at 3am. `Asia/Kolkata` is also the product's
 * `DEFAULT_TIMEZONE`, so branch A confirms the explicit value and branch B confirms that anything
 * still reading the default is wrong.
 */
const ZONE_A = "Asia/Kolkata";
const ZONE_B = "America/New_York";

const BRANCH_B = { name: "Riverside Annexe", code: "RIVERSIDE", timezone: ZONE_B };

const WARD_A = { name: "General Ward", kind: "general" as const, tariffCode: "BED_GEN" };
const WARD_B = { name: "Annexe Ward", kind: "general" as const, tariffCode: "BED_GEN" };

const BEDS_A = 45;
const BEDS_B = 6;
/** Three beds left free at A so the bed-transfer row has somewhere to move a patient to. */
const ADMISSIONS_A = 42;
const ADMISSIONS_B = 3;

/**
 * Enough registrations to push the long-stay patient out of the "100 most recent" window.
 *
 * D-1 was a ward page that resolved names from `listPatients({ limit: 100 })`, so a patient
 * admitted before the last hundred REGISTRATIONS rendered as `Patient: —`. With only the ward's
 * own patients in the database the old code would still find everybody and the test would pass
 * for the wrong reason. These filler registrations are what make WEB-02 able to fail.
 */
const FILLER_PATIENTS = 70;

/* ─────────────────────────────── identities ─────────────────────────────── */

const GIVEN = [
  "Aarav",
  "Diya",
  "Vihaan",
  "Ananya",
  "Arjun",
  "Ishita",
  "Kabir",
  "Meera",
  "Rohan",
  "Saanvi",
  "Aditya",
  "Kavya",
  "Nikhil",
  "Pooja",
  "Rahul",
  "Shreya",
  "Vikram",
  "Nisha",
  "Karan",
  "Divya",
];
const FAMILY = [
  "Sharma",
  "Reddy",
  "Nair",
  "Patel",
  "Iyer",
  "Ghosh",
  "Menon",
  "Kulkarni",
  "Bose",
  "Rao",
];

/** Deterministic and collision-free, so MPI duplicate detection never has to be forced. */
function identity(n: number): {
  name: string;
  gender: "male" | "female";
  dob: Date;
  phone: string;
} {
  const given = GIVEN[n % GIVEN.length] ?? "Aarav";
  const family = FAMILY[Math.floor(n / GIVEN.length) % FAMILY.length] ?? "Sharma";
  return {
    name: `${given} ${family} ${String(n).padStart(3, "0")}`,
    gender: n % 2 === 0 ? "female" : "male",
    // A distinct birthday per patient — same name-key plus same DOB is what MPI scores on.
    dob: new Date(Date.UTC(1950 + (n % 60), n % 12, (n % 27) + 1)),
    phone: `90000${String(10000 + n).slice(-5)}`,
  };
}

/* ─────────────────────────────── medication ─────────────────────────────── */

/**
 * Every drug here is on the seeded tariff/formulary (`seed/tariff.ts`), so the pharmacy can price
 * and dispense them and the allergy screen recognises them.
 *
 * Nothing in this table is a contraindication. The allergic patient (§allergies) is prescribed
 * PARACETAMOL, not the penicillin they react to — the allergy is seeded so the banner can be
 * SEEN, never so a signature has to be overridden. Seeding a deliberate contraindication would
 * mean seeding a prescription no prescriber should have signed.
 */
const PARA = { drugCode: "DRUG_PARA_500", drugName: "Paracetamol 500mg Tablet", dose: "500 mg" };
const PAN = { drugCode: "DRUG_PAN_40", drugName: "Pantoprazole 40mg Tablet", dose: "40 mg" };
const METF = { drugCode: "DRUG_METF_500", drugName: "Metformin 500mg Tablet", dose: "500 mg" };
const AMLO = { drugCode: "DRUG_AMLO_5", drugName: "Amlodipine 5mg Tablet", dose: "5 mg" };
const CETI = { drugCode: "DRUG_CETI_10", drugName: "Cetirizine 10mg Tablet", dose: "10 mg" };

interface LineSpec {
  drugCode: string;
  drugName: string;
  dose: string;
  route: "oral";
  frequency: "OD" | "BD" | "TDS" | "QID" | "SOS" | "HS";
  durationDays: number;
  quantity: number;
}
const line = (
  drug: { drugCode: string; drugName: string; dose: string },
  frequency: LineSpec["frequency"],
  quantity = 20,
): LineSpec => ({ ...drug, route: "oral", frequency, durationDays: 5, quantity });

/**
 * Six prescription shapes, each earning its place on the checklist.
 *
 * `DEFAULT_ROUND_TIMES` puts TDS at 08:00/14:00/20:00 and QID at 06:00/12:00/18:00/22:00 in the
 * WARD's zone, and a dose reads overdue an hour after its round — so due and overdue states arise
 * from the clock and no slot has to be fabricated. QID is here because its 06:00 round guarantees
 * an overdue dose from 07:00, which covers the whole working day; a ward carrying only TDS has
 * nothing overdue before 09:00.
 */
const RX_SHAPES: { label: string; lines: LineSpec[] }[] = [
  { label: "TDS — three slots today", lines: [line(PARA, "TDS")] },
  { label: "QID — guarantees an overdue dose from 07:00", lines: [line(PAN, "QID")] },
  {
    // The lineIndex case: the SAME drug scheduled AND as-required. Keying a dose on drugCode
    // would merge these two; keying on the line's position cannot.
    label: "same drug scheduled + SOS",
    lines: [line(PARA, "TDS"), line(PARA, "SOS", 10)],
  },
  {
    // Three lines, so the identity under test is a POSITION and not "the only line there is".
    label: "three lines — proves lineIndex identity",
    lines: [line(METF, "BD"), line(AMLO, "OD"), line(CETI, "HS")],
  },
  { label: "OD — one morning round", lines: [line(AMLO, "OD")] },
  { label: "BD — morning and evening", lines: [line(METF, "BD")] },
];

/** How many admitted patients carry medication. The rest are the "nothing due" rows. */
const MEDICATED = 12;

/**
 * Mirrors `OVERDUE_AFTER_MS` in `mar.service.ts`, which is module-private.
 *
 * Copied rather than exported because this is a REPORTING aid — it only decides what minute the
 * summary suggests you come back at. Nothing here influences a dose's real state, so if the two
 * ever drift the cost is a slightly early cup of tea, not a wrong clinical answer.
 */
const OVERDUE_AFTER_MS = 60 * 60 * 1000;

/* ───────────────────────────────── helpers ──────────────────────────────── */

interface Ctx {
  tenantId: string;
  tenantSlug: string;
  connection: Awaited<ReturnType<typeof getTenantConnection>>;
}

/** Runs `fn` as a real actor inside one branch, so writes are stamped the way a request would. */
async function asActor<T>(
  ctx: Ctx,
  userId: string,
  branchId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return runWithContext(
    {
      traceId: `seed-validation-${ctx.tenantSlug}`,
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      connection: ctx.connection,
      userId,
      ...(branchId ? { activeBranchId: branchId } : {}),
    },
    fn,
  );
}

/** Registers, starts a visit, calls the patient in, and admits them to `bedId`. */
async function admitOne(n: number, doctorId: string, bedId: string): Promise<string> {
  const who = identity(n);
  const { patient } = await registerPatient({
    name: who.name,
    gender: who.gender,
    dob: who.dob,
    contact: { phone: who.phone },
  });

  const { encounter } = await startEncounter({
    patientId: patient.id,
    origin: "walk_in",
    doctorId,
  });
  await queuePatient(encounter.id);
  await startConsultation(encounter.id);
  const { inpatient } = await admitPatient(encounter.id, { bedId, doctorId });
  return inpatient.id;
}

/* ──────────────────────────────── the seed ──────────────────────────────── */

/**
 * Two open sites in different zones — the precondition for every branch and timezone row.
 *
 * ── THIS SCRIPT DOES NOT RAISE THE PLAN, AND THAT IS DELIBERATE ─────────────
 * `DEFAULT_MAX_BRANCHES` is 1 and `provisionTenant` stamps no cap, so a freshly seeded hospital
 * is single-site and `createBranch` correctly refuses with `HMS-PLAN-001`. Calling `changePlan`
 * from here would be a seed script quietly entitling a tenant to software it was not sold —
 * exactly what `plan:manage` being SUPERADMIN-only exists to prevent, and the shape of a real
 * privilege-escalation bug this project already found once (see the A2 entry in the activity
 * log). So: refuse, and print the operator command that fixes it.
 *
 * A hospital that ALREADY has a second site (a dev database with earlier multi-branch work in
 * it) is adopted rather than added to — the goal is "two sites, two clocks", not "one more row".
 */
/** The site the seed actually used as branch B — its NAME, so the summary cannot misreport it. */
interface SiteB {
  id: string;
  name: string;
  adopted: boolean;
}

async function ensureBranchB(): Promise<SiteB> {
  const branches = await listBranches();

  const main = branches.find((b) => b.isMain);
  if (main && main.timezone !== ZONE_A) {
    await updateBranch(main.id, { timezone: ZONE_A });
    logger.info({ zone: ZONE_A }, "main branch timezone set");
  }

  const named = branches.find((b) => b.code === BRANCH_B.code);
  if (named) {
    if (named.timezone !== ZONE_B) await updateBranch(named.id, { timezone: ZONE_B });
    return { id: named.id, name: named.name, adopted: false };
  }

  try {
    const created = await createBranch(BRANCH_B);
    logger.info({ code: BRANCH_B.code, zone: ZONE_B }, "second branch created");
    return { id: created.id, name: created.name, adopted: false };
  } catch (err) {
    if ((err as { code?: string }).code !== "HMS-PLAN-001") throw err;

    // Capped out. If a second site is already here, use it; its name does not matter, its
    // clock does.
    const adoptable = branches.find((b) => !b.isMain && b.status === "active");
    if (adoptable) {
      if (adoptable.timezone !== ZONE_B) await updateBranch(adoptable.id, { timezone: ZONE_B });
      logger.warn(
        { adopted: adoptable.name, code: adoptable.code, zone: ZONE_B },
        "branch cap reached — adopted the existing second site as branch B",
      );
      return { id: adoptable.id, name: adoptable.name, adopted: true };
    }

    throw new Error(
      `This hospital is capped at one site, so the branch and timezone rows cannot be prepared.\n` +
        `  Raising a plan is an OPERATOR action and this script will not do it for you. Run:\n\n` +
        `      pnpm --filter @medicore/api plan -- --slug ${SLUG} --plan PLAN_HOSPITAL\n\n` +
        `  then re-run this seed. (PLAN_HOSPITAL allows 3 sites; \`plan -- --list\` shows the rest.)`,
    );
  }
}

/** Ward + one room + `count` beds, idempotent: it tops up what is missing and creates no duplicate. */
async function ensureWard(
  spec: { name: string; kind: "general"; tariffCode: string },
  prefix: string,
  count: number,
): Promise<string[]> {
  const wards = await listWards();
  const ward = wards.find((w) => w.name === spec.name) ?? (await createWard(spec));

  const rooms = await listRoomsOf(ward.id);
  const room =
    rooms.find((r) => r.name === "Bay 1") ??
    (await createRoom({ wardId: ward.id, kind: "general", name: "Bay 1" }));

  const beds = await listBeds(ward.id);
  const byCode = new Map(beds.map((b) => [b.code, b.id]));

  const ids: string[] = [];
  for (let n = 1; n <= count; n++) {
    const code = `${prefix}-${String(n)}`;
    const known = byCode.get(code);
    ids.push(known ?? (await createBed({ wardId: ward.id, roomId: room.id, code })).id);
  }
  return ids;
}

/** `listRooms` takes no ward filter, so narrow here rather than widening the repository. */
async function listRoomsOf(wardId: string): Promise<{ id: string; name: string }[]> {
  const rooms = await listRooms();
  return rooms.filter((r) => r.wardId === wardId).map((r) => ({ id: r.id, name: r.name }));
}

async function seed(ctx: Ctx, nurseId: string, doctorId: string): Promise<SiteB> {
  /* ── the sites ─────────────────────────────────────────────────────────── */
  const siteB = await asActor(ctx, nurseId, undefined, ensureBranchB);
  const branchBId = siteB.id;
  const branchAId = await asActor(ctx, nurseId, undefined, async () => {
    const main = (await listBranches()).find((b) => b.isMain);
    if (!main) throw new Error("no main branch — run `pnpm seed:demo` first");
    return main.id;
  });

  /* ── the estate ────────────────────────────────────────────────────────── */
  const bedsA = await asActor(ctx, doctorId, branchAId, () => ensureWard(WARD_A, "GW", BEDS_A));
  const bedsB = await asActor(ctx, doctorId, branchBId, () => ensureWard(WARD_B, "AW", BEDS_B));

  /* ── the long-stay patient, registered FIRST ───────────────────────────── */
  const already = await asActor(ctx, doctorId, branchAId, async () => {
    const { total } = await listInpatients({ limit: 1, skip: 0 });
    return total;
  });

  if (already >= ADMISSIONS_A) {
    logger.info({ already }, "ward already populated — skipping patients");
    /**
     * ── BUT THE DOSES ARE PERISHABLE, AND THE PATIENTS ARE NOT ────────────────
     * Returning here was the whole of the re-seed, and it made this script unable to fix the one
     * thing that actually goes wrong with age. A prescription is signed for `durationDays: 5`; a
     * week later the ward is still full, so this early return fires, and the medication round is
     * empty. The Playwright preflight then fails with "no doses are scheduled today — run
     * `pnpm seed:validation`", the tester runs it, it says "environment ready", and nothing
     * changes. A remedy that does not work is worse than no remedy: it costs the next person an
     * afternoon before they stop believing the message.
     *
     * So a populated ward still gets its medication topped up when today has no doses on it.
     */
    await topUpDoses(ctx, doctorId, branchAId);
    return siteB;
  }

  await asActor(ctx, doctorId, branchAId, async () => {
    // Patient 0 is the long-stay case: admitted before everything below is registered.
    const firstBed = bedsA[0];
    if (firstBed) await admitOne(0, doctorId, firstBed);

    for (let n = 0; n < FILLER_PATIENTS; n++) {
      const who = identity(1000 + n);
      await registerPatient({
        name: who.name,
        gender: who.gender,
        dob: who.dob,
        contact: { phone: who.phone },
      });
    }
    logger.info({ filler: FILLER_PATIENTS }, "recent-registration window filled");

    const ipIds: string[] = [];
    for (let n = 1; n < ADMISSIONS_A; n++) {
      const bed = bedsA[n];
      if (bed) ipIds.push(await admitOne(n, doctorId, bed));
    }
    logger.info({ admitted: ipIds.length + 1, branch: "A" }, "ward populated");

    /* ── allergies ───────────────────────────────────────────────────────── */
    const ward = await listInpatients({ limit: 100, skip: 0 });
    const severe = ward.items[1];
    const mild = ward.items[2];
    if (severe) {
      await recordAllergy({
        patientId: severe.patientId,
        allergen: "penicillins",
        severity: "severe",
        reaction: "Anaphylaxis — synthetic test record",
      });
    }
    if (mild) {
      await recordAllergy({
        patientId: mild.patientId,
        allergen: "sulfonamides",
        severity: "mild",
        reaction: "Rash — synthetic test record",
      });
    }

    /* ── medication ──────────────────────────────────────────────────────── */
    let charted = 0;
    for (const [i, stay] of ward.items.slice(0, MEDICATED).entries()) {
      const shape = RX_SHAPES[i % RX_SHAPES.length];
      if (!shape) continue;
      const rx = await createPrescription({ encounterId: stay.id, lines: shape.lines });
      await signPrescription(rx.id);
      charted += 1;
    }
    logger.info({ charted }, "prescriptions signed");
  });

  /* ── the second site, small but not empty ──────────────────────────────── */
  await asActor(ctx, doctorId, branchBId, async () => {
    for (let n = 0; n < ADMISSIONS_B; n++) {
      const bed = bedsB[n];
      if (!bed) continue;
      const stayId = await admitOne(2000 + n, doctorId, bed);
      if (n === 0) {
        const rx = await createPrescription({ encounterId: stayId, lines: [line(PARA, "TDS")] });
        await signPrescription(rx.id);
      }
    }
    logger.info({ admitted: ADMISSIONS_B, branch: "B" }, "annexe populated");
  });

  return siteB;
}

/**
 * Re-signs today's medication on a ward that is already populated.
 *
 * Only when there is nothing scheduled — a ward with live doses is left exactly alone, because
 * re-signing over a working dataset would pile duplicate prescriptions onto the same patients
 * every time anybody ran the script.
 */
async function topUpDoses(ctx: Ctx, doctorId: string, branchAId: string): Promise<void> {
  await asActor(ctx, doctorId, branchAId, async () => {
    const page = await listInpatients({ limit: 100, skip: 0 });
    const items = page.items.filter((e) => e.branchId === branchAId);
    if (items.length === 0) return;

    const zone = ZONE_A;
    const { from, before } = dayRangeInZone(dayKey(zone), zone);
    const encounterIds = items.map((e) => e.id);
    const prescriptions = await listForEncounters(encounterIds);
    const administrations = await listByEncounters(encounterIds);

    const slots = items.reduce(
      (n, stay) =>
        n +
        slotsForStay({
          prescriptions: prescriptions.filter((p) => p.encounterId === stay.id),
          administrations: administrations.filter((a) => a.encounterId === stay.id),
          zone,
          from,
          before,
          now: Date.now(),
        }).length,
      0,
    );

    if (slots > 0) {
      logger.info({ slots }, "doses already scheduled today — leaving medication alone");
      return;
    }

    let charted = 0;
    for (const [i, stay] of items.slice(0, MEDICATED).entries()) {
      const shape = RX_SHAPES[i % RX_SHAPES.length];
      if (!shape) continue;
      const rx = await createPrescription({ encounterId: stay.id, lines: shape.lines });
      await signPrescription(rx.id);
      charted += 1;
    }
    logger.info({ charted }, "medication topped up — the previous prescriptions had run out");
  });
}

/* ─────────────────────────── read-only verification ─────────────────────── */

interface Check {
  what: string;
  ok: boolean;
  detail: string;
}

/**
 * Proves the environment WITHOUT writing to it.
 *
 * Every check is a read. Charting a dose to prove the MAR works would consume the very slot the
 * tester is coming to use, and a seed that plays the first move of the test it is preparing is
 * worse than no seed at all.
 */
async function verify(ctx: Ctx): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (what: string, ok: boolean, detail: string): void => {
    checks.push({ what, ok, detail });
  };

  const nurse = await runWithContext(baseCtx(ctx), () => getByEmail(NURSE_EMAIL));
  const nurse2 = await runWithContext(baseCtx(ctx), () => getByEmail(NURSE2_EMAIL));
  add("nurse account", nurse !== undefined, nurse ? NURSE_EMAIL : `${NURSE_EMAIL} MISSING`);
  add(
    "second nurse (concurrency test)",
    nurse2 !== undefined,
    nurse2 ? NURSE2_EMAIL : `${NURSE2_EMAIL} MISSING`,
  );

  const branches = await runWithContext(baseCtx(ctx), () => listBranches());
  const main = branches.find((b) => b.isMain);
  /**
   * Branch B is "the other open site", found by SHAPE and not by name.
   *
   * The seed adopts an existing second branch when the plan cap forbids creating one, so keying
   * this on `BRANCH_B.code` reported the environment broken on exactly the databases where it was
   * fine. A verifier that only recognises the happy path is a verifier that cries wolf.
   */
  const annexe = branches.find((b) => !b.isMain && b.status === "active");
  add(
    "branch A timezone",
    main?.timezone === ZONE_A,
    `${main?.name ?? "?"} → ${main?.timezone ?? "UNSET"}`,
  );
  add(
    "branch B timezone",
    annexe?.timezone === ZONE_B,
    `${annexe?.name ?? "MISSING"} → ${annexe?.timezone ?? "UNSET"}`,
  );
  add(
    "timezones differ materially",
    main?.timezone !== undefined &&
      annexe?.timezone !== undefined &&
      main.timezone !== annexe.timezone,
    `${main?.timezone ?? "?"} vs ${annexe?.timezone ?? "?"}`,
  );

  await asActor(ctx, nurse?.id ?? "", main?.id, async () => {
    const wards = await listWards();
    const ward = wards.find((w) => w.name === WARD_A.name);
    add("ward", ward !== undefined, ward?.name ?? "MISSING");

    const beds = ward ? await listBeds(ward.id) : [];
    add("beds ≥ 40", beds.length >= 40, `${String(beds.length)} beds`);

    /**
     * Counted PER BRANCH, by hand.
     *
     * `scopeFilter()` returns `{}` when the context carries no `scope` — which a script never
     * has — so `listInpatients` here spans every site regardless of `activeBranchId`, and the
     * first version of this check happily reported branch B's three patients as forty-five.
     */
    const page = await listInpatients({ limit: 100, skip: 0 });
    const items = page.items.filter((e) => e.branchId === main?.id);
    add("admissions > one page (20)", items.length > 20, `${String(items.length)} at branch A`);
    add("admissions ≥ two full pages", items.length >= 40, `${String(items.length)} at branch A`);

    const named = items.filter((e) => e.patientId).length;
    add(
      "every stay resolves a patient",
      named === items.length,
      `${String(named)}/${String(items.length)}`,
    );

    const allergies = await activeForPatients(items.map((e) => e.patientId));
    const severe = allergies.filter((a) => a.severity === "severe");
    add(
      "severe allergy present",
      severe.length > 0,
      `${String(severe.length)} severe, ${String(allergies.length)} total`,
    );

    const encounterIds = items.map((e) => e.id);
    const prescriptions = await listForEncounters(encounterIds);
    const administrations = await listByEncounters(encounterIds);
    add("prescriptions signed", prescriptions.length > 0, `${String(prescriptions.length)} live`);

    const zone = main?.timezone ?? ZONE_A;
    const { from, before } = dayRangeInZone(dayKey(zone), zone);
    let due = 0;
    let overdue = 0;
    let prn = 0;
    let nextOverdueAt = Number.POSITIVE_INFINITY;
    const lineIndices = new Set<number>();
    for (const stay of items) {
      const slots = slotsForStay({
        prescriptions: prescriptions.filter((p) => p.encounterId === stay.id),
        administrations: administrations.filter((a) => a.encounterId === stay.id),
        zone,
        from,
        before,
        now: Date.now(),
      });
      for (const s of slots) {
        if (s.state === "due") {
          due += 1;
          nextOverdueAt = Math.min(nextOverdueAt, Date.parse(s.scheduledFor) + OVERDUE_AFTER_MS);
        }
        if (s.state === "overdue") overdue += 1;
        lineIndices.add(s.lineIndex);
      }
    }
    for (const p of prescriptions) {
      prn += p.lines.filter((l) => l.frequency === "SOS").length;
    }
    add("due doses today", due > 0, `${String(due)} due`);

    /**
     * Overdue is a CLOCK state, not a seeded one — and it cannot be seeded honestly.
     *
     * A course runs from `signedAt` (`courseOf`), so a prescription written at noon has no 08:00
     * dose to be late for: you cannot be overdue for a dose that was ordered after it was due.
     * That is correct, and the only way to fake it is to backdate a signature — writing a false
     * time onto a medico-legal record, which this script will not do even in synthetic data.
     *
     * So this is INFORMATIONAL. It reports the wall-clock moment the ward's first dose tips
     * over, which is what the tester actually needs in order to schedule the urgency-ordering
     * rows (M3 §7) rather than sit refreshing.
     */
    add(
      overdue > 0 ? "overdue doses today" : "overdue doses (waiting on the clock)",
      true,
      overdue > 0
        ? `${String(overdue)} overdue now`
        : Number.isFinite(nextOverdueAt)
          ? `none yet — first at ${timeIn(new Date(nextOverdueAt), zone)} ward time (${zone})`
          : "no scheduled doses at all — re-run the seed",
    );
    add(
      "lineIndex > 0 in play",
      lineIndices.size > 1,
      `line indices ${[...lineIndices].sort((a, b) => a - b).join(", ")}`,
    );
    add("PRN (SOS) line present", prn > 0, `${String(prn)} as-required lines`);

    const withoutDoses = items.filter(
      (e) => prescriptions.filter((p) => p.encounterId === e.id).length === 0,
    ).length;
    add("patients with nothing due", withoutDoses > 0, `${String(withoutDoses)} quiet rows`);

    /**
     * The D-1 precondition, and the one worth checking hardest.
     *
     * WEB-02 asks whether the ward names a patient who is NOT among the hundred most recently
     * registered — the exact window the old browser-side lookup searched. If every admitted
     * patient happens to be inside that window the screen renders correctly for the wrong
     * reason and the test proves nothing. So: confirm at least one admitted patient is outside
     * it, and name them, because the tester has to know who to click.
     */
    const recent = await listPatients({ page: 1, limit: 100 });
    const inWindow = new Set(recent.patients.map((p) => p.id));
    const outside = items.filter((e) => !inWindow.has(e.patientId));
    const longStay = recent.total > 100 ? outside[0] : undefined;
    add(
      "long-stay patient outside the recent-100 window (D-1)",
      longStay !== undefined,
      longStay
        ? `${String(outside.length)} of ${String(items.length)} — e.g. bed ${longStay.bed?.bedCode ?? "?"} (${String(recent.total)} patients registered in total)`
        : `only ${String(recent.total)} patients exist — WEB-02 cannot fail, so it cannot pass`,
    );
  });

  await asActor(ctx, nurse?.id ?? "", annexe?.id, async () => {
    // Filtered by branch for the same reason as branch A above — a script has no row scope.
    const page = await listInpatients({ limit: 100, skip: 0 });
    const mine = page.items.filter((e) => e.branchId === annexe?.id);
    add(
      "branch B has its own patients",
      mine.length > 0,
      `${String(mine.length)} admitted at ${annexe?.name ?? "the second site"}`,
    );
  });

  return checks;
}

function baseCtx(ctx: Ctx): Parameters<typeof runWithContext>[0] {
  return {
    traceId: `seed-validation-verify-${ctx.tenantSlug}`,
    tenantId: ctx.tenantId,
    tenantSlug: ctx.tenantSlug,
    connection: ctx.connection,
  };
}

/** `14:00` in the ward's clock — the answer the tester needs, not a UTC instant. */
function timeIn(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}

function dayKey(zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/* ──────────────────────────────────  main  ──────────────────────────────── */

async function main(): Promise<void> {
  if (env.NODE_ENV === "production") {
    throw new Error("seed:validation creates synthetic patients — never in production");
  }

  const tenant = await getBySlug(SLUG);
  if (!tenant) throw new Error(`hospital '${SLUG}' not found — run \`pnpm seed:demo\` first`);

  const connection = await getTenantConnection({
    id: tenant.id,
    databaseName: tenant.databaseName,
    ...(tenant.dbUri ? { dbUri: tenant.dbUri } : {}),
  });
  const ctx: Ctx = { tenantId: tenant.id, tenantSlug: SLUG, connection };

  /**
   * ── THE SCHEMA IS CHECKED BEFORE ANYTHING ELSE, ON BOTH PATHS ───────────────
   * Before verifying, because nineteen green data checks against a database that cannot enforce
   * dose uniqueness is not a partial pass — it is a confident wrong answer, and the reader has no
   * way to tell. Before SEEDING for the same reason: building a ward into an unenforceable database
   * manufactures exactly the environment that produced the 2026-08-14 false failures.
   *
   * It short-circuits rather than joining the checklist. A missing constraint is not one more red
   * line among twenty; it invalidates the other nineteen.
   */
  const schema = await verifyTenantSchema(connection, tenantMigrations);
  if (!schema.ok) {
    process.stdout.write(schemaBlockedMessage(SLUG, schema));
    process.exitCode = 1;
    return;
  }

  if (has("--verify")) {
    const checks = await verify(ctx);
    const pad = Math.max(...checks.map((c) => c.what.length));
    const lines = checks.map((c) => `  ${c.ok ? "✓" : "✗"} ${c.what.padEnd(pad)}  ${c.detail}`);
    const failed = checks.filter((c) => !c.ok).length;
    const armed = CLINICAL_SAFETY_INVARIANTS.map((i) => `  ✓ ${i.rule}`).join("\n");
    process.stdout.write(
      `\n  Manual-validation environment — ${SLUG}\n${"─".repeat(78)}\n` +
        `  SCHEMA — the database can enforce what is being validated\n${armed}\n` +
        `  ✓ every migration applied (${String(tenantMigrations.length)})\n\n` +
        `  DATA\n${lines.join("\n")}\n${"─".repeat(78)}\n` +
        (failed === 0
          ? "  READY — schema armed, every data check passed.\n\n"
          : `  ${String(failed)} data check(s) failed. Run \`pnpm seed:validation\` (and \`seed:demo\` first if accounts are missing).\n\n`),
    );
    if (failed > 0) process.exitCode = 1;
    return;
  }

  const nurse = await runWithContext(baseCtx(ctx), () => getByEmail(NURSE_EMAIL));
  const doctor = await runWithContext(baseCtx(ctx), () => getByEmail(DOCTOR_EMAIL));
  if (!nurse) throw new Error(`${NURSE_EMAIL} not found — run \`pnpm seed:demo\` first`);
  if (!doctor) throw new Error(`${DOCTOR_EMAIL} not found — run \`pnpm seed:demo\` first`);

  const siteB = await seed(ctx, nurse.id, doctor.id);

  process.stdout.write(
    "\n" +
      `  Manual-validation environment ready — ${SLUG}\n` +
      `${"─".repeat(78)}\n` +
      `  Nurse         ${NURSE_EMAIL} / 123456\n` +
      `  Second nurse  ${NURSE2_EMAIL} / 123456   — for the concurrent-dose test\n` +
      `  Branch A      Main Branch · ${ZONE_A}\n` +
      `  Branch B      ${siteB.name} · ${ZONE_B}` +
      (siteB.adopted
        ? "   ← ADOPTED an existing site (branch cap reached);\n                the checklist's 'Branch B' is this one\n"
        : "\n") +
      `  Ward          ${WARD_A.name} · ${String(BEDS_A)} beds · ${String(ADMISSIONS_A)} admitted\n` +
      `  Round         http://${SLUG}.localhost:3000/medication-round\n` +
      `${"─".repeat(78)}\n` +
      "  Verify any time:  pnpm seed:validation -- --verify\n\n",
  );
}

main()
  .then(async () => {
    await closeAllTenantConnections();
    await closeMaster();
    await closeRedis();
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (err: unknown) => {
    logger.error({ err }, "validation seed failed");
    await closeAllTenantConnections().catch(() => undefined);
    await closeMaster().catch(() => undefined);
    await closeRedis().catch(() => undefined);
    process.exit(1);
  });
