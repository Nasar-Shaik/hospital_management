import { expect, test } from "@playwright/test";
import type { APIRequestContext, Page } from "@playwright/test";
import { ACCOUNTS, signIn, switchToBranch } from "./support/app";
import { apiGet, apiOrigin, apiPost, sites, token } from "./support/api";

/**
 * The laboratory worklist — the last screen in the LIS with no browser coverage.
 *
 * ── WHAT DEFECT WOULD THIS CATCH? ───────────────────────────────────────────
 * The seam between an order existing and a technician being able to act on it. Everything either
 * side of that seam is already proven: `orders.int.test.ts` walks the state machine, the RBAC
 * matrix pins who may call each transition, and `branchIsolation.int.test.ts` proves the list stops
 * at the branch. None of them can fail the way this screen can — by rendering the right data with
 * the wrong affordances, or the wrong patient's name against the right test.
 *
 * Specifically it would catch: a worklist that loads empty because the page sends no branch; a row
 * that cannot name its patient (the D-1 class, here at the bench rather than the ward); a payment
 * badge that disagrees with the API and holds work that has in fact been paid for; and the action
 * control vanishing, which looks exactly like "there is nothing to do".
 *
 * ── WHY IT ARRANGES ITS OWN ORDER ───────────────────────────────────────────
 * The seeded hospital's lab orders drift — `seed:clinical` puts two on the board and any afternoon
 * of clicking adds more — so a test that asserts on "whatever is there" proves whatever happens to
 * be there, and cannot know the patient or the payment state it should expect.
 *
 * So one order is placed through the real API, asserted in the browser, and CANCELLED again in
 * teardown. Cancel is a legal edge from `placed` (STATE_MACHINE_CATALOG §15), it reverses the
 * charge the order raised, and it leaves the board exactly as it was found. No patient is created
 * — the order hangs off an admission the seed already made, because a patient is the one row this
 * suite could not clean up afterwards.
 */

interface Stay {
  id: string;
  patientId: string;
  patientName: string;
  uhid: string;
}

interface PlacedOrder {
  order: { id: string; code: string; name: string };
}

/** Everything the browser half needs, arranged over HTTP before it opens. */
interface Fixture {
  api: string;
  adminToken: string;
  siteA: { id: string; name: string };
  siteB: { id: string; name: string } | undefined;
  orderId: string;
  patientName: string;
  uhid: string;
}

let fixture: Fixture;

async function arrange(request: APIRequestContext, baseURL: string): Promise<Fixture> {
  const api = apiOrigin(baseURL);
  const adminToken = await token(request, api, ACCOUNTS.admin);

  const open = await sites(request, api, adminToken);
  expect(open.length, "no site to work in — run pnpm seed:validation").toBeGreaterThan(0);
  const siteA = open[0]!;

  /**
   * An admission the seed already made. `seed:validation` leaves 42 of them at the main site, and
   * an inpatient stay is an OPEN encounter — which is what an order requires and what makes this
   * independent of whether anyone is mid-consultation right now.
   */
  const stays = await apiGet<Stay[]>(
    request,
    `${api}/api/v1/inpatients?limit=20`,
    adminToken,
    siteA.id,
  );
  expect(
    stays.length,
    `no open admission at ${siteA.name} to hang a test order on — run pnpm seed:validation`,
  ).toBeGreaterThan(0);
  const stay = stays[0]!;

  const placed = await apiPost<PlacedOrder>(
    request,
    `${api}/api/v1/orders`,
    adminToken,
    {
      encounterId: stay.id,
      category: "lab",
      code: "CBC",
      name: "Complete Blood Count",
      priority: "routine",
      // A key per RUN, so a re-run after a crash that left the order behind replays rather than
      // drawing a second tube — the same discipline the order pad uses.
      requestId: `e2e-lab-worklist-${Date.now().toString()}`,
    },
    siteA.id,
  );

  return {
    api,
    adminToken,
    siteA,
    siteB: open[1],
    orderId: placed.order.id,
    patientName: stay.patientName,
    uhid: stay.uhid,
  };
}

test.describe.configure({ mode: "serial" });

