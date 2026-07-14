#!/usr/bin/env node
/**
 * `pnpm verify` — is the local stack actually working?
 *
 * ⚠️  THE NAME IS LOAD-BEARING. Do not rename this to `doctor`, `audit`, `check`,
 *     `status` or any other pnpm BUILT-IN command. pnpm resolves built-ins BEFORE
 *     package scripts, so `pnpm doctor` silently runs *pnpm's* doctor and your
 *     script never executes — it prints an unrelated warning and exits 0, which
 *     looks exactly like a script that ran and found nothing.
 *
 *     This has now bitten us twice: once as `pnpm audit` (shadowed the audit-chain
 *     CLI) and once as `pnpm doctor`. Before naming a script, run `pnpm <name>` in
 *     a repo that does NOT define it: `Command "<name>" not found` means the name
 *     is safe; anything else means pnpm owns it.
 *
 * WHY THIS EXISTS
 * ---------------
 * Verifying "can I log in" turned into an archaeology dig: the page loaded but
 * the API did not answer; curl said everything was healthy while the browser
 * could not connect; a stale build cache threw an error about a file nobody
 * wrote. Every one of those had a one-line cause and took far too long to find,
 * because there was nowhere to LOOK — you had to already know which of six things
 * to suspect.
 *
 * So this checks all six, in the order they actually fail, and tells you the fix
 * rather than the symptom. It ends by performing a REAL login against the running
 * API — because "the port is open" is not the same claim as "I can sign in", and
 * only the second one is what you wanted to know.
 *
 * Run it whenever something looks wrong. It changes nothing; it only looks.
 */
import { lookup } from "node:dns/promises";
import { execSync } from "node:child_process";

const WEB_PORT = process.env.WEB_PORT ?? "3000";
const API_PORT = process.env.API_PORT ?? "4000";
const SLUG = process.argv[2] ?? "demo";
const HOST = `${SLUG}.localhost`;

const EMAIL = process.env.DOCTOR_EMAIL ?? "admin@demo.test";
const PASSWORD = process.env.DOCTOR_PASSWORD ?? "123456";

const results = [];
let failed = 0;

function record(ok, name, detail, fix) {
  results.push({ ok, name, detail, fix });
  if (!ok) failed++;
}

