/**
 * The laboratory's starter catalogue — the five tests an Indian OPD actually runs all day.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * `labTests` shipped EMPTY, exactly as `icdCodes` did before its starter set. The consequence was
 * not a missing nicety. `labTest.model.ts` states the module's whole purpose: before it, "at result
 * entry the technician RE-TYPED the analyte names, units and reference ranges for every single
 * report. That is how a reference range becomes wrong: typed from memory, at 2am, on the report
 * that matters." With the collection empty, that is still what happens — `getLabTest(order.code)`
 * finds nothing and the worklist silently falls back to the blank manual grid (`worklist/page.tsx`).
 *
 * So the module was built, migrated, routed and given a UI, and then did nothing on any hospital,
 * because nobody was ever going to hand-type it first.
 *
 * ── THE CODES ARE THE TARIFF'S CODES, AND THAT IS THE WHOLE JOIN ────────────
 * `CBC`, `LFT`, `RFT`, `GLU`, `LIPID` are lifted from `DEFAULT_TARIFF`, because an order carries one
 * `code` that has to mean the same thing to three different systems: billing prices it, the lab
 * defines it, and the result grid pre-fills from it. A catalogue keyed on anything else would be a
 * second master that agrees with the first only by luck.
 *
 * The tariff's other lab codes (TSH, URINE_RE, DENGUE_NS1…) are deliberately NOT here. A test with
 * no catalogue entry still orders, still bills, still reaches the bench and still takes a result —
 * it just gets the manual grid. That fallback is the honest behaviour for a hospital's own tests,
 * and pretending to own reference ranges we have not curated would be worse than the blank.
 *
 * ── THE RANGES ARE ADULT DEFAULTS, NOT THIS LAB'S RANGES ────────────────────
 * A reference interval belongs to the method and the analyser that produced it, and a real
 * laboratory sets its own. These are the common adult intervals so a hospital can begin, and every
 * row is `$setOnInsert` — the same promise the tariff and the ICD master make: what a hospital has
 * curated is theirs, and re-running this never overwrites it. Sexed intervals (haemoglobin,
 * creatinine) are given as the combined adult range, because the model holds ONE interval per
 * analyte and inventing a second dimension for a v1 catalogue would be modelling for its own sake.
 */
import { createLogger } from "@medicore/logger";
import type { Connection } from "mongoose";
import { runWithContext } from "../core/context/requestContext.js";
import { getLabTestModel, type Analyte } from "../modules/labCatalogue/labTest.model.js";

const logger = createLogger({ service: "seed-lab-tests" });

interface LabTestSeed {
  /** Must match the `serviceItems` code an order carries — see the header. */
  code: string;
  name: string;
  specimenType: string;
  analytes: Analyte[];
}

const WHOLE_BLOOD = "Whole blood (EDTA)";
const SERUM = "Serum";

