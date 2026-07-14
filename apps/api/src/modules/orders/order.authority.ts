/**
 * WHO MAY SIGN OFF WHAT.
 *
 * ── THE HOLE THIS EXISTS TO CLOSE ───────────────────────────────────────────
 * ADR-0013 §3 makes the Order polymorphic: one object, one lifecycle, seven
 * categories. That is right, and it is what makes a single work queue possible. But
 * it has a sharp edge that is easy to miss.
 *
 * A single generic `order:verify` permission would mean a PATHOLOGIST could sign off
 * a CT scan and a RADIOLOGIST could certify a blood culture. Both hold `order:verify`;
 * the object is the same shape; nothing would stop them. That is not a workflow nit
 * — verification is the second pair of eyes that stands between a wrong number and a
 * doctor acting on it, and a second pair of eyes that cannot read the result is not a
 * check at all. It is a signature.
 *
 * ── HOW IT IS CLOSED, WITHOUT NEW MACHINERY ─────────────────────────────────
 * The verb is generic; the AUTHORITY is specific. To verify a `lab` order you need
 * `order:verify` AND `lab:approve`. To verify a `radiology` order you need
 * `order:verify` AND `radiology:sign`.
 *
 * Both of those category permissions ALREADY EXISTED in the permissions package
 * before Orders was built — they were written for the Lab and Radiology modules that
 * have not landed yet. So this costs a lookup table and no new RBAC concepts: no
 * per-role category lists, no scope engine, nothing for a future reader to discover.
 *
 * ── CATEGORIES WITH NO ENTRY ────────────────────────────────────────────────
 * A category absent from this map requires `order:verify` alone. That is deliberate
 * and it is not an oversight: a procedure or a diet order has no specialist
 * registry to check a signature against, and inventing `procedure:approve` today —
 * with no procedure module, no role that holds it, and no test that exercises it —
 * would be a permission that exists only to make this table look symmetrical.
 *
 * When Radiology and Lab land as real modules, this map is the file they extend. It
 * is the whole surface.
 */
import { PERMISSIONS, type PermissionDefinition } from "@medicore/permissions";
import type { OrderCategory } from "./order.model.js";

const VERIFY_AUTHORITY: Partial<Record<OrderCategory, PermissionDefinition>> = {
  lab: PERMISSIONS.LAB_APPROVE,
  radiology: PERMISSIONS.RADIOLOGY_SIGN,
};

/**
 * The EXTRA permission required to verify an order of this category, beyond the
 * generic `order:verify`. `undefined` when the category has no specialist registry.
 */
export function verifyAuthorityFor(category: OrderCategory): PermissionDefinition | undefined {
  return VERIFY_AUTHORITY[category];
}
