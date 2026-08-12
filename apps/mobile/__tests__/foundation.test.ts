/**
 * The rest of the foundation: tenant resolution, query keys, timezones, lifecycle and logging.
 *
 * These are small pure functions, which is exactly why they are worth testing — each one encodes a
 * decision that is invisible at the call site and expensive to get wrong once fifty screens depend
 * on it.
 */
import { describe, expect, it } from "vitest";
import { createProfile, resolveBaseUrl, validateSlug } from "../src/lib/tenant";
import { AGGREGATE, queryKeys, scoped } from "../src/query/keys";
import {
  displayZone,
  formatDateTime,
  formatTime,
  isValidZone,
  parseInstant,
} from "../src/lib/time";
import {
  LOCK_AFTER_MS,
  SHORT_ABSENCE_MS,
  actionsOnPhase,
  actionsOnResume,
} from "../src/lib/lifecycle";
import { createLogger, templatePath, type LogContext, type LogLevel } from "../src/lib/log";

const PROD = { tenantDomain: "paperlesstech.in", insecureTransportAllowed: false };
const DEV = { tenantDomain: "localhost:4000", insecureTransportAllowed: true };

describe("the hospital is a URL, and a production build cannot be talked out of HTTPS", () => {
  it("builds the subdomain the API resolves tenants from", () => {
    expect(resolveBaseUrl("apollo", PROD)).toBe("https://apollo.paperlesstech.in");
    expect(createProfile("  Apollo  ", PROD).slug).toBe("apollo");
  });

  it("only development may produce plain HTTP", () => {
    expect(resolveBaseUrl("apollo", DEV)).toBe("http://apollo.localhost:4000");
    expect(resolveBaseUrl("apollo", PROD).startsWith("https://")).toBe(true);
  });

  it("refuses a slug that is not a DNS label", () => {
    expect(validateSlug("")).toBe("empty");
    expect(validateSlug("Apollo Hospital")).toBe("format");
    expect(validateSlug("-apollo")).toBe("format");
    expect(validateSlug("apollo-")).toBe("format");
    expect(validateSlug("apollo.paperlesstech.in")).toBe("format");
    expect(validateSlug("apollo")).toBeUndefined();
    expect(validateSlug("apollo-hyd-2")).toBeUndefined();
  });

  it("refuses the platform's own hostnames", () => {
    /**
     * `admin.paperlesstech.in` is the operator console. Typing `admin` should say so offline
     * rather than producing a login screen pointed at the control plane. The server refuses too —
     * this is a typo guard with a useful message, not the authorization.
     */
    expect(validateSlug("admin")).toBe("reserved");
    expect(validateSlug("api")).toBe("reserved");
  });
});

describe("every branch-sensitive query key carries the branch", () => {
  it("prefixes tenant and branch, in that order", () => {
    expect(scoped({ tenantSlug: "apollo", branchId: "b1" }, "patients")).toEqual([
      "apollo",
      "b1",
      "patients",
    ]);
  });

  it("uses a stable sentinel for aggregate mode rather than a hole in the key", () => {
    /**
     * `undefined` in the middle of a key collapses, so `["apollo", undefined, "patients"]` could
     * collide with `["apollo", "patients"]`. A literal is also what the API calls the mode.
     */
    expect(scoped({ tenantSlug: "apollo" }, "patients")).toEqual(["apollo", AGGREGATE, "patients"]);
  });

  it("keeps identity and the branch LIST out of the branch scope", () => {
    // Who you are does not change when you walk between sites, and the list of branches cannot be
    // scoped by the choice it is used to make.
    expect(queryKeys.me("apollo")).toEqual(["apollo", "auth", "me"]);
    expect(queryKeys.myBranches("apollo")).toEqual(["apollo", "me", "branches"]);
  });
});

