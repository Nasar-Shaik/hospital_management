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
import { createLogger } from "@medicore/logger";
import { createApp } from "../app.js";
import { specFromApp } from "../core/http/openapi.js";

const app = createApp(createLogger({ service: "openapi-gen" }));
const spec = specFromApp(app);

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../openapi.json");
writeFileSync(out, `${JSON.stringify(spec, null, 2)}\n`);

const pathCount = Object.keys((spec as { paths: object }).paths).length;
process.stdout.write(`wrote ${out} — ${String(pathCount)} paths\n`);
