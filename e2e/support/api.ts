import { expect, type APIRequestContext } from "@playwright/test";
import { PASSWORD } from "./app";

/**
 * The little bit of HTTP a browser test needs to ARRANGE something, as opposed to assert it.
 *
 * ── WHY A BROWSER TEST TALKS TO THE API AT ALL ──────────────────────────────
 * The laboratory worklist can only be tested against work that exists, and the seeded hospital's
 * lab orders drift: `seed:clinical` puts two on the board, anybody's afternoon of clicking adds
 * more, and a test that asserts on "whatever is there" proves whatever happens to be there.
 *
 * So the worklist spec places its own order through the real API, asserts what the browser draws,
 * and cancels it again. Placing it through the UI instead would be a second, slower copy of the
 * ordering test — and the thing under test is the WORKLIST, not the order pad.
 *
 * Nothing here bypasses authorization: every call carries a real token for a real account and is
 * refused exactly as the application would refuse it.
 */

/** The API is a sibling port on the same tenant hostname in dev (`lib/api.ts` `apiBaseUrl`). */
export function apiOrigin(webBaseUrl: string): string {
  const url = new URL(webBaseUrl);
  return process.env.E2E_API_URL ?? `${url.protocol}//${url.hostname}:4000`;
}

export async function token(
  request: APIRequestContext,
  api: string,
  email: string,
): Promise<string> {
  const res = await request.post(`${api}/api/v1/auth/login`, {
    data: { email, password: PASSWORD },
  });
  expect(res.ok(), `could not sign ${email} in at ${api}`).toBe(true);
  const body = (await res.json()) as { data: { accessToken: string } };
  return body.data.accessToken;
}

function headers(bearer: string, branchId?: string): Record<string, string> {
  return {
    authorization: `Bearer ${bearer}`,
    ...(branchId ? { "x-active-branch": branchId } : {}),
  };
}

/** One enveloped GET, failing with the body rather than a bare status when it is not a success. */
export async function apiGet<T>(
  request: APIRequestContext,
  url: string,
  bearer: string,
  branchId?: string,
): Promise<T> {
  const res = await request.get(url, { headers: headers(bearer, branchId) });
  const body = (await res.json()) as { success: boolean; data?: T };
  expect(body.success, `${url} answered ${String(res.status())}: ${JSON.stringify(body)}`).toBe(
    true,
  );
  return body.data as T;
}

export async function apiPost<T>(
  request: APIRequestContext,
  url: string,
  bearer: string,
  data: unknown,
  branchId?: string,
): Promise<T> {
  const res = await request.post(url, { headers: headers(bearer, branchId), data });
  const body = (await res.json()) as { success: boolean; data?: T };
  expect(body.success, `${url} answered ${String(res.status())}: ${JSON.stringify(body)}`).toBe(
    true,
  );
  return body.data as T;
}

export interface Site {
  id: string;
  name: string;
  status: string;
}

/** The sites this account may work in, newest-first as the switcher lists them. */
export async function sites(
  request: APIRequestContext,
  api: string,
  bearer: string,
): Promise<Site[]> {
  const data = await apiGet<{ branches: Site[] }>(request, `${api}/api/v1/me/branches`, bearer);
  return data.branches.filter((b) => b.status === "active");
}
