import { describe, expect, it } from "vitest";
import request from "supertest";
import { createLogger } from "@medicore/logger";
import { createApp } from "./app.js";

const app = createApp(createLogger({ service: "api-test", level: "silent" }));

describe("GET /health (liveness)", () => {
  it("returns ok envelope with service metadata", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe("ok");
    expect(res.body.data.service).toBe("api");
  });

  it("echoes/sets x-request-id (traceId contract)", async () => {
    const res = await request(app).get("/health").set("x-request-id", "test-trace-123");
    expect(res.headers["x-request-id"]).toBe("test-trace-123");
  });
});

describe("GET /ready (readiness)", () => {
  it("reports skipped checks when no deps configured", async () => {
    const res = await request(app).get("/ready");
    // With no MONGO_URI/REDIS_URL in test env, deps are skipped → ready.
    expect(res.status).toBe(200);
    expect(res.body.data.checks.mongo).toBe("skipped");
    expect(res.body.data.checks.redis).toBe("skipped");
  });
});

describe("unknown route", () => {
  it("returns the 404 envelope with error code from ERROR_CODES", async () => {
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("HMS-GEN-404");
    expect(res.body.error.traceId).toBeTruthy();
  });
});
