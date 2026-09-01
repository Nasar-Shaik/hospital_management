/**
 * Prints the API's authorization surface — every route that actually shipped,
 * with the permission and feature flag it actually enforces.
 *
 *     pnpm --filter @medicore/api routes
 *
 * Read from the LIVE Express app, never from a document, so it cannot be out of
 * date. This is the human-readable view of what the RBAC matrix suite enforces
 * mechanically: if a route appears here as PUBLIC and you did not intend it to be,
 * you have just found a hole.
 */
import { createLogger } from "@medicore/logger";
import { createApp } from "../app.js";
import { routeInventory } from "../core/http/routeInventory.js";

const app = createApp(createLogger({ service: "route-audit" }));
const routes = routeInventory(app);

function guardOf(route: (typeof routes)[number]): string {
  if (route.permission) return route.permission;
  if (route.platformRoles?.length) return `operator: ${route.platformRoles.join(" or ")}`;
  if (route.platformAuth) return "operator (any role)";
  if (route.authenticates) return "(authenticated — no permission)";
  return "PUBLIC";
}

/**
 * The path column is sized from the DATA, not from a constant.
 *
 * It used to be `padEnd(46)`, and `padEnd` returns the string untouched when it is
 * already longer than the width — so the moment a path passed 46 characters the
 * guard was printed flush against it:
 *
 *     GET    /api/v1/patients/:patientId/insurance-policiesinsurance:link
 *
 * which reads as a route with NO permission. Four routes were being rendered that
 * way. An audit tool that can show a protected route as unprotected is worse than
 * no audit tool — it is the same failure as the 14 operator routes this inventory
 * once mislabelled PUBLIC. Sizing the column to the longest path means it cannot
 * happen again as routes grow.
 */
const pathWidth = Math.max(...routes.map((r) => r.path.length)) + 2;

for (const route of routes) {
  const feature = route.feature ? `  feature=${route.feature}` : "";
  process.stdout.write(
    `${route.method.padEnd(7)}${route.path.padEnd(pathWidth)}${guardOf(route)}${feature}\n`,
  );
}

const open = routes.filter((r) => guardOf(r) === "PUBLIC");
process.stdout.write(`\n${String(routes.length)} routes, ${String(open.length)} public\n`);
