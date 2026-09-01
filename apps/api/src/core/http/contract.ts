/**
 * Response contracts — the success half of the API's shape, made real.
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
 * Requests were contractual and responses were not. Every `validate()` call put a Zod schema on
 * the wire shape a client SENDS, and the spec documented all 125 of them. What a client RECEIVES
 * was described nowhere: 265 operations, 0 response schemas. The consequence was not theoretical —
 * the api-client's hand-written response types had silently drifted from the server on eight
 * interfaces before anything noticed, because nothing could notice.
 *
 * The obvious fix — emit `{ success: true, data: object }` — was explicitly rejected. It would
 * claim 265/265 coverage and tell a consumer nothing; a generated client would return `unknown`
 * and be worse than the hand-written types it replaced.
 *
 * ── WHAT IS THE SOURCE OF TRUTH ─────────────────────────────────────────────
 * The application, not the schema. Each module already exposes a canonical DTO — `Patient`,
 * `Invoice`, `Order` — the interface a repository returns and the thing that is actually
 * serialized. Those stay exactly as they are. A contract schema describes the same shape as it
 * appears ON THE WIRE, and `Proves<>` makes tsc reject the pair if they ever disagree:
 *
 *     export const patient = contract("Patient", z.object({ … }));
 *     export type PatientProof = Proves<Matches<typeof patient, Patient>>;
 *                                               └ the schema   └ the DTO the service returns
 *
 * Add a field to `Patient` and the build fails until the schema follows. That is the property that
 * makes this maintainable: the schema cannot drift, because drift is a compile error rather than a
 * discovery made by a mobile app in the field.
 *
 * ── WIRE SHAPE, NOT SERVER SHAPE ────────────────────────────────────────────
 * A DTO holds `Date`; JSON holds a string. `Wire<T>` applies exactly that one transformation, so
 * the schema describes what a client receives while the DTO keeps the type the server works with.
 * Changing the DTOs to strings instead would have been a wide, behavioural refactor of date
 * handling across every module — a real risk taken for a cosmetic gain.
 */
import type { Infer, ZodTypeAny } from "@medicore/validation";

/**
 * Named response schemas, by contract name. Populated as each module's `*.contract.ts` is
 * imported — which happens because its router references it, so there is no second list of
 * schemas to keep in step with the routes.
 */
const registry = new Map<string, ZodTypeAny>();

/**
 * Registers a schema under the name it will carry in `components/schemas`, and returns it
 * unchanged so it reads as a definition rather than a side effect.
 *
 * The name matters beyond documentation: it is what lets the spec say `$ref: Patient` in
 * thirty places instead of inlining the same object thirty times, and it is the handle a
 * generated client would later use as a type name.
 */
export function contract<S extends ZodTypeAny>(name: string, schema: S): S {
  const existing = registry.get(name);
  if (existing && existing !== schema) {
    // Two different shapes under one name would make the spec quietly wrong — whichever
    // registered last would win and the other operations would document a shape they do not send.
    throw new Error(`response contract "${name}" is already registered with a different schema`);
  }
  registry.set(name, schema);
  return schema;
}

/** Every registered contract, name-sorted so the generated spec is byte-stable. */
export function contractRegistry(): Record<string, ZodTypeAny> {
  return Object.fromEntries([...registry.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/* ── the compile-time proof ─────────────────────────────────────────────────── */

/**
 * A DTO as it appears after `JSON.stringify` — `Date` becomes an ISO string, everything else
 * survives unchanged. The one transformation the envelope actually performs.
 */
export type Wire<T> = T extends Date
  ? string
  : T extends (infer U)[]
    ? Wire<U>[]
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

/**
 * Every property made required and wrapped, at every depth.
 *
 * ── WHY PLAIN MUTUAL ASSIGNABILITY IS NOT ENOUGH ────────────────────────────
 * Comparing the shapes directly misses the single most important case. Drop `gstin?: string` from
 * a schema whose DTO has it and both directions still pass — an absent optional property is
 * assignable to one that is present, and vice versa. Falsifying this on the first contract is
 * what surfaced it: inventing a field failed the build, removing an optional one did not.
 *
 * That is the exact class of field that has already drifted here. `branchId?` is optional on nine
 * response types, and it going missing from the client is the defect the previous milestone spent
 * a phase repairing. A check blind to it would be worse than none, because it would look green.
 *
 * So both sides are normalised first: `-?` makes every property required, and the tuple wrapper
 * keeps the `| undefined` that `-?` would otherwise strip — preserving the difference between
 * `x?: string` and `x: string` while making a MISSING property a hard mismatch.
 */
type Deep<T> = T extends object ? { [K in keyof T]-?: [Deep<T[K]>] } : T;

/**
 * Mutual assignability over the normalised shapes, reported against the originals so the failure
 * prints something a person can read.
 *
 * Assignability rather than type identity is deliberate: the identity trick
 * (`<T>() => T extends A ? 1 : 2`) also distinguishes `x?: string` from `x?: string | undefined`,
 * which is a difference Zod's `.optional()` produces and which has no consequence on the wire. It
 * would fail constantly on a distinction nobody can act on.
 */
type Same<A, B> = [Deep<A>] extends [Deep<B>]
  ? [Deep<B>] extends [Deep<A>]
    ? true
    : { contractMismatch: "the DTO has something the schema does not"; schema: A; dto: B }
  : { contractMismatch: "the schema has something the DTO does not"; schema: A; dto: B };

/**
 * What a service function resolves to — for the responses whose shape is written inline at the
 * `return` rather than as a named DTO (`{ survivor, merged }`, `{ removed: true }`).
 *
 * Binding to the function is if anything stronger than binding to an interface: it is the actual
 * return type, so it cannot be a stale declaration that nobody updated.
 */
export type Returns<F extends (...args: never[]) => unknown> = Awaited<ReturnType<F>>;

/**
 * Does this schema describe exactly the DTO the API returns? `true`, or a descriptor naming both
 * shapes. On its own it only computes an answer — `Proves` is what turns a wrong answer into a
 * build failure.
 */
export type Matches<S extends ZodTypeAny, Dto> = Same<Infer<S>, Wire<Dto>>;

/**
 * Compile-time proof that a response contract is accurate:
 *
 *     export type PatientProof = Proves<Matches<typeof patient, Patient>>;
 *
 * Add a field to `Patient` and this line fails until the schema follows, with tsc printing the
 * two shapes side by side.
 *
 * Two names rather than one because a type alias cannot assert about its own parameters: TS
 * checks a generic alias's constraints against UNRESOLVED types and rejects the declaration
 * itself, so the assertion has to happen where the types are concrete — at the use site. Hence
 * `Proves<Matches<…>>` rather than a single `Proves<schema, Dto>`.
 */
export type Proves<T extends true> = T;
