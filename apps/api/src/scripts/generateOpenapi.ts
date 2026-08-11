/**
 * Writes the OpenAPI 3.1 spec to `apps/api/openapi.json` — a committed, reviewable artifact.
 *
 *     pnpm --filter @medicore/api openapi
 *
 * Built from the SHIPPED Express app (no database needed — `createApp` only mounts routes), so the
 * committed file is exactly what the running server serves at `GET /api/v1/openapi.json`. Run it
 * after adding routes; a stale diff here is the review signal that the contract changed.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { format, resolveConfig } from "prettier";
import { createLogger } from "@medicore/logger";
import { createApp } from "../app.js";
import { specFromApp } from "../core/http/openapi.js";

const app = createApp(createLogger({ service: "openapi-gen" }));
const spec = specFromApp(app);

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../openapi.json");

/**
 * ── WHY THE GENERATOR FORMATS ITS OWN OUTPUT ────────────────────────────────
 * It used to write `JSON.stringify(spec, null, 2)`, which Prettier then reformatted (it collapses
 * short arrays that `stringify` always expands). `openapi.json` is not in `.prettierignore`, so
 * the two disagreed permanently:
 *
 *     pnpm openapi        → 829 lines of churn, none of it a contract change
 *     pnpm format:check   → fails, because the generator's shape is not Prettier's
 *
 * That is why the spec sat un-regenerated for two weeks: every run looked like a huge diff, and a
 * REAL contract change would have hidden inside it. It also made the documented standard —
 * "OpenAPI regenerated on every merge (CI)" — impossible, since regenerating broke the gate's
 * first step.
 *
 * Formatting here rather than adding the file to `.prettierignore` keeps the artifact under the
 * same formatting rule as everything else a human reads, and makes the drift gate meaningful:
 * `generate → format → generate` is now a fixed point, so any diff after regeneration is a
 * contract change and nothing else.
 */
const prettierOptions = await resolveConfig(out);
const json = await format(JSON.stringify(spec, null, 2), {
  ...prettierOptions,
  filepath: out,
  parser: "json",
});
writeFileSync(out, json);

const pathCount = Object.keys((spec as { paths: object }).paths).length;
process.stdout.write(`wrote ${out} — ${String(pathCount)} paths\n`);
