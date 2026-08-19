/**
 * AN UPSERT ON AN AUDITED COLLECTION MUST ASK FOR THE NEW DOCUMENT.
 *
 * ── THE DEFECT THIS CLOSES, AND WHY A SOURCE TEST ───────────────────────────
 * Risk register **D17**. `auditPlugin`'s query-path post hook used to return whenever the
 * pre-image was missing, so the FIRST write of any document created by an upsert was never
 * audited — the first ED triage of a patient left no row in the trail, while a later re-triage
 * left one. The plugin now tells an insert from a no-op using what the driver reports, which is
 * the only way to do it without a second query that could see a concurrent caller's document.
 *
 * That leaves one obligation on the CALLER, and it is invisible at the call site. Measured on
 * Mongoose 8.13:
 *
 *   findOneAndUpdate + `new: true`  → the document, on insert AND on update
 *   findOneAndUpdate, no `new`      → **null on insert** — the same answer as "nothing matched"
 *   updateOne + upsert              → an UpdateResult carrying `upsertedId` on insert
 *
 * So an audited `findOneAndUpdate` upsert that does not ask for the new document is a silently
 * unauditable create, and it looks exactly like one that is fine. `wallet.repointPatient` was
 * that call — a wallet account created by a patient merge, in a `financial` collection, absent
 * from the financial trail. One missing option, no way to see it by reading the line.
 *
 * A behavioural test cannot cover this: it proves the paths it walks, and the point is the call
 * nobody walks. `auditPlugin.int.test.ts` proves the plugin's semantics; this proves that every
 * caller in the repository is shaped so those semantics can apply.
 *
 * ── SCOPE ───────────────────────────────────────────────────────────────────
 * Only modules that own an audited model. A module whose models carry no `auditPlugin` writes
 * nothing to the trail, so the option buys it nothing and requiring it would be noise. Seeds are
 * excluded for a second, independent reason: they run with no request context, and the plugin
 * records nothing without one.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MODULES = join(__dirname, "modules");

/** Every source file under `src/modules`, tests excluded. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(path);
  }
  return out;
}

/** A module owns an audited model when any file in its folder declares the plugin. */
function auditedModules(): Set<string> {
  const audited = new Set<string>();
  for (const name of readdirSync(MODULES)) {
    const dir = join(MODULES, name);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of walk(dir)) {
      if (readFileSync(file, "utf8").includes("plugin(auditPlugin")) {
        audited.add(name);
        break;
      }
    }
  }
  return audited;
}

/**
 * The options object an `upsert: true` sits in. Deliberately literal: it reads the same braces a
 * reviewer reads, rather than trying to understand the call around them.
 */
function optionsAround(source: string, at: number): string {
  const open = source.lastIndexOf("{", at);
  const close = source.indexOf("}", at);
  if (open === -1 || close === -1) return source.slice(Math.max(0, at - 120), at + 120);
  return source.slice(open, close + 1);
}

describe("an upsert on an audited collection can be seen to have created something", () => {
  it("asks for the new document at every audited call site", () => {
    const audited = auditedModules();
    expect(
      audited.size,
      "no audited modules found — the scan is broken, not the code",
    ).toBeGreaterThan(10);

    const blind: string[] = [];

    for (const name of audited) {
      for (const file of walk(join(MODULES, name))) {
        const source = readFileSync(file, "utf8");
        let at = source.indexOf("upsert: true");
        while (at !== -1) {
          const options = optionsAround(source, at);
          /**
           * `returnDocument: "after"` is the driver spelling of `new: true` and is accepted for
           * the same reason — both make the insert visible in the result.
           */
          const returnsTheNewDocument =
            /\bnew:\s*true\b/.test(options) || /returnDocument:\s*["']after["']/.test(options);
          if (!returnsTheNewDocument) {
            const line = source.slice(0, at).split("\n").length;
            blind.push(
              `${file.slice(file.indexOf("modules"))}:${String(line)} → ${options.replace(/\s+/g, " ")}`,
            );
          }
          at = source.indexOf("upsert: true", at + 1);
        }
      }
    }

    expect(
      blind,
      "These upserts are in a module that writes to the audit trail, and they do not ask for the " +
        "new document. `findOneAndUpdate` returns null when it INSERTS unless `new: true` is set, " +
        "and a null result is indistinguishable from a write that matched nothing — so the " +
        "document's first and only creation would never be audited (risk register D17). Add " +
        "`new: true`. If the collection genuinely is not audited, this scan is wrong and should " +
        "be narrowed rather than the assertion deleted.",
    ).toEqual([]);
  });

  /**
   * The plugin reaches its create path through `createdIdFrom`. If somebody restores the old
   * early return, the behavioural suite goes red — but this states the intent in the file a
   * reader lands in when they wonder why `new: true` is mandatory here and nowhere else.
   */
  it("still reads the created id out of the driver's own result", () => {
    const plugin = readFileSync(join(__dirname, "core", "db", "plugins", "auditPlugin.ts"), "utf8");
    expect(plugin).toMatch(/createdIdFrom/);
    expect(
      plugin,
      "the create path must key its read on the id the driver reported, never on the filter — a " +
        "filter re-read can return a document a concurrent caller inserted",
    ).toMatch(/findById\(created\)/);
  });
});
