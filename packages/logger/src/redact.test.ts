/**
 * PHI redaction (Constitution §3.2, Doc 09 §8).
 *
 * Each test here corresponds to a way PHI was reaching the log before this shipped, or a piece
 * of operational metadata that must survive redaction. The two are equally load-bearing: a
 * logger that redacts everything is as useless as one that redacts nothing, and the second
 * failure mode is the one that gets the redaction turned off six months later.
 */
import { describe, expect, it } from "vitest";
import { pino } from "pino";
import { LOGGER_OPTIONS, maskIdentifier } from "./redact.js";

/**
 * The production logger configuration, wired to a capture stream so the assertions are on the
 * LINE THAT WOULD BE WRITTEN, not on our intent.
 *
 * `LOGGER_OPTIONS` is the same object `createLogger` spreads, so these tests cannot drift into
 * describing a logger the API does not use — which is the failure mode of every redaction test
 * that builds its own pino instance.
 */
function realLogger() {
  const written: string[] = [];
  const log = pino(
    { base: { service: "redact-test" }, ...LOGGER_OPTIONS },
    {
      write: (s: string) => {
        written.push(s);
      },
    },
  );
  return { log, lines: () => written.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe("PHI never reaches the log", () => {
  it("redacts identity, contact and clinical fields at the top level", () => {
    const { log, lines } = realLogger();
    log.info(
      {
        name: "Ramesh Kumar",
        email: "ramesh@example.com",
        address: "12 MG Road",
        dob: "1978-04-02",
        diagnosis: "Type 2 diabetes mellitus",
        allergen: "penicillin",
      },
      "probe",
    );

    const line = lines()[0]!;
    for (const key of ["name", "email", "address", "dob", "diagnosis", "allergen"]) {
      expect(line[key], `${key} must not appear in a log`).toBe("[REDACTED]");
    }
  });

  it("MASKS phone and UHID rather than deleting them — support must still correlate", () => {
    // Doc 09 §8 asks for `98•••••210`, not removal: two lines about the same patient must
    // still be tie-able together by someone debugging, without identifying anybody.
    const { log, lines } = realLogger();
    log.info({ phone: "9876543210", uhid: "UH000123" }, "probe");

    const line = lines()[0]!;
    expect(line.phone).toBe("98•••••210");
    expect(line.phone).not.toContain("76543");
    expect(line.uhid).toBe("UH•••123");
  });

  it("redacts PHI NESTED below the top level — the case redact paths cannot reach", () => {
    // `*.name` in pino's redact matches one level only: it censors `a.name` and walks past
    // `b.c.name`. This is that exact shape.
    const { log, lines } = realLogger();
    log.info({ outer: { inner: { name: "Ramesh Kumar", phone: "9876543210" } } }, "probe");

    const line = lines()[0]!;
    const outer = line.outer as { inner: Record<string, unknown> };
    expect(outer.inner.name).toBe("[REDACTED]");
    expect(outer.inner.phone).toBe("98•••••210");
  });

  it("collapses anything deeper than the bound, whatever its fields are called", () => {
    // The guarantee that does NOT depend on predicting vocabulary. An accidental
    // `logger.info({ patient })` cannot dump a record even if every key is unknown to us.
    const { log, lines } = realLogger();
    log.info({ a: { b: { c: { unknownPhiField: "Ramesh Kumar" } } } }, "probe");

    expect(JSON.stringify(lines()[0])).not.toContain("Ramesh Kumar");
  });

  it("truncates a long free-text value rather than shipping a clinical note", () => {
    const { log, lines } = realLogger();
    log.info({ someText: "x".repeat(2000) }, "probe");

    const value = lines()[0]!.someText as string;
    expect(value.length).toBeLessThan(600);
    expect(value).toContain("[truncated]");
  });
});

describe("error logging", () => {
  it("drops AppError.details — the duplicate-patient leak", () => {
    // pino's DEFAULT serializer emits every enumerable own property of an Error, and
    // `AppError.details` is a public field. `serializeCandidates` puts a real patient's name,
    // UHID, date of birth and phone in there, so one `logger.error({ err })` on a
    // duplicate-registration refusal wrote all four into the log.
    const { log, lines } = realLogger();
    class AppError extends Error {
      constructor(
        readonly code: string,
        readonly details: unknown,
      ) {
        super("Possible duplicate patient");
        this.name = "AppError";
      }
    }
    const err = new AppError("HMS-PAT-002", {
      candidates: [
        { name: "Ramesh Kumar", uhid: "UH000123", phone: "9876543210", dob: "1978-04-02" },
      ],
    });

    log.error({ err }, "probe");

    const raw = JSON.stringify(lines()[0]);
    expect(raw).not.toContain("Ramesh Kumar");
    expect(raw).not.toContain("9876543210");
    expect(raw).not.toContain("UH000123");
    expect(raw).not.toContain("details");
  });

  it("drops the value MongoDB reports on a duplicate key", () => {
    // E11000 on a unique phone index puts the colliding phone number in `keyValue`.
    const { log, lines } = realLogger();
    const err = Object.assign(new Error("E11000 duplicate key error"), {
      code: 11000,
      keyValue: { "contact.phone": "9876543210" },
    });

    log.error({ err }, "probe");

    const raw = JSON.stringify(lines()[0]);
    expect(raw).not.toContain("9876543210");
    expect(raw).not.toContain("keyValue");
  });

  it("drops the rejected value Mongoose reports on a validation error", () => {
    const { log, lines } = realLogger();
    const err = Object.assign(new Error("patients validation failed"), {
      name: "ValidationError",
      errors: { name: { path: "name", value: "Ramesh Kumar", kind: "required" } },
    });

    log.error({ err }, "probe");
    expect(JSON.stringify(lines()[0])).not.toContain("Ramesh Kumar");
  });

  it("KEEPS the classification an on-call engineer needs", () => {
    // The point of the allow-list is that it is an allow-list, not a blanket. Type, message,
    // error code, HTTP status and stack are what make an error actionable, and they survive.
    const { log, lines } = realLogger();
    const err = Object.assign(new Error("Invoice not found"), {
      name: "AppError",
      code: "HMS-GEN-404",
      httpStatus: 404,
    });

    log.error({ err, traceId: "t-123", invoiceId: "64b7f0000000000000000001" }, "probe");

    const line = lines()[0]!;
    const serialized = line.err as Record<string, unknown>;
    expect(serialized.type).toBe("AppError");
    expect(serialized.message).toBe("Invoice not found");
    expect(serialized.code).toBe("HMS-GEN-404");
    expect(serialized.httpStatus).toBe(404);
    expect(serialized.stack).toContain("Error: Invoice not found");
    // And the operational context around it.
    expect(line.traceId).toBe("t-123");
    expect(line.invoiceId).toBe("64b7f0000000000000000001");
  });
});

describe("operational metadata survives", () => {
  it("keeps the fields Doc 09 §8 makes mandatory, and the request-log fields", () => {
    // A logger that redacts everything gets switched off. These must not be casualties.
    const { log, lines } = realLogger();
    log.info(
      {
        traceId: "trace-1",
        tenant: "apollo",
        tenantId: "64b7f0000000000000000001",
        userId: "64b7f0000000000000000002",
        method: "GET",
        path: "/api/v1/patients/:id",
        status: 200,
        durationMs: 12.4,
        encounterId: "64b7f0000000000000000003",
        count: 7,
      },
      "GET /api/v1/patients/:id 200",
    );

    const line = lines()[0]!;
    expect(line).toMatchObject({
      traceId: "trace-1",
      tenant: "apollo",
      tenantId: "64b7f0000000000000000001",
      userId: "64b7f0000000000000000002",
      method: "GET",
      path: "/api/v1/patients/:id",
      status: 200,
      durationMs: 12.4,
      encounterId: "64b7f0000000000000000003",
      count: 7,
    });
    expect(line.msg).toBe("GET /api/v1/patients/:id 200");
  });

  it("still redacts credentials", () => {
    const { log, lines } = realLogger();
    log.info({ password: "hunter2", token: "eyJhbGciOi", apiKey: "mk_live_x" }, "probe");

    const line = lines()[0]!;
    expect(line.password).toBe("[REDACTED]");
    expect(line.token).toBe("[REDACTED]");
    expect(line.apiKey).toBe("[REDACTED]");
  });
});

describe("maskIdentifier", () => {
  it("produces the shape Doc 09 §8 specifies", () => {
    expect(maskIdentifier("9876543210")).toBe("98•••••210");
  });

  it("hides a short value completely — there is nothing to hide behind", () => {
    expect(maskIdentifier("12345")).toBe("•••••");
  });
});
