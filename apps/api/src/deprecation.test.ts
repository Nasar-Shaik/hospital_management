/**
 * DEPRECATION / SUNSET — the machinery, and the assertion that it is not yet pointed at anything.
 *
 * Two different claims are tested here and they pull in opposite directions:
 *
 *   1. When an operation IS designated, the headers and the spec both say so, correctly.
 *   2. **No operation is designated today.** `Sunset` is a signal that only means something
 *      while it is rare; spending it on a demonstration teaches every client to ignore it.
 *
 * The second is the one that will catch a real mistake — a `deprecate()` pasted onto a live route
 * during a refactor, or a copied route block that carried the call with it.
 */
import { describe, expect, it } from "vitest";
import express, { Router } from "express";
import request from "supertest";
import { listening } from "./test/appServer.js";
import { createLogger } from "@medicore/logger";
import { deprecate, DEPRECATION_DOC_URL, MIN_SUNSET_WINDOW_DAYS } from "./middleware/deprecate.js";
import { buildOpenApiSpec } from "./core/http/openapi.js";
import { routeInventory } from "./core/http/routeInventory.js";
import { createApp } from "./app.js";
import spec from "../openapi.json" with { type: "json" };

/** A throwaway app carrying one deprecated route — nothing in the product is touched. */
function appWithDeprecatedRoute() {
  const app = express();
  const router = Router();
  router.get(
    "/api/v1/legacy-example",
    deprecate({
      since: "2026-09-01",
      sunset: "2027-09-01",
      replacedBy: "/api/v1/example",
      note: "The replacement carries the same fields plus the branch.",
    }),
    (_req, res) => {
      res.json({ success: true, data: { ok: true } });
    },
  );
  app.use(router);
  return app;
}

describe("a deprecated operation tells the caller, in the response", () => {
  it("sends Deprecation, Sunset and the Link relations", async () => {
    const res = await request(await listening(appWithDeprecatedRoute()))
      .get("/api/v1/legacy-example")
      .expect(200);

    /**
     * RFC 9745: `Deprecation` is a structured-field Item — an integer with an `@` sigil, in
     * seconds. `2026-09-01T00:00:00Z` is 1788220800. Asserted as the exact value rather than a
     * loose regex, because "some number" would pass with the wrong date, and the wrong date is
     * the failure a client acts on.
     */
    expect(res.headers.deprecation).toBe("@1788220800");
    // RFC 8594: `Sunset` is an HTTP-date, not an epoch. Two adjacent headers, two formats — an
    // inconsistency in the standards that a hand-written client will get wrong if we do.
    expect(res.headers.sunset).toBe("Wed, 01 Sep 2027 00:00:00 GMT");
    expect(res.headers.link).toContain(`<${DEPRECATION_DOC_URL}>; rel="deprecation"`);
    expect(res.headers.link).toContain("<https://docs.paperlesstech.in/api/deprecations>");
    expect(res.headers.link).toContain('rel="successor-version"');
  });

  it("appends to Link rather than replacing what another middleware set", async () => {
    const app = express();
    const router = Router();
    router.get(
      "/api/v1/paged-legacy",
      (_req, res, next) => {
        res.setHeader("Link", '</api/v1/paged-legacy?page=2>; rel="next"');
        next();
      },
      deprecate({ since: "2026-09-01", sunset: "2027-09-01" }),
      (_req, res) => {
        res.json({ success: true, data: [] });
      },
    );
    app.use(router);

    const res = await request(await listening(app))
      .get("/api/v1/paged-legacy")
      .expect(200);
    // Both relations survive. Assigning would have deleted pagination from a list endpoint —
    // silently, and only on the endpoints that were being retired.
    expect(res.headers.link).toContain('rel="next"');
    expect(res.headers.link).toContain('rel="deprecation"');
  });

  it("refuses a sunset window shorter than the promised twelve months", () => {
    /**
     * Doc 04 §5.1 promises a 12-month minimum. Thrown while the ROUTER IS BUILT, so a too-short
     * window stops the server rather than reaching the client it would hurt — the mobile build in
     * the field that cannot be patched inside the window.
     */
    expect(() => deprecate({ since: "2026-09-01", sunset: "2027-01-01" })).toThrow(
      new RegExp(String(MIN_SUNSET_WINDOW_DAYS)),
    );
    expect(() => deprecate({ since: "2026-09-01", sunset: "2027-09-01" })).not.toThrow();
  });

  it("refuses a date it cannot parse rather than emitting a header of NaN", () => {
    expect(() => deprecate({ since: "01-09-2026", sunset: "01-09-2027" })).toThrow(/YYYY-MM-DD/);
    expect(() => deprecate({ since: "2026-02-30", sunset: "2027-09-01" })).toThrow(
      /not a real date/,
    );
  });
});

describe("the spec and the wire come from one declaration", () => {
  it("marks the operation deprecated and says until when", () => {
    const document = buildOpenApiSpec(routeInventory(appWithDeprecatedRoute())) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    const operation = document.paths["/api/v1/legacy-example"]?.get;

    expect(operation?.deprecated).toBe(true);
    // OpenAPI 3.1 offers a boolean and nothing else. "Deprecated" without "until when" cannot be
    // acted on by anyone holding a release plan, so the date rides as an extension.
    expect(operation?.["x-sunset"]).toBe("2027-09-01");
    expect(operation?.["x-deprecated-since"]).toBe("2026-09-01");
    expect(operation?.["x-replaced-by"]).toBe("/api/v1/example");
    expect(String(operation?.description)).toContain("stops answering 2027-09-01");
  });
});

describe("nothing in the product is deprecated", () => {
  it("no shipped route carries the headers", async () => {
    const app = createApp(createLogger({ service: "deprecation-test" }));
    const deprecated = routeInventory(app).filter((r) => r.deprecation);

    /**
     * The assertion that earns this file. `Sunset` is read by machines, and a client that has
     * seen it on an endpoint that was never actually retired learns to ignore it — so the signal
     * is spent before the day it matters.
     *
     * When an endpoint IS genuinely retired, this test is the place that records the decision:
     * name it here with the reason, and the list stops being empty on purpose rather than by
     * accident.
     */
    expect(deprecated.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  it("the committed spec marks no operation deprecated", () => {
    const flagged: string[] = [];
    for (const [path, operations] of Object.entries(spec.paths as Record<string, unknown>)) {
      for (const [method, operation] of Object.entries(operations as Record<string, unknown>)) {
        if ((operation as { deprecated?: boolean }).deprecated) {
          flagged.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    // Belt and braces with the route-inventory check above: that one reads the live app, this one
    // reads the artefact integrators actually download. They can only disagree if generation is
    // broken, which is itself worth knowing.
    expect(flagged).toEqual([]);
  });
});
