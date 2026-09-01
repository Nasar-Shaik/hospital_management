import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { ACCOUNTS, signIn } from "./support/app";
import { apiGet, apiOrigin, apiPost, sites, token } from "./support/api";

/**
 * The alert inbox — the last hop of every message the hospital already generates.
 *
 * ── WHAT DEFECT WOULD THIS CATCH? ───────────────────────────────────────────
 * The seam this milestone exists to close, and the half a browser is the only witness to.
 *
 * The API side is pinned in `notifications.int.test.ts`: scoping, read state, the shape, the
 * channel. None of that can fail the way this can — by delivering perfectly to a bell that renders
 * no badge, a dropdown that lists nothing, or a click that marks the message read on screen and
 * never reaches the server. All three look exactly like "there is nothing for you", which is the
 * state this whole milestone was built to end.
 *
 * ── WHY IT WALKS A REAL ORDER ───────────────────────────────────────────────
 * There is no `POST /notifications`, deliberately — an endpoint that sends an arbitrary message to
 * an arbitrary person is a spam cannon with a REST interface. So the only way to produce a genuine
 * addressed message is to make the domain raise one: the doctor orders a test, the lab runs it,
 * the pathologist releases it, and `onResultReleased` tells the doctor who asked.
 *
 * ── WHAT IT LEAVES BEHIND ───────────────────────────────────────────────────
 * One released order and one message, per run. Neither is junk: `released` is terminal and sits on
 * no worklist, and a completed lab test with a result is exactly what a demo hospital should have.
 * The message is left READ, which is what the test does to it. Contrast `labWorklist.spec.ts`,
 * which cancels its order because a `placed` one would sit on the bench's board forever.
 *
 * The assertions are therefore RELATIVE — the badge goes up by at least this message, never "the
 * badge says 1" — so the tenth run behaves like the first.
 */

interface Stay {
  id: string;
  patientName: string;
}

interface PlacedOrder {
  order: { id: string; name: string };
}

interface Fixture {
  api: string;
  adminToken: string;
  doctorToken: string;
  siteId: string;
  orderId: string;
  testName: string;
}

let fixture: Fixture;

/** Places a test as the DOCTOR, then walks it to released as the admin. */
async function arrange(request: APIRequestContext, baseURL: string): Promise<Fixture> {
  const api = apiOrigin(baseURL);
  const [adminToken, doctorToken] = await Promise.all([
    token(request, api, ACCOUNTS.admin),
    token(request, api, ACCOUNTS.doctor),
  ]);

  const open = await sites(request, api, adminToken);
  expect(open.length, "no site to work in — run pnpm seed:validation").toBeGreaterThan(0);
  const siteId = open[0]!.id;

  const stays = await apiGet<Stay[]>(
    request,
    `${api}/api/v1/inpatients?limit=20`,
    adminToken,
    siteId,
  );
  expect(
    stays.length,
    "no open admission to hang a test order on — run pnpm seed:validation",
  ).toBeGreaterThan(0);

  /**
   * Placed by the DOCTOR, because `orderedBy` is who gets told. Placing it as the admin would send
   * the message to the admin and the test would prove nothing about the person who asked the
   * question.
   */
  const stamp = Date.now().toString();
  const placed = await apiPost<PlacedOrder>(
    request,
    `${api}/api/v1/orders`,
    doctorToken,
    {
      encounterId: stays[0]!.id,
      category: "lab",
      code: "GLU",
      name: `Fasting Glucose (inbox ${stamp})`,
      priority: "routine",
      requestId: `e2e-inbox-${stamp}`,
    },
    siteId,
  );

  // The bench and the signature. The admin holds every permission including `lab:approve`, which
  // is what verifying a LAB result needs on top of `order:verify` (order.authority.ts).
  const walk = async (step: string, body?: unknown) => {
    const res = await request.post(`${api}/api/v1/orders/${placed.order.id}/${step}`, {
      headers: { authorization: `Bearer ${adminToken}`, "x-active-branch": siteId },
      ...(body ? { data: body } : {}),
    });
    expect(res.ok(), `could not ${step} the test order: ${await res.text()}`).toBe(true);
  };

  await walk("accept");
  await walk("start");
  await walk("complete", { summary: "Fasting glucose 92 mg/dL — within range." });
  await walk("verify");
  await walk("release");

  return {
    api,
    adminToken,
    doctorToken,
    siteId,
    orderId: placed.order.id,
    testName: placed.order.name,
  };
}

test.describe.configure({ mode: "serial" });

