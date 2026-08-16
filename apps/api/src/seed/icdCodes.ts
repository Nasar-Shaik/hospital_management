/**
 * ICD-10 starter set — the code master a hospital can actually begin with.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * `icdCodes` shipped EMPTY. The consequence was not a missing nicety: the Medical Records page
 * opened on a blank list beside an "Add code" button, the doctor's Coding tab had nothing to pick
 * from, and the disease register — the morbidity return a hospital files monthly, and the codes an
 * insurer wants on a claim — could only ever report zero. Manual testing put it plainly: "in
 * medical records page why this page and what to add as add code?" The page could not answer that
 * question because nothing in it had ever been true.
 *
 * Nobody is going to hand-type ICD-10. It has some 70,000 codes, and a hospital that must enter
 * them before the feature does anything has a feature it will never turn on.
 *
 * ── WHY THIS SUBSET, AND WHY IT IS NOT "ICD-10" ─────────────────────────────
 * These are ~90 codes chosen for an Indian general hospital's ordinary OPD and ward: the
 * infectious disease load that drives the notifiable-disease return (dengue, malaria, typhoid,
 * TB), the non-communicable disease load that drives most follow-ups (diabetes, hypertension,
 * IHD, COPD, asthma, CKD), maternity, paediatrics, and the injuries that arrive at night.
 *
 * It is a STARTING POINT, not the classification. A hospital adds what its specialties need
 * (`mrd:manage`), retires what it does not use, and a dedicated coder may replace the lot. That
 * is why every row is `$setOnInsert` — exactly like the tariff, whose header makes the same
 * promise: what a hospital has curated is theirs, and re-running this never overwrites it.
 *
 * The titles are the WHO rubrics, kept verbatim rather than paraphrased, because a coder matching
 * against a claim form is matching against those words. `chapter` is the coarse grouping the
 * register aggregates under — free text, and deliberately the chapter rather than the block, so
 * the register stays readable at a glance.
 */
import { createLogger } from "@medicore/logger";
import type { Connection } from "mongoose";
import { runWithContext } from "../core/context/requestContext.js";
import { getIcdCodeModel } from "../modules/mrd/mrd.model.js";

const logger = createLogger({ service: "seed-icd" });

interface IcdSeed {
  code: string;
  title: string;
  chapter: string;
}

const INFECTIOUS = "Certain infectious and parasitic diseases";
const NEOPLASM = "Neoplasms";
const BLOOD = "Diseases of the blood and blood-forming organs";
const ENDOCRINE = "Endocrine, nutritional and metabolic diseases";
const MENTAL = "Mental and behavioural disorders";
const NERVOUS = "Diseases of the nervous system";
const EYE_EAR = "Diseases of the eye, ear and adnexa";
const CIRCULATORY = "Diseases of the circulatory system";
const RESPIRATORY = "Diseases of the respiratory system";
const DIGESTIVE = "Diseases of the digestive system";
const SKIN = "Diseases of the skin and subcutaneous tissue";
const MUSCULOSKELETAL = "Diseases of the musculoskeletal system";
const GENITOURINARY = "Diseases of the genitourinary system";
const PREGNANCY = "Pregnancy, childbirth and the puerperium";
const PERINATAL = "Certain conditions originating in the perinatal period";
const SYMPTOMS = "Symptoms, signs and abnormal findings";
const INJURY = "Injury, poisoning and external causes";
const FACTORS = "Factors influencing health status";

