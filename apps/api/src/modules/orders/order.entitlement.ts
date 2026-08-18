/**
 * WHICH ORDER CATEGORIES A HOSPITAL HAS TO HAVE BOUGHT.
 *
 * ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────
 * `module.clinical.ris` appears in four editions — Diagnostic Centre, Hospital, Hospital Plus and
 * Enterprise — and, until now, gated no line of code. A hospital paid for imaging and got it
 * whether or not it paid, because the order routes gate on `module.ops.opd`, which every edition
 * holds. An entitlement that grants nothing is worse than one that does not exist: it is a
 * promise on an invoice with no software behind it.
 *
 * ── WHY A MAP AND NOT A FLAG ON THE ROUTE ───────────────────────────────────
 * The Order is polymorphic (ADR-0013 §3): ONE set of routes carries lab, radiology, pharmacy,
 * procedure, referral, admission and diet. A `{ feature }` on `POST /orders` would gate all seven
 * on one flag, which is exactly wrong — a clinic that never bought imaging still orders bloods.
 * The entitlement is a property of the CATEGORY, so it is looked up where the category is known.
 *
 * This is deliberately the same shape as `order.authority.ts`, which answers the neighbouring
 * question ("who may sign this off?") the same way: a small map, no new concepts, and the file a
 * future module extends is the whole surface.
 *
 * ── WHY LAB IS NOT IN HERE ──────────────────────────────────────────────────
 * It looks like the obvious second entry and it would be a regression. `module.clinical.lis` is
 * NOT in `CLINIC_FLAGS`, so PLAN_CLINIC and PLAN_CLINIC_PLUS do not hold it — and those hospitals
 * legitimately order bloods today and send the sample to an external laboratory. Gating `lab`
 * here would take a working capability away from every clinic on the platform to make a table
 * look symmetrical. The lab's own flag correctly gates the thing it actually sells: the test
 * CATALOGUE with its analytes and reference ranges (`labTest.routes.ts`).
 *
 * Radiology has no such case: an X-ray cannot be "sent out" as a sample, and an order this
 * hospital can never perform would sit in `AWAITED_CATEGORIES` forever, holding its patient in
 * `awaiting_results` and never releasing them back to the doctor. Refusing it is the fix.
 */
import { FEATURE_FLAGS, type FeatureFlag } from "@medicore/permissions";
import type { OrderCategory } from "./order.model.js";

const CATEGORY_FEATURE: Partial<Record<OrderCategory, FeatureFlag>> = {
  radiology: FEATURE_FLAGS.CLINICAL_RIS,
};

/**
 * The feature a hospital must hold to raise an order in this category, or `undefined` when the
 * category is part of the base product.
 */
export function featureForCategory(category: OrderCategory): FeatureFlag | undefined {
  return CATEGORY_FEATURE[category];
}