test.describe("the alert inbox", () => {
  test.beforeAll(async ({ request, baseURL }) => {
    fixture = await arrange(request, baseURL ?? "http://sunrise.localhost:3000");
  });

  /**
   * Leave the doctor's badge as it was found. The test marks its own message read through the UI,
   * which is the point of it — this is for the run that is interrupted before it gets there, so a
   * crashed run does not leave an unread alert on the demo hospital forever.
   */
  test.afterAll(async ({ request }) => {
    await request
      .get(`${fixture.api}/api/v1/notifications/me?unread=true&limit=100`, {
        headers: { authorization: `Bearer ${fixture.doctorToken}` },
      })
      .then(async (res) => {
        const body = (await res.json()) as { data?: { id: string; body: string }[] };
        const mine = (body.data ?? []).filter((m) => m.body.includes(fixture.testName));
        for (const m of mine) {
          await request.post(`${fixture.api}/api/v1/notifications/${m.id}/read`, {
            headers: { authorization: `Bearer ${fixture.doctorToken}` },
          });
        }
      })
      .catch(() => undefined);
  });

  test("tells the doctor their result is ready, and stops telling them once read", async ({
    page,
  }) => {
    await signIn(page, ACCOUNTS.doctor);

    const bell = page.getByRole("button", { name: /^Alerts/ });
    await expect(bell).toBeVisible();

    const message = page.getByRole("button", { name: new RegExp(escapeRe(fixture.testName)) });

    /**
     * ── THE WAIT IS ON THIS MESSAGE, NOT ON A BADGE ─────────────────────────
     * `toPass` because release publishes through the OUTBOX: the relay polls, so the message is
     * raised a moment after the API call returned.
     *
     * The first version of this waited for `Alerts — \d+ unread` and then opened the bell, which
     * passed intermittently for the WRONG REASON: any unread message left by an earlier run
     * satisfies that badge instantly, so the click happened before the relay had delivered THIS
     * one, and the assertion below failed on a fully working system. Waiting on the specific
     * message makes the poll about the data the test is actually about.
     */
    await expect(async () => {
      await page.reload();
      await bell.click();
      await expect(message.first()).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 45_000 });

    // The bell says there is something unread. The NUMBER is deliberately not the assertion — see
    // below.
    await expect(bell).toHaveAttribute("aria-label", /unread/);

    /**
     * ── WHY THIS NO LONGER COUNTS ───────────────────────────────────────────
     * This used to read the badge, then assert it fell by exactly one. The badge is CAPPED at
     * "99+" (`lib/alerts.ts` — a two-character dot cannot show "247"), and a demo hospital
     * eventually crosses a hundred unread alerts. At that point the parser read "99+ unread" as
     * no match, returned 0, and the test failed on a completely healthy system — arithmetic on a
     * number the product deliberately stops reporting.
     *
     * The claim was never about the count. It is that opening a message marks it read ON THE
     * SERVER, so the assertion is that THIS message leaves the bell's unread list and does not
     * come back across a full reload. An optimistic update that never persisted would survive a
     * re-render; it does not survive this.
     */
    await message.first().click();
    await page.reload();
    await expect(async () => {
      await bell.click();
      await expect(message).toHaveCount(0, { timeout: 5_000 });
    }).toPass({ timeout: 15_000 });
  });

  test("keeps the full message on the alerts page, filed rather than deleted", async ({ page }) => {
    await signIn(page, ACCOUNTS.doctor);
    await page.goto("/alerts");

    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Alerts" })).toBeVisible();

    // Read in the previous test, and still here — opening a message files it, it does not remove it.
    const row = main.getByRole("button", { name: new RegExp(escapeRe(fixture.testName)) });
    await expect(row.first(), "a message vanished from the inbox once it was read").toBeVisible({
      timeout: 15_000,
    });
    await expect(
      main.getByText("The report is available on the patient's chart.").first(),
    ).toBeVisible();
  });

  /**
   * ── THE INBOX IS NOT SOMEBODY ELSE'S ────────────────────────────────────────
   * The administrator holds every permission in the catalogue. The message is addressed to the
   * doctor, so none of that helps — and this is the assertion that separates "scoped to the
   * caller" from "returns everything", which are indistinguishable from a single account.
   */
  test("does not show one person's alerts to another", async ({ page }) => {
    await signIn(page, ACCOUNTS.admin);
    await page.goto("/alerts");

    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "Alerts" })).toBeVisible();
    await expect(async () => {
      expect(await main.innerText()).not.toContain(fixture.testName);
    }).toPass({ timeout: 15_000 });
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