const STARTER_CODES: IcdSeed[] = [
  /* ── Infectious: the notifiable-disease return is written from these ─────── */
  { code: "A01.0", title: "Typhoid fever", chapter: INFECTIOUS },
  {
    code: "A09",
    title: "Infectious gastroenteritis and colitis, unspecified",
    chapter: INFECTIOUS,
  },
  { code: "A15.0", title: "Tuberculosis of lung, confirmed", chapter: INFECTIOUS },
  {
    code: "A16.2",
    title: "Tuberculosis of lung, without mention of confirmation",
    chapter: INFECTIOUS,
  },
  { code: "A90", title: "Dengue fever [classical dengue]", chapter: INFECTIOUS },
  { code: "A91", title: "Dengue haemorrhagic fever", chapter: INFECTIOUS },
  { code: "B50.9", title: "Plasmodium falciparum malaria, unspecified", chapter: INFECTIOUS },
  { code: "B51.9", title: "Plasmodium vivax malaria without complication", chapter: INFECTIOUS },
  { code: "A75.9", title: "Typhus fever, unspecified", chapter: INFECTIOUS },
  { code: "B01.9", title: "Varicella without complication", chapter: INFECTIOUS },
  { code: "B05.9", title: "Measles without complication", chapter: INFECTIOUS },
  { code: "B15.9", title: "Hepatitis A without hepatic coma", chapter: INFECTIOUS },
  {
    code: "B16.9",
    title: "Acute hepatitis B without delta-agent and without hepatic coma",
    chapter: INFECTIOUS,
  },
  {
    code: "B24",
    title: "Unspecified human immunodeficiency virus [HIV] disease",
    chapter: INFECTIOUS,
  },
  { code: "B35.9", title: "Dermatophytosis, unspecified", chapter: INFECTIOUS },
  { code: "A08.4", title: "Viral intestinal infection, unspecified", chapter: INFECTIOUS },
  { code: "U07.1", title: "COVID-19, virus identified", chapter: INFECTIOUS },

  /* ── Neoplasms ───────────────────────────────────────────────────────────── */
  { code: "C50.9", title: "Malignant neoplasm of breast, unspecified", chapter: NEOPLASM },
  {
    code: "C34.9",
    title: "Malignant neoplasm of bronchus or lung, unspecified",
    chapter: NEOPLASM,
  },
  { code: "C53.9", title: "Malignant neoplasm of cervix uteri, unspecified", chapter: NEOPLASM },
  { code: "D24", title: "Benign neoplasm of breast", chapter: NEOPLASM },

  /* ── Blood ───────────────────────────────────────────────────────────────── */
  { code: "D50.9", title: "Iron deficiency anaemia, unspecified", chapter: BLOOD },
  { code: "D56.1", title: "Beta thalassaemia", chapter: BLOOD },
  { code: "D57.1", title: "Sickle-cell disease without crisis", chapter: BLOOD },
  { code: "D64.9", title: "Anaemia, unspecified", chapter: BLOOD },

  /* ── Endocrine & metabolic: the bulk of every OPD follow-up list ─────────── */
  { code: "E10.9", title: "Type 1 diabetes mellitus without complications", chapter: ENDOCRINE },
  { code: "E11.9", title: "Type 2 diabetes mellitus without complications", chapter: ENDOCRINE },
  { code: "E11.2", title: "Type 2 diabetes mellitus with renal complications", chapter: ENDOCRINE },
  {
    code: "E11.5",
    title: "Type 2 diabetes mellitus with peripheral circulatory complications",
    chapter: ENDOCRINE,
  },
  { code: "E03.9", title: "Hypothyroidism, unspecified", chapter: ENDOCRINE },
  { code: "E05.9", title: "Thyrotoxicosis, unspecified", chapter: ENDOCRINE },
  { code: "E66.9", title: "Obesity, unspecified", chapter: ENDOCRINE },
  { code: "E78.5", title: "Hyperlipidaemia, unspecified", chapter: ENDOCRINE },
  { code: "E86", title: "Volume depletion", chapter: ENDOCRINE },
  { code: "E87.6", title: "Hypokalaemia", chapter: ENDOCRINE },

  /* ── Mental & behavioural ────────────────────────────────────────────────── */
  { code: "F32.9", title: "Depressive episode, unspecified", chapter: MENTAL },
  { code: "F41.9", title: "Anxiety disorder, unspecified", chapter: MENTAL },
  {
    code: "F10.2",
    title: "Mental and behavioural disorders due to use of alcohol, dependence syndrome",
    chapter: MENTAL,
  },

  /* ── Nervous system ──────────────────────────────────────────────────────── */
  { code: "G40.9", title: "Epilepsy, unspecified", chapter: NERVOUS },
  { code: "G43.9", title: "Migraine, unspecified", chapter: NERVOUS },
  { code: "G62.9", title: "Polyneuropathy, unspecified", chapter: NERVOUS },

  /* ── Eye & ear ───────────────────────────────────────────────────────────── */
  { code: "H25.9", title: "Age-related cataract, unspecified", chapter: EYE_EAR },
  { code: "H10.9", title: "Conjunctivitis, unspecified", chapter: EYE_EAR },
  { code: "H66.9", title: "Otitis media, unspecified", chapter: EYE_EAR },

  /* ── Circulatory ─────────────────────────────────────────────────────────── */
  { code: "I10", title: "Essential (primary) hypertension", chapter: CIRCULATORY },
  { code: "I20.9", title: "Angina pectoris, unspecified", chapter: CIRCULATORY },
  { code: "I21.9", title: "Acute myocardial infarction, unspecified", chapter: CIRCULATORY },
  { code: "I25.9", title: "Chronic ischaemic heart disease, unspecified", chapter: CIRCULATORY },
  { code: "I50.9", title: "Heart failure, unspecified", chapter: CIRCULATORY },
  { code: "I48", title: "Atrial fibrillation and flutter", chapter: CIRCULATORY },
  { code: "I63.9", title: "Cerebral infarction, unspecified", chapter: CIRCULATORY },
  {
    code: "I64",
    title: "Stroke, not specified as haemorrhage or infarction",
    chapter: CIRCULATORY,
  },
  {
    code: "I83.9",
    title: "Varicose veins of lower extremities without ulcer or inflammation",
    chapter: CIRCULATORY,
  },

  /* ── Respiratory ─────────────────────────────────────────────────────────── */
  { code: "J00", title: "Acute nasopharyngitis [common cold]", chapter: RESPIRATORY },
  { code: "J02.9", title: "Acute pharyngitis, unspecified", chapter: RESPIRATORY },
  { code: "J06.9", title: "Acute upper respiratory infection, unspecified", chapter: RESPIRATORY },
  { code: "J18.9", title: "Pneumonia, unspecified organism", chapter: RESPIRATORY },
  { code: "J20.9", title: "Acute bronchitis, unspecified", chapter: RESPIRATORY },
  {
    code: "J44.9",
    title: "Chronic obstructive pulmonary disease, unspecified",
    chapter: RESPIRATORY,
  },
  { code: "J45.9", title: "Asthma, unspecified", chapter: RESPIRATORY },
  { code: "J81", title: "Pulmonary oedema", chapter: RESPIRATORY },

  /* ── Digestive ───────────────────────────────────────────────────────────── */
  {
    code: "K21.9",
    title: "Gastro-oesophageal reflux disease without oesophagitis",
    chapter: DIGESTIVE,
  },
  { code: "K29.7", title: "Gastritis, unspecified", chapter: DIGESTIVE },
  { code: "K35.8", title: "Acute appendicitis, other and unspecified", chapter: DIGESTIVE },
  {
    code: "K40.9",
    title: "Unilateral or unspecified inguinal hernia, without obstruction or gangrene",
    chapter: DIGESTIVE,
  },
  {
    code: "K52.9",
    title: "Noninfective gastroenteritis and colitis, unspecified",
    chapter: DIGESTIVE,
  },
  { code: "K59.0", title: "Constipation", chapter: DIGESTIVE },
  { code: "K74.6", title: "Other and unspecified cirrhosis of liver", chapter: DIGESTIVE },
  { code: "K80.2", title: "Calculus of gallbladder without cholecystitis", chapter: DIGESTIVE },

  /* ── Skin ────────────────────────────────────────────────────────────────── */
  { code: "L03.9", title: "Cellulitis, unspecified", chapter: SKIN },
  { code: "L20.9", title: "Atopic dermatitis, unspecified", chapter: SKIN },
  { code: "L50.9", title: "Urticaria, unspecified", chapter: SKIN },

  /* ── Musculoskeletal ─────────────────────────────────────────────────────── */
  { code: "M15.9", title: "Polyosteoarthritis, unspecified", chapter: MUSCULOSKELETAL },
  {
    code: "M17.9",
    title: "Gonarthrosis [arthrosis of knee], unspecified",
    chapter: MUSCULOSKELETAL,
  },
  { code: "M54.5", title: "Low back pain", chapter: MUSCULOSKELETAL },
  { code: "M06.9", title: "Rheumatoid arthritis, unspecified", chapter: MUSCULOSKELETAL },
  { code: "M81.9", title: "Osteoporosis, unspecified", chapter: MUSCULOSKELETAL },

  /* ── Genitourinary ───────────────────────────────────────────────────────── */
  { code: "N18.9", title: "Chronic kidney disease, unspecified", chapter: GENITOURINARY },
  { code: "N20.0", title: "Calculus of kidney", chapter: GENITOURINARY },
  { code: "N39.0", title: "Urinary tract infection, site not specified", chapter: GENITOURINARY },
  { code: "N40", title: "Benign prostatic hyperplasia", chapter: GENITOURINARY },
  {
    code: "N92.0",
    title: "Excessive and frequent menstruation with regular cycle",
    chapter: GENITOURINARY,
  },

  /* ── Pregnancy & childbirth ──────────────────────────────────────────────── */
  { code: "O80", title: "Single spontaneous delivery", chapter: PREGNANCY },
  { code: "O82", title: "Single delivery by caesarean section", chapter: PREGNANCY },
  { code: "O14.9", title: "Pre-eclampsia, unspecified", chapter: PREGNANCY },
  { code: "O24.4", title: "Diabetes mellitus arising in pregnancy", chapter: PREGNANCY },
  {
    code: "O03.9",
    title: "Spontaneous abortion, complete or unspecified, without complication",
    chapter: PREGNANCY,
  },

  /* ── Perinatal ───────────────────────────────────────────────────────────── */
  { code: "P59.9", title: "Neonatal jaundice, unspecified", chapter: PERINATAL },
  { code: "P07.3", title: "Other preterm infants", chapter: PERINATAL },

  /* ── Symptoms & signs: what an undifferentiated OPD case is coded as ─────── */
  { code: "R50.9", title: "Fever, unspecified", chapter: SYMPTOMS },
  { code: "R10.4", title: "Other and unspecified abdominal pain", chapter: SYMPTOMS },
  { code: "R51", title: "Headache", chapter: SYMPTOMS },
  { code: "R05", title: "Cough", chapter: SYMPTOMS },
  { code: "R11", title: "Nausea and vomiting", chapter: SYMPTOMS },
  { code: "R42", title: "Dizziness and giddiness", chapter: SYMPTOMS },
  { code: "R55", title: "Syncope and collapse", chapter: SYMPTOMS },

  /* ── Injury & poisoning ──────────────────────────────────────────────────── */
  { code: "S06.0", title: "Concussion", chapter: INJURY },
  { code: "S52.5", title: "Fracture of lower end of radius", chapter: INJURY },
  { code: "S72.0", title: "Fracture of neck of femur", chapter: INJURY },
  { code: "S81.9", title: "Open wound of lower leg, part unspecified", chapter: INJURY },
  { code: "T14.1", title: "Open wound of unspecified body region", chapter: INJURY },
  { code: "T30.0", title: "Burn of unspecified body region, unspecified degree", chapter: INJURY },
  { code: "T63.0", title: "Toxic effect of snake venom", chapter: INJURY },
  { code: "T60.9", title: "Toxic effect of unspecified pesticide", chapter: INJURY },

  /* ── Factors influencing health status ───────────────────────────────────── */
  { code: "Z00.0", title: "General medical examination", chapter: FACTORS },
  { code: "Z34.9", title: "Supervision of normal pregnancy, unspecified", chapter: FACTORS },
  { code: "Z23", title: "Encounter for immunization", chapter: FACTORS },
  { code: "Z51.1", title: "Encounter for antineoplastic chemotherapy", chapter: FACTORS },
];

