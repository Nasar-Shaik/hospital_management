/**
 * A JOB ID THAT BULLMQ WILL NOT ACCEPT IS A FEATURE THAT NEVER FIRES.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
 * BullMQ builds its Redis keys as `bull:<queue>:<jobId>` and rejects a custom id containing a
 * colon — `Custom Id cannot contain :`. Both callers in this codebase had one:
 *
 *   `reminder:${tenantId}:${appointmentId}`  every day-before appointment reminder, since A6
 *   `push:${notificationId}`                 every staff push, on the day it was written
 *
 * Neither failed visibly. `add()` rejects, and the two call sites are a best-effort wrapper (which
 * logs a warning nobody reads) and a queue consumer (where a throw looks like an ordinary retry),
 * so the observable behaviour of both was a feature that simply never happened. The reminder one
 * survived four months of a green gate.
 *
 * It was found by an M4 test that asserted on the QUEUED JOB instead of on `scheduleTask` having
 * been called — which is the general lesson, and this file is the cheap half of it: the rule now
 * throws where the mistake is MADE, before any environment is consulted, so it fails the same way
 * on a developer's machine as in production.
 */
import { describe, expect, it } from "vitest";
import { scheduleTask } from "./core/events/taskQueue.js";

describe("scheduleTask refuses a job id BullMQ would reject", () => {
  it("throws on a colon, rather than queueing nothing and reporting success", async () => {
    await expect(
      scheduleTask("push.deliver", "tenant-1", {}, { jobId: "push:64b7f000" }),
    ).rejects.toThrow(/contains ":"/);
  });

  /**
   * This suite runs with NO `REDIS_URL`, which is the point: the guard sits before the "no queue"
   * early return, so it fires on a developer's machine with no Redis — exactly the environment
   * the mistake gets written in, and the one where `add()` would never have been reached to
   * complain.
   */
  it("throws on the shape the appointment reminder had, with no queue in sight", async () => {
    await expect(
      scheduleTask("reminder.appointment", "tenant-1", {}, { jobId: "reminder:t:a" }),
    ).rejects.toThrow(/nothing would be scheduled/);
  });

  /** And a supported id passes the guard, reaching the ordinary "no Redis here" answer. */
  it("accepts a hyphenated id", async () => {
    await expect(
      scheduleTask("push.deliver", "tenant-1", {}, { jobId: "push-64b7f000" }),
    ).resolves.toBe(false);
  });
});
