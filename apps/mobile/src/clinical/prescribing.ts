/**
 * Composing a prescription, and placing orders — the draft models behind the two write pads.
 *
 * ── EVERY DEFAULT HERE IS A STARTING POINT, NEVER A CLINICAL DECISION ───────
 * A new line arrives as `1 unit / oral / BD / 5 days / qty 10`. Those numbers are deliberately
 * generic and deliberately visible: they exist so the doctor edits four fields instead of typing
 * five, and every one of them is wrong often enough that leaving it untouched looks wrong on the
 * review screen. A default that looked plausible for the drug — a real dose pulled from a table —
 * would be a prescribing decision made by software nobody signed off, and the doctor would stop
 * reading it.
 *
 * `quantity` starts at a number the doctor must look at rather than one they might not: it is what
 * the pharmacy counts out, and it is the field that turns a typo into a bag of tablets.
 *
 * ── ROUTE AND FREQUENCY ARE PICKERS, NOT TEXT ───────────────────────────────
 * A drug given by the wrong route kills people, and it has. A picker cannot stop a doctor choosing
 * wrongly; it stops them choosing something nobody has ever thought about, and it keeps the value
 * inside the vocabulary the pharmacy and the MAR both read.
 */
import type {
  DrugFrequency,
  DrugRoute,
  OrderCategory,
  OrderPriority,
  PlaceOrderResult,
  PrescriptionLineInput,
} from "@medicore/api-client";

/* ════════════════════════════════════════════════════════════════════════════
 * PRESCRIBING
 * ══════════════════════════════════════════════════════════════════════════ */

export const DEFAULT_LINE = {
  dose: "1 unit",
  route: "oral" as DrugRoute,
  frequency: "BD" as DrugFrequency,
  durationDays: 5,
  quantity: 10,
} as const;

export function newLine(drug: { code: string; name: string }): PrescriptionLineInput {
  return { drugCode: drug.code, drugName: drug.name, ...DEFAULT_LINE };
}

export function updateLine(
  lines: readonly PrescriptionLineInput[],
  index: number,
  patch: Partial<PrescriptionLineInput>,
): PrescriptionLineInput[] {
  return lines.map((line, i) => (i === index ? { ...line, ...patch } : line));
}

export function removeLine(
  lines: readonly PrescriptionLineInput[],
  index: number,
): PrescriptionLineInput[] {
  return lines.filter((_, i) => i !== index);
}

/**
 * `1 cap · oral · TDS · 5 days` — one line as the review screen reads it back.
 *
 * Assembled here rather than in the component so the review text and the payload cannot drift:
 * the whole purpose of the review step is that what the doctor confirms is what gets signed.
 */
export function describeLine(line: PrescriptionLineInput): string {
  const parts = [line.dose, line.route, line.frequency];
  if (line.durationDays !== undefined) parts.push(`${String(line.durationDays)} days`);
  parts.push(`qty ${String(line.quantity)}`);
  return parts.join(" · ");
}

/**
 * Does a change to the lines invalidate a safety screen already run against them?
 *
 * Any change does. The screen is a statement about a specific set of drugs at specific doses; the
 * moment one moves, the alerts on screen describe something the doctor is no longer signing. The
 * server re-screens at the signature regardless — that is the real gate — but a stale green
 * "no alerts" in front of a prescriber is the kind of reassurance that stops them looking.
 */
export function screeningStillValid(
  screened: readonly PrescriptionLineInput[],
  current: readonly PrescriptionLineInput[],
): boolean {
  if (screened.length !== current.length) return false;
  return screened.every((line, index) => {
    const now = current[index];
    return now !== undefined && JSON.stringify(line) === JSON.stringify(now);
  });
}

/* ════════════════════════════════════════════════════════════════════════════
 * ORDERING
 * ══════════════════════════════════════════════════════════════════════════ */

/** What the doctor may order from the price-free catalogue. Never `pharmacy` — that is the pad. */
export const ORDERABLE_CATEGORIES: readonly OrderCategory[] = ["lab", "radiology", "procedure"];

export function isOrderable(category: string): category is OrderCategory {
  return (ORDERABLE_CATEGORIES as readonly string[]).includes(category);
}

export const ORDER_PRIORITIES: readonly OrderPriority[] = [
  "routine",
  "urgent",
  "stat",
  "emergency",
];

/**
 * What the basket sends: ONE request per test, each with its own idempotency key.
 *
 * ── ONE INTENT PER TEST, NOT ONE PER BASKET ─────────────────────────────────
 * They go out as separate requests because the endpoint takes one order, and each therefore needs
 * its own key: the server matches a key to a request body, and reusing one key across three
 * different bodies is `HMS-REQ-002` (key reused with a different payload), not a replay. Keyed by
 * `code` so a retry of the same basket reuses the same three keys and replays whichever of the
 * three actually landed.
 */
export interface OrderRequest {
  input: {
    encounterId: string;
    category: OrderCategory;
    code: string;
    name: string;
    priority: OrderPriority;
    requestId: string;
  };
  key: string;
}

export function orderRequests(
  encounterId: string,
  items: readonly { code: string; name: string; category: OrderCategory }[],
  priority: OrderPriority,
  keyFor: (code: string) => string,
): OrderRequest[] {
  return items.map((item) => {
    const key = keyFor(item.code);
    return {
      // `requestId` carries the SAME string as the header. The header is the mechanism; the body
      // field is the module's own second lock, and it is the one that still holds if a proxy ever
      // strips an unfamiliar header. Cheap, and the failure it covers is a real needle.
      input: {
        encounterId,
        category: item.category,
        code: item.code,
        name: item.name,
        priority,
        requestId: key,
      },
      key,
    };
  });
}

export interface PlacementSummary {
  /** Newly created by this attempt. */
  placed: number;
  /** Already existed — a replay or the module's `requestId` guard. STILL A SUCCESS. */
  alreadyPlaced: number;
}

/**
 * ── A REPLAY IS A SUCCESS, AND MUST NEVER READ AS A DUPLICATE ───────────────
 * Two different things can tell us an order was already there, and neither is an error:
 *
 *   the header replay — the server returns the ORIGINAL 201, byte for byte, so `duplicate` is
 *   `false` and this code cannot even tell it happened. That is the point: the retry reports what
 *   the first attempt did, which is true.
 *
 *   `duplicate: true` — the module's own `requestId` guard answered, which happens when the header
 *   was stripped in transit. Also true, also a success, and the ONLY visible difference is that we
 *   know the order predates this tap.
 *
 * The word "duplicate" never reaches the doctor. What they need to know is that the tests are on
 * the department's worklist, and after either path they are.
 */
export function summarisePlacements(results: readonly PlaceOrderResult[]): PlacementSummary {
  let placed = 0;
  let alreadyPlaced = 0;
  for (const result of results) {
    if (result.duplicate) alreadyPlaced += 1;
    else placed += 1;
  }
  return { placed, alreadyPlaced };
}

/** The sentence shown after a submission. Never the word "duplicate", never the word "error". */
export function placementMessage(summary: PlacementSummary): string {
  const total = summary.placed + summary.alreadyPlaced;
  if (total === 0) return "Nothing to order.";
  const noun = total === 1 ? "test" : "tests";
  const already =
    summary.alreadyPlaced > 0 ? ` (${String(summary.alreadyPlaced)} was already ordered)` : "";
  return `${String(total)} ${noun} ordered — on the department worklist now${already}.`;
}
