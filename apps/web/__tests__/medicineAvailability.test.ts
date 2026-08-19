import { describe, expect, it } from "vitest";
import { ApiClient } from "@medicore/api-client";

/**
 * THE PRESCRIBING PAD'S STOCK LOOKUP MUST SURVIVE A REAL FORMULARY.
 *
 * ── WHAT DEFECT THIS CATCHES ────────────────────────────────────────────────
 * Found by Stage A manual validation on 2026-08-19, in a browser, on the demo hospital.
 *
 * `GET /medicines/availability` takes ONE comma-separated `codes` parameter and the API caps it at
 * 2,000 characters (`availabilityQuerySchema`). The pad asks about every drug it is showing, and
 * an unfiltered pad shows the entire formulary — so past roughly 100–150 codes the request became
 * a 400. The pad swallows that error deliberately (an inventory lookup must never raise a banner
 * over a prescribing screen), so nothing appeared on screen at all: the stock column just went
 * quiet, permanently, for every drug. A silent failure with a size threshold is invisible to every
 * fixture we own, because every fixture has a small formulary.
 *
 * The claim asserted here is behavioural, not textual: however many drugs are asked about, no
 * single request exceeds what the server will accept, and every drug is asked about exactly once.
 */

/** The server's own bound, restated here so this test fails if the client outgrows it again. */
const SERVER_CAP = 2_000;

interface Asked {
  url: string;
  codes: string[];
}

function client(): { api: ApiClient; asked: Asked[] } {
  const asked: Asked[] = [];
  const fetchImpl = (async (url: string | URL): Promise<Response> => {
    const raw = new URL(String(url)).searchParams.get("codes") ?? "";
    const codes = raw.split(",").filter(Boolean);
    asked.push({ url: String(url), codes });

    // The real endpoint refuses an over-long parameter rather than truncating it. Refusing here
    // too means a regression fails as a REJECTED REQUEST, the way it does in production.
    if (raw.length > SERVER_CAP) {
      return new Response(
        JSON.stringify({ success: false, error: { code: "HMS-VAL-001", message: "too long" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({
        success: true,
        data: codes.map((code) => ({ code, units: 7, batched: true })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  return { api: new ApiClient({ baseUrl: "http://api.test", fetchImpl }), asked };
}

/** Realistic length: `DRUG_PARACETAMOL_500_TAB` is 24 characters, and E2E codes are longer. */
const formulary = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `DRUG_LONG_FORMULARY_CODE_${String(i).padStart(4, "0")}`);

describe("the prescribing pad's stock lookup", () => {
  it("answers for a formulary far larger than one URL can carry", async () => {
    const { api, asked } = client();
    const codes = formulary(300);

    const rows = await api.medicineAvailability(codes);

    expect(rows.map((r) => r.code).sort()).toEqual([...codes].sort());
    expect(asked.length, "300 codes should not have fitted in a single request").toBeGreaterThan(1);
  });

  it("never sends a `codes` parameter the server would refuse", async () => {
    const { api, asked } = client();
    await api.medicineAvailability(formulary(500));

    for (const request of asked) {
      expect(
        request.codes.join(",").length,
        `a request carried ${String(request.codes.join(",").length)} characters of codes; the ` +
          `API caps it at ${String(SERVER_CAP)} and answers 400`,
      ).toBeLessThanOrEqual(SERVER_CAP);
    }
  });

  it("asks about every drug exactly once — no gaps at the seams, no duplicates", async () => {
    const { api, asked } = client();
    const codes = formulary(257); // deliberately not a round number of batches
    await api.medicineAvailability(codes);

    const sent = asked.flatMap((r) => r.codes);
    expect(sent.length, "a code was dropped or asked about twice").toBe(codes.length);
    expect([...new Set(sent)].sort()).toEqual([...codes].sort());
  });

  /** One short list is still one request — the split must not cost anything in the normal case. */
  it("still uses a single request for an ordinary pad", async () => {
    const { api, asked } = client();
    await api.medicineAvailability(["PARA500", "AMOX500", "IBU400"]);
    expect(asked).toHaveLength(1);
  });

  it("asks nothing at all when there is nothing to ask about", async () => {
    const { api, asked } = client();
    expect(await api.medicineAvailability([])).toEqual([]);
    expect(asked).toHaveLength(0);
  });
});