/** How many codes the starter set carries — exported so a test can assert it is not empty. */
export const STARTER_ICD_COUNT = STARTER_CODES.length;

/**
 * Idempotent: inserts what is missing, never overwrites what a hospital has curated.
 *
 * `$setOnInsert` throughout — the same promise the tariff makes. A hospital that has retitled a
 * code, retired one it does not use, or corrected a chapter keeps every one of those decisions
 * across re-runs and upgrades.
 */
export async function seedIcdCodes(
  tenantId: string,
  tenantSlug: string,
  connection: Connection,
): Promise<number> {
  return runWithContext(
    { traceId: `seed-icd-${tenantSlug}`, tenantId, tenantSlug, connection },
    async () => {
      const model = getIcdCodeModel(connection);
      let created = 0;

      for (const item of STARTER_CODES) {
        const result = await model.updateOne(
          { tenantId, code: item.code },
          {
            // ONLY on insert. Their code master is theirs.
            $setOnInsert: {
              tenantId,
              code: item.code,
              title: item.title,
              chapter: item.chapter,
              active: true,
            },
          },
          { upsert: true },
        );
        if (result.upsertedCount > 0) created++;
      }

      if (created > 0) logger.info({ tenantSlug, created }, "ICD-10 starter set seeded");
      return created;
    },
  );
}
