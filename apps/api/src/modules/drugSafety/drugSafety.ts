/**
 * Drug-safety reference and the prescription screener.
 *
 * ── WHAT THIS IS, AND WHAT IT IS EMPHATICALLY NOT ───────────────────────────
 * This is a SMALL, curated safety net over the fifteen demo drugs in `seed/tariff.ts`.
 * It is enough to make the machine catch the mistake a tired doctor at 3am actually
 * makes — signing amoxicillin for a penicillin-allergic patient — and to demonstrate
 * that the system checks before it lets a drug through.
 *
 * It is NOT a drug database. A real one (First DataBank, Multum, a national formulary)
 * carries every marketed drug, its ingredients, its ATC class, dose ceilings, renal and
 * hepatic adjustment, pregnancy category and a maintained interaction matrix with
 * severity and evidence grade. Ripping this out and wiring that in is a project, and the
 * SHAPE here — allergens, cross-reactivity, therapeutic class, interaction pairs, one
 * pure `screen()` — is deliberately the shape that swap would keep.
 *
 * ── WHY A PURE FUNCTION WITH NO DATABASE ────────────────────────────────────
 * `screen()` takes the drugs and the patient's allergies and returns alerts. It reads
 * nothing and writes nothing, so it is exhaustively unit-testable without infrastructure,
 * and it can be called both live as the doctor types (the pad) and again at the moment of
 * signing (the enforcement point) with no possibility of the two disagreeing. The store of
 * allergies and the enforcement of the block live elsewhere; this only knows the clinical
 * facts.
 */

/**
 * Allergen classes. An allergy is recorded against ONE of these, never against free text,
 * because "penicilin" typed at the desk will never match a drug and a safety check that
 * silently never fires is the most dangerous thing a prescribing system can contain.
 *
 * A few non-drug allergens (latex, foods) are here too: they are real, a clinician will
 * want to record them, and this catalogue is the one list the UI offers. They simply never
 * match a drug — which is correct, not a gap.
 */
export const ALLERGENS = {
  penicillins: "Penicillins",
  cephalosporins: "Cephalosporins",
  sulfonamides: "Sulfonamides (sulfa drugs)",
  macrolides: "Macrolides",
  nsaids: "NSAIDs",
  salicylates: "Salicylates (aspirin)",
  opioids: "Opioids",
  paracetamol: "Paracetamol",
  ondansetron: "Ondansetron",
  latex: "Latex",
  peanuts: "Peanuts",
  eggs: "Eggs",
} as const;

export type Allergen = keyof typeof ALLERGENS;

export function isAllergen(value: string): value is Allergen {
  return Object.prototype.hasOwnProperty.call(ALLERGENS, value);
}

/**
 * Which allergen classes each demo drug belongs to. A drug not listed here maps to none —
 * safe by omission, because an unknown drug producing zero allergen matches is honest
 * ("we don't know this drug") rather than falsely reassuring about a match it cannot make.
 *
 * Keyed on the `DRUG_*` codes from `seed/tariff.ts`, which are what a prescription line and
 * a charge already join on.
 */
const DRUG_ALLERGENS: Record<string, readonly Allergen[]> = {
  DRUG_AMOX_500: ["penicillins"],
  DRUG_INJ_CEFT: ["cephalosporins"],
  DRUG_AZITH_500: ["macrolides"],
  DRUG_IBU_400: ["nsaids"],
  DRUG_INJ_DICLO: ["nsaids"],
  DRUG_PARA_500: ["paracetamol"],
  DRUG_ONDAN_4: ["ondansetron"],
};

/**
 * Partial cross-reactivity: being allergic to the KEY means the VALUES carry a real but
 * lesser risk. The canonical example is penicillin → cephalosporin: the historically
 * quoted 10% is now understood to be far lower, but it is not zero, and a prescriber
 * deserves to be told and to decide — which is why this WARNS and does not block.
 */
const CROSS_REACTIVITY: Partial<Record<Allergen, readonly Allergen[]>> = {
  penicillins: ["cephalosporins"],
  cephalosporins: ["penicillins"],
  nsaids: ["salicylates"],
  salicylates: ["nsaids"],
};

/**
 * Therapeutic class, for duplicate-therapy detection: two drugs doing the same job at once
 * is rarely intended and sometimes dangerous (two NSAIDs multiply the GI-bleed risk without
 * adding benefit). Distinct from allergen class — paracetamol and ibuprofen share neither.
 *
 * ── WHY "ANTIBIOTIC" IS NOT HERE ────────────────────────────────────────────
 * Deliberately narrow. Two ANTIBIOTICS together is a normal, intended combination — broad
 * empiric cover, or hitting an organism two ways — so flagging amoxicillin + ceftriaxone as
 * "duplicate" would be a false alarm on ordinary practice, and false alarms are how the true
 * alarms get clicked past. A class earns a place here only when a second member is almost
 * always a mistake (two NSAIDs, two PPIs, two statins), not merely the same broad category.
 */
const THERAPEUTIC_CLASS: Record<string, string> = {
  DRUG_IBU_400: "nsaid",
  DRUG_INJ_DICLO: "nsaid",
  DRUG_ATOR_10: "statin",
  DRUG_PAN_40: "ppi",
};