async function get(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* 1 ── Docker: nothing else can work without Mongo and Redis. */
try {
  const out = execSync(
    "docker compose -f infra/docker/docker-compose.yml ps --format '{{.Service}} {{.Status}}'",
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const up = ["mongo", "redis"].filter((s) => out.includes(s) && /Up/.test(out));
  record(
    up.length === 2,
    "Infrastructure (Mongo + Redis)",
    up.length === 2 ? "both containers up" : "mongo and/or redis are not running",
    "pnpm docker:dev",
  );
} catch {
  record(
    false,
    "Infrastructure (Mongo + Redis)",
    "docker compose not reachable",
    "pnpm docker:dev",
  );
}

/* 2 ── DNS: <slug>.localhost must resolve, or the browser never leaves the gate. */
try {
  const addrs = await lookup(HOST, { all: true });
  const list = addrs.map((a) => a.address).join(", ");
  record(true, `DNS: ${HOST}`, `resolves to ${list}`, null);
} catch {
  record(
    false,
    `DNS: ${HOST}`,
    "does not resolve",
    "Your OS/browser does not map *.localhost to loopback. Add to /etc/hosts:\n" +
      `      127.0.0.1 ${HOST}\n      ::1       ${HOST}`,
  );
}

/* 3 ── The API, on the address the BROWSER will use — not on 127.0.0.1.
 *
 * This is the check that would have caught the IPv6 bug in seconds: the API bound
 * IPv4-only while `<slug>.localhost` resolves to ::1 first, so curl (which falls
 * back to IPv4) said "healthy" while the browser could not connect at all.
 */
try {
  const res = await get(`http://${HOST}:${API_PORT}/health`);
  record(res.ok, `API on http://${HOST}:${API_PORT}`, `HTTP ${res.status}`, null);
} catch (err) {
  record(
    false,
    `API on http://${HOST}:${API_PORT}`,
    err.name === "AbortError" ? "timed out" : "connection refused",
    "The API is not running, or is bound to the wrong address family.\n" +
      "      Start it:  pnpm dev\n" +
      "      If `curl 127.0.0.1:4000/health` works but this does not, the API is\n" +
      "      IPv4-only while *.localhost resolves to ::1 — leave API_BIND empty.",
  );
}

/* 4 ── The web app. */
try {
  const res = await get(`http://${HOST}:${WEB_PORT}/login`);
  record(res.ok, `Web on http://${HOST}:${WEB_PORT}`, `HTTP ${res.status}`, null);
} catch {
  record(
    false,
    `Web on http://${HOST}:${WEB_PORT}`,
    "not reachable",
    "pnpm dev — and if it dies on a missing Webpack chunk: pnpm clean && pnpm dev",
  );
}

/* 5 ── CORS: the browser asks permission before it asks anything else. */
try {
  const res = await get(`http://${HOST}:${API_PORT}/api/v1/auth/login`, {
    method: "OPTIONS",
    headers: {
      Origin: `http://${HOST}:${WEB_PORT}`,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  const allow = res.headers.get("access-control-allow-origin");
  record(
    allow === `http://${HOST}:${WEB_PORT}`,
    "CORS preflight",
    allow ? `allows ${allow}` : "no Access-Control-Allow-Origin returned",
    "The API is refusing the browser's origin. Check TENANT_BASE_DOMAIN=localhost\n" +
      "      and NODE_ENV=development in apps/api/.env",
  );
} catch {
  record(false, "CORS preflight", "the API did not answer", "Fix the API check above first.");
}

/* 6 ── The only question that actually matters: can a human sign in? */
try {
  const res = await get(`http://${HOST}:${API_PORT}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: `http://${HOST}:${WEB_PORT}` },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const body = await res.json();

  if (body.success) {
    record(true, `Login as ${EMAIL}`, `signed in as ${body.data.user.name}`, null);
  } else {
    const code = body.error?.code;
    const fixes = {
      "HMS-AUTH-001": `Wrong password, or no such account in "${SLUG}".\n      Re-provision:  pnpm --filter @medicore/api provision -- --slug ${SLUG} --name "Demo" --admin-email ${EMAIL} --admin-password '${PASSWORD}'`,
      "HMS-TEN-001": `No hospital named "${SLUG}". Provision it (see TESTING.md §4).`,
      "HMS-TEN-002": `The hospital "${SLUG}" is suspended.`,
    };
    record(
      false,
      `Login as ${EMAIL}`,
      `${code}: ${body.error?.message}`,
      fixes[code] ?? "See AI_Workflow/docs/ERROR_CODES.md",
    );
  }
} catch {
  record(
    false,
    `Login as ${EMAIL}`,
    "the request never completed",
    "Fix the API check above first.",
  );
}

/* ── report ─────────────────────────────────────────────────────────────── */

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const OFF = "\x1b[0m";

process.stdout.write(
  `\n  ${BOLD}MediCore — local stack${OFF}  ${DIM}(hospital: ${SLUG})${OFF}\n\n`,
);

for (const r of results) {
  const mark = r.ok ? `${GREEN}✔${OFF}` : `${RED}✘${OFF}`;
  process.stdout.write(`  ${mark} ${r.name.padEnd(34)} ${DIM}${r.detail}${OFF}\n`);
  if (!r.ok && r.fix) {
    process.stdout.write(`${DIM}      → ${r.fix.replace(/\n/g, "\n")}${OFF}\n`);
  }
}

if (failed === 0) {
  process.stdout.write(
    `\n  ${GREEN}Everything works.${OFF} Sign in at ${BOLD}http://${HOST}:${WEB_PORT}${OFF}\n` +
      `  ${EMAIL} / ${PASSWORD}\n\n`,
  );
} else {
  process.stdout.write(
    `\n  ${RED}${failed} check${failed === 1 ? "" : "s"} failed.${OFF} Fix the FIRST one — the rest usually follow.\n\n`,
  );
  process.exitCode = 1;
}