describe("times render in the branch's zone, and a bad zone cannot crash a ward list", () => {
  const at = new Date("2026-08-12T03:30:00.000Z"); // 09:00 in Asia/Kolkata

  it("formats in the zone it is given, not the process zone", () => {
    expect(formatTime(at, { zone: "Asia/Kolkata", labelled: false })).toBe("09:00");
    expect(formatTime(at, { zone: "UTC", labelled: false })).toBe("03:30");
    expect(formatDateTime(at, "Asia/Kolkata")).toMatch(/^12 Aug 2026, 09:00/);
  });

  it("rejects the values `Branch.timezone` actually accepts today", () => {
    /**
     * The field is documented as IANA and validated as any 64-character string (backend item E),
     * so every one of these is storable right now.
     *
     * Note WHY each is rejected, because the naive check gets them wrong in both directions:
     * `Intl` happily ACCEPTS `IST`, `EST`, `GMT` and `+05:30` and silently resolves them (`EST`
     * becomes `America/Panama`, which never observes DST), while `supportedValuesOf` would reject
     * `Asia/Kolkata` because its list carries the legacy `Asia/Calcutta` instead.
     */
    expect(isValidZone("IST")).toBe(false);
    expect(isValidZone("EST")).toBe(false);
    expect(isValidZone("GMT")).toBe(false);
    expect(isValidZone("+05:30")).toBe(false);
    expect(isValidZone("Asia/Kolkatta")).toBe(false);
    expect(isValidZone(undefined)).toBe(false);
    expect(isValidZone("")).toBe(false);

    // Real zones, including the modern spelling and a three-part name.
    expect(isValidZone("Asia/Kolkata")).toBe(true);
    expect(isValidZone("Asia/Calcutta")).toBe(true);
    expect(isValidZone("America/Argentina/Buenos_Aires")).toBe(true);
    expect(isValidZone("Etc/GMT+5")).toBe(true);
    // The one legitimate name with no slash.
    expect(isValidZone("UTC")).toBe(true);
  });

  it("falls back down the chain rather than to the device", () => {
    expect(displayZone("Europe/London", "Asia/Kolkata")).toBe("Europe/London");
    expect(displayZone("IST", "Europe/London")).toBe("Europe/London");
    expect(displayZone(undefined, undefined)).toBe("Asia/Kolkata");
    // A branch with a typo must not silently start rendering in the reader's own zone.
    expect(() => formatTime(at, { zone: displayZone("IST") })).not.toThrow();
  });

  it("returns undefined for an unparseable instant instead of an Invalid Date", () => {
    expect(parseInstant("2026-08-12T03:30:00.000Z")?.toISOString()).toBe(
      "2026-08-12T03:30:00.000Z",
    );
    expect(parseInstant("not a date")).toBeUndefined();
    expect(parseInstant(null)).toBeUndefined();
  });
});

describe("the app in a pocket", () => {
  it("raises the overlay on INACTIVE, before the OS takes its snapshot", () => {
    /**
     * The ordering is the whole control. By the time `background` fires, the picture of the last
     * frame — a patient record — has already been taken and is in the app switcher.
     */
    expect(actionsOnPhase("inactive").showOverlay).toBe(true);
    expect(actionsOnPhase("active").showOverlay).toBe(false);
  });

  it("stops polling in the background but lets a mutation finish", () => {
    const backgrounded = actionsOnPhase("background");
    expect(backgrounded.stopPolling).toBe(true);
    // Cancelling a payment mid-flight creates exactly the ambiguity Idempotency-Key resolves.
    expect(backgrounded.cancelInFlightMutations).toBe(false);
  });

  it("does not re-authenticate a nurse who glanced at a message", () => {
    const brief = actionsOnResume(60_000);
    expect(brief.requireUnlock).toBe(false);
    expect(brief.revalidateSession).toBe(false);
    // But it still refetches — a list read four minutes ago is not obviously right either.
    expect(brief.refetchActive).toBe(true);
  });

  it("re-reads identity and branches after a long absence", () => {
    const long = actionsOnResume(SHORT_ABSENCE_MS);
    expect(long.revalidateSession).toBe(true);
    expect(long.revalidateBranches).toBe(true);
    expect(actionsOnResume(LOCK_AFTER_MS).requireUnlock).toBe(true);
  });
});

describe("the logger cannot be handed a patient", () => {
  it("templates ids out of a route, which is what makes routes loggable at all", () => {
    expect(templatePath("/patients/6a7b838d7e408ede018482c9/orders/507f1f77bcf86cd799439011")).toBe(
      "/patients/[id]/orders/[id]",
    );
    expect(templatePath("/me/branches")).toBe("/me/branches");
  });

  it("drops debug and info in a release build, and keeps warnings", () => {
    const lines: { level: LogLevel; message: string; context?: LogContext }[] = [];
    const log = createLogger({
      verbose: false,
      sink: (level, message, context) =>
        lines.push({ level, message, ...(context ? { context } : {}) }),
    });

    log.debug("noisy");
    log.info("routine");
    log.warn("worth knowing", { traceId: "t1" });
    log.error("broken");

    expect(lines.map((l) => l.level)).toEqual(["warn", "error"]);
    expect(lines[0]?.context).toEqual({ traceId: "t1" });
  });
});