/**
 * Drug–drug interactions worth interrupting for. Curated PAIRS, unordered — the screener
 * checks both directions. Severity drives how loud the alert is; none of these BLOCK,
 * because a competent prescriber may want the combination with monitoring, and a hard
 * block on an interaction is how prescribers learn to stop reading the alerts.
 *
 * The pair below is real and both drugs are on the demo list: azithromycin and ondansetron
 * both prolong the QT interval, and together the additive risk of a fatal arrhythmia is a
 * genuine, named contraindication in cardiac patients.
 */
const INTERACTIONS: readonly {
  drugs: readonly [string, string];
  severity: AlertSeverity;
  message: string;
}[] = [
  {
    drugs: ["DRUG_AZITH_500", "DRUG_ONDAN_4"],
    severity: "major",
    message:
      "Azithromycin and ondansetron both prolong the QT interval — additive risk of arrhythmia. Review if the patient has cardiac risk factors.",
  },
];

export type AlertKind = "allergy" | "cross_sensitivity" | "duplicate_therapy" | "interaction";

/**
 * `contraindicated` is the only severity that BLOCKS a signature (see the prescription
 * service). Everything below it informs and is recorded, but does not stand in the way —
 * the severity ladder is the whole difference between a safety net and a nuisance nobody
 * reads.
 */
export type AlertSeverity = "contraindicated" | "major" | "moderate";

export interface SafetyAlert {
  kind: AlertKind;
  severity: AlertSeverity;
  /** The prescribed drug code(s) this alert is about. */
  drugCodes: string[];
  /** Set on allergy/cross-sensitivity alerts: the allergen that fired it. */
  allergen?: Allergen;
  message: string;
}

/** A prescribed line, reduced to what screening needs. */
export interface ScreenLine {
  drugCode: string;
  drugName: string;
}

/** An active allergy, reduced to what screening needs. */
export interface ScreenAllergy {
  allergen: Allergen;
  /** For the message: "severe" reads differently from "mild", though neither changes the block. */
  severity?: string;
}

export function allergensFor(drugCode: string): readonly Allergen[] {
  return DRUG_ALLERGENS[drugCode] ?? [];
}

/**
 * The screen. Given what is being prescribed and what the patient is allergic to, return
 * every alert, most severe first. Pure: same inputs, same output, no I/O.
 */
export function screen(
  lines: readonly ScreenLine[],
  allergies: readonly ScreenAllergy[],
): SafetyAlert[] {
  const alerts: SafetyAlert[] = [];
  const allergicTo = new Set(allergies.map((a) => a.allergen));

  for (const line of lines) {
    const drugAllergens = allergensFor(line.drugCode);

    for (const allergen of drugAllergens) {
      // Direct hit: the drug IS a class the patient reacts to. This is the block.
      if (allergicTo.has(allergen)) {
        alerts.push({
          kind: "allergy",
          severity: "contraindicated",
          drugCodes: [line.drugCode],
          allergen,
          message: `${line.drugName} is a ${ALLERGENS[allergen]} — the patient has a recorded ${ALLERGENS[allergen]} allergy.`,
        });
        continue;
      }

      // Indirect: the patient reacts to something this drug cross-reacts with. A warning.
      for (const source of allergicTo) {
        if ((CROSS_REACTIVITY[source] ?? []).includes(allergen)) {
          alerts.push({
            kind: "cross_sensitivity",
            severity: "major",
            drugCodes: [line.drugCode],
            allergen: source,
            message: `${line.drugName} (${ALLERGENS[allergen]}) may cross-react with the patient's ${ALLERGENS[source]} allergy.`,
          });
        }
      }
    }
  }

  // Duplicate therapy: two DISTINCT lines sharing a therapeutic class.
  const byClass = new Map<string, ScreenLine[]>();
  for (const line of lines) {
    const cls = THERAPEUTIC_CLASS[line.drugCode];
    if (!cls) continue;
    (byClass.get(cls) ?? byClass.set(cls, []).get(cls)!).push(line);
  }
  for (const [cls, group] of byClass) {
    const distinct = group.filter(
      (l, i) => group.findIndex((g) => g.drugCode === l.drugCode) === i,
    );
    if (distinct.length > 1) {
      alerts.push({
        kind: "duplicate_therapy",
        severity: "moderate",
        drugCodes: distinct.map((l) => l.drugCode),
        message: `${distinct.map((l) => l.drugName).join(" and ")} are both ${cls.replace(/_/g, " ")} — duplicate therapy.`,
      });
    }
  }

  // Interactions: curated pairs, both directions.
  const present = new Set(lines.map((l) => l.drugCode));
  const nameOf = (code: string): string => lines.find((l) => l.drugCode === code)?.drugName ?? code;
  for (const pair of INTERACTIONS) {
    const [a, b] = pair.drugs;
    if (present.has(a) && present.has(b)) {
      alerts.push({
        kind: "interaction",
        severity: pair.severity,
        drugCodes: [a, b],
        message: `${nameOf(a)} + ${nameOf(b)}: ${pair.message}`,
      });
    }
  }

  const rank: Record<AlertSeverity, number> = { contraindicated: 0, major: 1, moderate: 2 };
  return alerts.sort((x, y) => rank[x.severity] - rank[y.severity]);
}

/**
 * The single definition of "must not proceed without an explicit override". The service
 * and the UI both ask this rather than each re-deciding which severities block — so they
 * cannot drift, and the day a new blocking severity is added it is added in one place.
 */
export function isBlocking(alert: SafetyAlert): boolean {
  return alert.severity === "contraindicated";
}

export function hasBlocking(alerts: readonly SafetyAlert[]): boolean {
  return alerts.some(isBlocking);
}
