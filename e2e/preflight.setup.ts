import { expect, test as setup } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { ACCOUNTS, PASSWORD } from "./support/app";

/**
 * The environment this suite needs, checked once, out loud.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * The browser tests need more than a running server: they need the hospital `seed:validation`
 * builds — two open sites, patients admitted at BOTH of them, a signed prescription with doses on
 * the ward, and the four demo accounts. Before this file, a database missing any of that produced
 * `test.skip("needs a hospital with two sites")` and a **green run**.
 *
 * That is the worst possible outcome. A skipped test reports as "not a problem" in exactly the
 * situation where the most valuable tests in the suite — cross-branch display of PHI — were not
 * run at all. The release gate would have said 10/10 while proving nothing about branch isolation
 * in a browser.
 *
 * So the prerequisites are now a **setup project every other project depends on**. A missing one
 * fails here, once, naming the command that fixes it, and Playwright marks the dependent tests as
 * not-run rather than passed. The specs themselves no longer carry skips.
 *
 * ── WHY IT SPEAKS HTTP AND NOT A BROWSER ────────────────────────────────────
 * These are facts about the DATABASE, not about rendering. Asking the API directly makes the check
 * fast (about a second), makes the failure message exact — "branch B has no occupied beds" beats
 * "locator not found" — and keeps a broken environment from being reported as a broken UI.
 */

/** The API is a sibling port on the same tenant hostname in dev (`lib/api.ts` `apiBaseUrl`). */
function apiOrigin(webBaseUrl: string): string {
  const url = new URL(webBaseUrl);
  return process.env.E2E_API_URL ?? `${url.protocol}//${url.hostname}:4000`;
}

const FIX = "run `pnpm docker:dev && pnpm seed:migrate && pnpm seed:validation`";

setup("the seeded hospital this suite needs is present", async ({ request, baseURL }) => {
  const api = apiOrigin(baseURL ?? "http://sunrise.localhost:3000");

  /* ── 1. The accounts ─────────────────────────────────────────────────────
   * Checked for ALL of them, not just the first — reporting one missing account at a time turns
   * a single re-seed into four runs.
   */
  const tokens = new Map<string, string>();
  const missing: string[] = [];
  for (const [role, email] of Object.entries(ACCOUNTS)) {
    const token = await signInFor(request, api, email);
    if (token) tokens.set(role, token);
    else missing.push(`${role} (${email})`);
  }
  expect(missing, `these demo accounts cannot sign in at ${api} — ${FIX}`).toEqual([]);

  const nurse = tokens.get("nurse") ?? "";

  /* ── 2. Two open sites ───────────────────────────────────────────────────
   * The branch tests are the reason this suite exists. One site is not a weaker test of branch
   * isolation — it is no test of it.
   */
  const branches = await json<{ branches: Site[] }>(request, `${api}/api/v1/me/branches`, nurse);
  const open = branches.branches.filter((b) => b.status === "active");
  expect(
    open.length,
    `the nurse can work in fewer than two open sites (${open.map((b) => b.name).join(", ") || "none"}), ` +
      `so every branch-isolation test would be skipped rather than run — ${FIX}`,
  ).toBeGreaterThanOrEqual(2);

  // The first two, because that is the pair the specs compare. A hospital on three sites is a
  // legitimate seed; it simply means the third is not part of what these tests contrast.
  const [siteA, siteB] = open as [Site, Site];

  /* ── 3. Both sites have patients in beds, and not the same beds ──────────
   * THE CHECK THAT MATTERS MOST, and the one whose absence is invisible.
   *
   * `branchSwitch.spec.ts` asserts that no bed from site A survives a switch to site B. If site B
   * is empty that assertion compares against nothing and passes for free — a vacuous green on the
   * single most important browser test in the repository. Requiring beds at both sites, with
   * disjoint codes, is what makes that test capable of failing.
   */
  const bedsA = await occupiedBeds(request, api, nurse, siteA.id);
  const bedsB = await occupiedBeds(request, api, nurse, siteB.id);
  expect(bedsA.length, `${siteA.name} has no occupied beds — ${FIX}`).toBeGreaterThan(0);
  expect(
    bedsB.length,
    `${siteB.name} has no occupied beds, so the cross-branch ward test would ` +
      `have nothing to contradict it and would pass vacuously — ${FIX}`,
  ).toBeGreaterThan(0);

  const shared = bedsA.filter((b) => bedsB.includes(b));
  expect(
    shared,
    `${siteA.name} and ${siteB.name} use the same bed codes (${shared.join(", ")}), so a bed ` +
      `surviving a branch switch would be indistinguishable from a legitimate one — ${FIX}`,
  ).toEqual([]);

  /* ── 4. Doses on the ward ────────────────────────────────────────────────
   * `clinicalSafety.spec.ts` proves a doctor is offered no live dose control. On a round with no
   * doses that proves nothing, which is why the spec itself also insists the rows exist — this
   * check turns that from a confusing mid-test failure into a one-line environment report.
   */
  const round = await json<RoundRow[]>(
    request,
    `${api}/api/v1/medication-round?limit=100`,
    nurse,
    siteA.id,
  );
  const slots = round.reduce((n, r) => n + r.slots.length, 0);
  expect(
    slots,
    `no doses are scheduled at ${siteA.name} today, so the medication-round tests have nothing ` +
      `to read — ${FIX}`,
  ).toBeGreaterThan(0);

  /* ── 5. Colleagues to list ───────────────────────────────────────────────
   * The staff directory tests count people and compare the count to the table under it.
   */
  const staff = await json<{ id: string }[]>(
    request,
    `${api}/api/v1/users?limit=100`,
    tokens.get("admin") ?? "",
  );
  expect(staff.length, `the staff directory is empty — ${FIX}`).toBeGreaterThan(0);
});

/* ── the small amount of HTTP this needs ───────────────────────────────────── */

interface Site {
  id: string;
  name: string;
  status: string;
}

interface RoundRow {
  bedCode?: string;
  slots: unknown[];
}

interface Stay {
  bed?: { bedCode?: string };
}

/** The access token for an account, or `undefined` if it cannot sign in for any reason. */
async function signInFor(
  request: APIRequestContext,
  api: string,
  email: string,
): Promise<string | undefined> {
  const res = await request
    .post(`${api}/api/v1/auth/login`, { data: { email, password: PASSWORD } })
    .catch(() => undefined);
  if (!res?.ok()) return undefined;
  const body = (await res.json()) as { data?: { accessToken?: string } };
  return body.data?.accessToken;
}

/** One enveloped GET, with the failure body in the message when it is not a success. */
async function json<T>(
  request: APIRequestContext,
  url: string,
  token: string,
  branchId?: string,
): Promise<T> {
  const res = await request.get(url, {
    headers: {
      authorization: `Bearer ${token}`,
      ...(branchId ? { "x-active-branch": branchId } : {}),
    },
  });
  const body = (await res.json()) as { success: boolean; data?: T };
  expect(body.success, `${url} answered ${String(res.status())}: ${JSON.stringify(body)}`).toBe(
    true,
  );
  return body.data as T;
}

/** The bed codes actually occupied at one site. */
async function occupiedBeds(
  request: APIRequestContext,
  api: string,
  token: string,
  branchId: string,
): Promise<string[]> {
  const stays = await json<Stay[]>(request, `${api}/api/v1/inpatients?limit=100`, token, branchId);
  return [...new Set(stays.map((s) => s.bed?.bedCode).filter((c): c is string => Boolean(c)))];
}