test.describe("the laboratory worklist", () => {
  test.beforeAll(async ({ request, baseURL }) => {
    fixture = await arrange(request, baseURL ?? "http://sunrise.localhost:3000");
  });

  /** Put the board back. Cancel is legal from `placed` and un-bills what the order raised. */
  test.afterAll(async ({ request }) => {
    await request
      .post(`${fixture.api}/api/v1/orders/${fixture.orderId}/cancel`, {
        headers: {
          authorization: `Bearer ${fixture.adminToken}`,
          "x-active-branch": fixture.siteA.id,
        },
        data: { reason: "end of browser test — leaving the board as it was found" },
      })
      .catch(() => undefined);
  });

  test("shows the lab the work, who it is for, and what may be done to it", async ({ page }) => {
    await signIn(page, ACCOUNTS.labtech);

    // A ward round is worked at one site, and so is a bench. The technician is hospital-wide in the
    // seed, so the site has to be chosen rather than assumed.
    await switchToBranch(page, fixture.siteA.name);
    await page.goto("/worklist");

    await expect(page.getByRole("heading", { name: "Worklist" })).toBeVisible();

    /**
     * ── THE PATIENT, BY NAME AND UHID ───────────────────────────────────────
     * The queue lists PEOPLE, not orders — one draw, four tests — so the row is the patient. A row
     * that cannot say whose sample it is, is the ambiguity the two-person rule exists to close, and
     * it is the same defect class as D-1 on the ward.
     */
    const queue = page.getByRole("main");
    const row = queue.getByRole("button", { name: new RegExp(escapeRe(fixture.patientName)) });
    await expect(row.first(), "the ordered test never reached the lab's queue").toBeVisible({
      timeout: 25_000,
    });
    await expect(queue.getByText(fixture.uhid).first()).toBeVisible();

    // Open the person and find the test itself.
    await row.first().click();
    await expect(queue.getByText("Complete Blood Count").first()).toBeVisible({ timeout: 15_000 });

    /**
     * ── THE PAYMENT STATE AGREES WITH THE SERVER ────────────────────────────
     * Read from the API and matched against the badge rather than hardcoded, because the seeded
     * hospital may be zero-tariff (`free`), pre-billed (`paid`) or mid-flight (`unbilled`) and all
     * three are legitimate. What must never happen is the screen saying one and the server the
     * other — that is the version where work is held for a bill somebody already settled.
     */
    /**
     * Polled, because both sides move. The charge is raised by the outbox consumer a moment after
     * the order commits, so the state walks `unbilled → unpaid` while this page is open: sampling
     * the server once and asserting the badge once could compare an answer from after the charge
     * posted against a screen painted before it. The CLAIM is that the two agree, so the honest
     * assertion is to wait until they do — and to fail if they never do.
     */
    let state = "unbilled" as keyof typeof BADGE;
    await expect(async () => {
      state = await paymentState(page, fixture);
      await expect(queue.getByText(BADGE[state], { exact: true }).first()).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 25_000 });

    /**
     * ── AND THE CONTROL THAT MATCHES IT ─────────────────────────────────────
     * `unpaid` withholds the actions and says so; anything else offers Accept. Asserting the pair
     * together is what stops this passing on a page that renders neither — which reads to a
     * technician as "there is nothing to do" and is indistinguishable from an empty bench.
     */
    if (state === "unpaid") {
      await expect(queue.getByText(/Awaiting payment|Proceed — deduct/).first()).toBeVisible();
    } else {
      await expect(
        queue.getByRole("button", { name: "Accept" }).first(),
        "a paid, placed test offered the technician no way to start it",
      ).toBeVisible();
    }
  });

  /**
   * ── CROSS-BRANCH ────────────────────────────────────────────────────────
   * WHAT DEFECT WOULD THIS CATCH?
   * The browser half of the isolation the integration suite pins on the API. A technician switched
   * to another site must not still be looking at this site's bench — and the failure mode is not an
   * error, it is a perfectly ordinary-looking queue belonging to somebody else's hospital site.
   */
  test("does not show one site's bench to the other", async ({ page }) => {
    test.skip(fixture.siteB === undefined, "single-site hospital — nothing to contrast");
    const other = fixture.siteB!;

    await signIn(page, ACCOUNTS.labtech);
    await switchToBranch(page, fixture.siteA.name);
    await page.goto("/worklist");
    await expect(
      page
        .getByRole("main")
        .getByRole("button", { name: new RegExp(escapeRe(fixture.patientName)) })
        .first(),
    ).toBeVisible({ timeout: 25_000 });

    await switchToBranch(page, other.name);

    /**
     * `toPass` retries while the routed subtree is discarded and refetched — the wait is on the
     * DATA having changed, never on a timer.
     */
    await expect(async () => {
      const text = await page.getByRole("main").innerText();
      expect(
        text,
        `${fixture.siteA.name}'s patient survived a switch to ${other.name}`,
      ).not.toContain(fixture.patientName);
      expect(text, `${fixture.siteA.name}'s UHID survived a switch to ${other.name}`).not.toContain(
        fixture.uhid,
      );
    }).toPass({ timeout: 25_000 });
  });
});

/** What the server says about this order's payment, so the badge can be checked against it. */
async function paymentState(page: Page, f: Fixture): Promise<keyof typeof BADGE> {
  const res = await page.request.get(
    `${f.api}/api/v1/billing/order-payments?orderIds=${f.orderId}`,
    {
      headers: {
        authorization: `Bearer ${f.adminToken}`,
        "x-active-branch": f.siteA.id,
      },
    },
  );
  const body = (await res.json()) as { data: Record<string, keyof typeof BADGE> };
  const state = body.data[f.orderId];
  expect(state, "the server would not say whether the test is paid for").toBeTruthy();
  return state!;
}

/** The word the badge shows for each state — `PaymentBadge` in `worklist/page.tsx`. */
const BADGE = {
  paid: "paid",
  unpaid: "unpaid",
  unbilled: "not billed",
  free: "no charge",
} as const;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
