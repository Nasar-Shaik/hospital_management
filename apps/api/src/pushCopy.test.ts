/**
 * THE TWO PURE DECISIONS BEHIND A PUSH — who gets one, and what a locked screen may say.
 *
 * Both are pulled out of the delivery path deliberately, because neither could be falsified where
 * it started. `shouldPush` sat on the branch after `markSent`, and the only non-`inapp` template
 * in the product goes out by email — which is `suppressed` on any machine without an SMTP host, so
 * an integration test aimed at the rule was passing for a reason unrelated to it, and would have
 * kept passing with the rule deleted. `copyFor` is a lookup whose FALLBACK is the interesting
 * case, and the fallback is what no realistic fixture exercises.
 */
import { describe, expect, it } from "vitest";
import { copyFor, shouldPush } from "./modules/notifications/index.js";

describe("who earns a push", () => {
  /**
   * `inapp` is the staff channel because only staff have logins. A patient has no app, no login
   * and no device row, so this rule is what keeps them out — by construction, rather than by a
   * check somebody has to remember to write.
   */
  it("pushes an in-app message addressed to a person", () => {
    expect(shouldPush("inapp", "user-1")).toBe(true);
  });

  it("pushes nothing for a channel that is not the staff inbox", () => {
    expect(shouldPush("email", "user-1")).toBe(false);
    expect(shouldPush("sms", "user-1")).toBe(false);
    expect(shouldPush("whatsapp", "user-1")).toBe(false);
  });

  /** An in-app message with no recipient id has nobody's phones to look up. */
  it("pushes nothing when the message names no recipient", () => {
    expect(shouldPush("inapp", undefined)).toBe(false);
    expect(shouldPush("inapp", "")).toBe(false);
  });
});

describe("what a locked screen is allowed to say", () => {
  /**
   * ── THE ASSERTION THAT MATTERS IS AN ABSENCE ──────────────────────────────
   * The in-app subject for this template reads "CRITICAL RESULT — Kamala Devi — Serum Potassium".
   * The obvious implementation pushes it, and the result is a patient's name, their test and a
   * diagnosis-shaped fact displayed by the OS on a handset lying face-up on a desk.
   */
  it("names what happened and never who", () => {
    const critical = copyFor("order.critical");
    expect(critical.title).toBe("Critical result");
    expect(critical.urgent).toBe(true);
    expect(`${critical.title} ${critical.body}`).not.toMatch(/\{\{|patient|uhid/i);
  });

  it("marks only the alert that cannot wait as urgent", () => {
    expect(copyFor("order.result.released").urgent).toBeFalsy();
  });

  /**
   * The failure mode of forgetting to classify a new template must be SILENCE about the patient,
   * not disclosure of one. A fallback that reached for the rendered subject would make every
   * future template a privacy decision nobody noticed they were making.
   */
  it("falls back to a line that could describe any message at all", () => {
    const unknown = copyFor("some.template.nobody.classified");
    expect(unknown.title).toBe("MediCore");
    expect(unknown.body).toBe("You have a new alert.");
    expect(unknown.urgent).toBeFalsy();
  });
});