const STARTER_TESTS: LabTestSeed[] = [
  {
    code: "CBC",
    name: "Complete Blood Count",
    specimenType: WHOLE_BLOOD,
    analytes: [
      // The combined adult interval — see the header on why there is one and not two.
      { code: "HB", label: "Haemoglobin", unit: "g/dL", refLow: 12, refHigh: 17 },
      { code: "TLC", label: "Total Leucocyte Count", unit: "10³/µL", refLow: 4, refHigh: 11 },
      { code: "PLT", label: "Platelet Count", unit: "10³/µL", refLow: 150, refHigh: 410 },
      { code: "RBC", label: "Red Cell Count", unit: "10⁶/µL", refLow: 4.2, refHigh: 5.9 },
      { code: "HCT", label: "Haematocrit", unit: "%", refLow: 36, refHigh: 50 },
      { code: "MCV", label: "Mean Corpuscular Volume", unit: "fL", refLow: 80, refHigh: 100 },
    ],
  },
  {
    code: "LFT",
    name: "Liver Function Test",
    specimenType: SERUM,
    analytes: [
      { code: "TBIL", label: "Total Bilirubin", unit: "mg/dL", refLow: 0.2, refHigh: 1.2 },
      { code: "DBIL", label: "Direct Bilirubin", unit: "mg/dL", refHigh: 0.3 },
      { code: "ALT", label: "ALT (SGPT)", unit: "U/L", refLow: 7, refHigh: 56 },
      { code: "AST", label: "AST (SGOT)", unit: "U/L", refLow: 10, refHigh: 40 },
      { code: "ALP", label: "Alkaline Phosphatase", unit: "U/L", refLow: 44, refHigh: 147 },
      { code: "TP", label: "Total Protein", unit: "g/dL", refLow: 6, refHigh: 8.3 },
      { code: "ALB", label: "Albumin", unit: "g/dL", refLow: 3.5, refHigh: 5.5 },
    ],
  },
  {
    code: "RFT",
    name: "Renal Function Test",
    specimenType: SERUM,
    analytes: [
      { code: "UREA", label: "Blood Urea", unit: "mg/dL", refLow: 15, refHigh: 40 },
      { code: "CREA", label: "Serum Creatinine", unit: "mg/dL", refLow: 0.6, refHigh: 1.3 },
      { code: "UA", label: "Uric Acid", unit: "mg/dL", refLow: 3.5, refHigh: 7.2 },
      { code: "NA", label: "Sodium", unit: "mmol/L", refLow: 135, refHigh: 145 },
      /**
       * The analyte the critical-value pathway exists for. A potassium of 7.2 stops the heart, and
       * `order.service.ts` alerts on it synchronously at completion — the range here is what makes
       * result entry flag the number in the first place.
       */
      { code: "K", label: "Potassium", unit: "mmol/L", refLow: 3.5, refHigh: 5.1 },
      { code: "CL", label: "Chloride", unit: "mmol/L", refLow: 98, refHigh: 107 },
    ],
  },
  {
    code: "GLU",
    name: "Blood Glucose (Fasting)",
    specimenType: "Fluoride plasma",
    analytes: [
      { code: "FPG", label: "Fasting Plasma Glucose", unit: "mg/dL", refLow: 70, refHigh: 99 },
    ],
  },
  {
    code: "LIPID",
    name: "Lipid Profile",
    // Stated on the specimen rather than in a note, because it is the instruction the phlebotomy
    // desk acts on and a non-fasting lipid profile is a different test with the same name.
    specimenType: "Serum (12-hour fast)",
    analytes: [
      /**
       * Desirable-level ceilings, not intervals — which is exactly why `refText` exists beside the
       * numbers. `refHigh` alone renders as "< 200" through `withDerivedRange`, and that is the
       * form a clinician reads a lipid target in.
       */
      { code: "CHOL", label: "Total Cholesterol", unit: "mg/dL", refHigh: 200 },
      { code: "TRIG", label: "Triglycerides", unit: "mg/dL", refHigh: 150 },
      { code: "HDL", label: "HDL Cholesterol", unit: "mg/dL", refLow: 40 },
      { code: "LDL", label: "LDL Cholesterol", unit: "mg/dL", refHigh: 100 },
      { code: "VLDL", label: "VLDL Cholesterol", unit: "mg/dL", refLow: 5, refHigh: 40 },
    ],
  },
];

/** How many tests the starter catalogue carries — exported so a test can assert it is not empty. */
export const STARTER_LAB_TEST_COUNT = STARTER_TESTS.length;

/** The codes, for a test that wants to assert the catalogue and the tariff still agree. */
export const STARTER_LAB_TEST_CODES = STARTER_TESTS.map((t) => t.code);

/**
 * The printable range, derived from the bounds when the seed gives no words.
 *
 * Deliberately the SAME rule as `labTest.service.ts` `withDerivedRange`, applied here rather than
 * imported, because the service's copy runs inside `createTest` and this writer does not go through
 * it — it writes the collection directly, exactly as `seedTariff` and `seedIcdCodes` do. Two lines
 * of duplication is the cheaper of the two prices; the other is a seed that depends on a service
 * that depends on a request context.
 */
function printableRange(a: Analyte): Analyte {
  if (a.refText?.trim()) return a;
  if (a.refLow != null && a.refHigh != null) return { ...a, refText: `${a.refLow}–${a.refHigh}` };
  if (a.refLow != null) return { ...a, refText: `> ${a.refLow}` };
  if (a.refHigh != null) return { ...a, refText: `< ${a.refHigh}` };
  return a;
}

/**
 * Idempotent: inserts what is missing, never overwrites what a hospital has curated.
 *
 * ── NO `branchId`, DELIBERATELY ─────────────────────────────────────────────
 * A test definition is the HOSPITAL's, not a site's — its uniqueness index is
 * `{ tenantId, code }` (migration 0041), so two sites cannot even hold their own CBC. Writing a
 * branch here would produce a catalogue that one site can see and the other can neither see nor
 * recreate. `billing.repository.ts` carries the same note over `packages` for the same reason.
 */
export async function seedLabTests(
  tenantId: string,
  tenantSlug: string,
  connection: Connection,
): Promise<number> {
  return runWithContext(
    { traceId: `seed-lab-tests-${tenantSlug}`, tenantId, tenantSlug, connection },
    async () => {
      const model = getLabTestModel(connection);
      let created = 0;

      for (const test of STARTER_TESTS) {
        const result = await model.updateOne(
          { tenantId, code: test.code },
          {
            // ONLY on insert. Their reference ranges are theirs — a seed that reset a
            // laboratory's curated intervals on the next deploy would be a clinical incident.
            $setOnInsert: {
              tenantId,
              code: test.code,
              name: test.name,
              specimenType: test.specimenType,
              analytes: test.analytes.map(printableRange),
              active: true,
            },
          },
          { upsert: true },
        );
        if (result.upsertedCount > 0) created++;
      }

      if (created > 0) logger.info({ tenantSlug, created }, "lab test catalogue seeded");
      return created;
    },
  );
}
