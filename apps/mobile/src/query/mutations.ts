/**
 * Every clinical WRITE the doctor's screens make — declared here, never inside a screen.
 *
 * Same reasoning as `clinical.ts` one file over, with one addition that only applies to writes:
 * what a mutation INVALIDATES is part of the mutation, not an afterthought at the call site. A
 * screen that saves an order and forgets to invalidate leaves the chart showing a test that is not
 * there, and it is the same screen that then gets a bug report about "the app not refreshing".
 *
 * ── INVALIDATE THE WHOLE BRANCH, NOT A CURATED LIST ─────────────────────────
 * One clinical write ripples further than it looks. Placing an order changes the order list, the
 * encounter's `activeOrderCount`, the patient's timeline and the outstanding-results count on the
 * home screen. Signing a prescription raises a `pharmacy` order — a row in a list nobody on this
 * screen mentioned. Enumerating that fan-out per mutation is a list that will be wrong within two
 * features, and wrong quietly.
 *
 * So a write invalidates everything under `[tenant, branch]`, which is exactly the set of reads
 * that could have been affected by a write in this branch. It costs a few refetches of data the
 * doctor is looking at anyway, and it cannot be incomplete. It is the same trade `onBranchChanged`
 * already makes with `queryClient.clear()`, one notch less aggressive.
 *
 * The patient's allergy list survives on purpose: it is keyed `[tenant, "patient", …]` with no
 * branch segment (it is read hospital-wide), so the prefix does not match it — and nothing in this
 * slice can change it.
 */
import type {
  ApiClient,
  ConsultationNote,
  PlaceOrderResult,
  Prescription,
  PrescriptionLineInput,
  PrescriptionScreening,
  WardNote,
} from "@medicore/api-client";
import type { QueryScope } from "./keys";
import type { ConsultationPatch } from "../clinical/consultation";
import type { OrderRequest } from "../clinical/prescribing";
import { attemptSign, type SignDeps, type SignOutcome } from "../clinical/signing";
import { attemptWardNote, type WardNoteDeps, type WardNoteOutcome } from "../clinical/wardNote";
import {
  attemptDischarge,
  type DischargeDeps,
  type DischargeInput,
  type DischargeOutcome,
} from "../clinical/discharge";

/** A write: what to call, and what it makes stale. */
export interface Write<TInput, TResult> {
  mutationFn: (input: TInput) => Promise<TResult>;
  /** The key prefix to invalidate on success. See the header for why it is this coarse. */
  invalidates: readonly unknown[];
}

export function clinicalMutations(api: ApiClient, scope: QueryScope) {
  /** Everything read in this branch. Partial matching does the rest. */
  const branchPrefix: readonly unknown[] = [scope.tenantSlug, scope.branchId ?? "all"];

  return {
    /**
     * The consultation note. `PUT`, so it is naturally replay-safe: the same body sent twice
     * leaves the same note, and there is no second record to create. That is why it carries no
     * idempotency key — one would protect nothing that the verb does not already protect.
     */
    saveConsultation(encounterId: string): Write<ConsultationPatch, ConsultationNote> {
      return {
        mutationFn: (patch) => api.saveConsultation(encounterId, patch),
        invalidates: branchPrefix,
      };
    },

    /**
     * A basket of tests — one request each, each with its own `Idempotency-Key`.
     *
     * ── SEQUENTIAL, NOT `Promise.all` ───────────────────────────────────────────
     * Three parallel POSTs on a ward's wifi is three chances to half-succeed with no way to say
     * which. Sent one at a time, a failure stops the run with everything before it genuinely
     * placed, and the retry — same keys — replays those and places the rest. `Promise.all` would
     * also reject on the first failure while the others carried on in the background, which is the
     * one shape that makes "what actually happened?" unanswerable.
     */
    placeOrders(): Write<readonly OrderRequest[], PlaceOrderResult[]> {
      return {
        mutationFn: async (requests) => {
          const results: PlaceOrderResult[] = [];
          for (const request of requests) {
            results.push(await api.placeOrder(request.input, request.key));
          }
          return results;
        },
        invalidates: branchPrefix,
      };
    },

    /** The draft. Binds nobody until it is signed — that is the whole two-step. */
    createPrescription(encounterId: string): Write<readonly PrescriptionLineInput[], Prescription> {
      return {
        mutationFn: (lines) => api.createPrescription({ encounterId, lines: [...lines] }),
        invalidates: branchPrefix,
      };
    },

    /** The live safety screen. A READ in every sense except its place in the flow — signs nothing. */
    screen(): Write<string, PrescriptionScreening> {
      return {
        mutationFn: (prescriptionId) => api.screenPrescription(prescriptionId),
        invalidates: branchPrefix,
      };
    },

    /**
     * The signature, through the reconciliation in `clinical/signing.ts`.
     *
     * The mutation resolves with a classified `SignOutcome` rather than rejecting, because "the
     * request failed but the prescription is signed" is a SUCCESS and React Query has no way to
     * express that through a rejection. The screen switches on the outcome; nothing about signing
     * is decided by a `catch` block.
     */
    sign(prescriptionId: string): Write<{ overrideReason?: string }, SignOutcome> {
      const deps: SignDeps = {
        sign: (overrideReason) => api.signPrescription(prescriptionId, overrideReason),
        reload: () => api.getPrescription(prescriptionId),
      };
      return {
        mutationFn: ({ overrideReason }) => attemptSign(deps, overrideReason),
        invalidates: branchPrefix,
      };
    },

    /** Throws away a draft nobody signed — used when a review is abandoned. */
    discard(): Write<string, Prescription> {
      return {
        mutationFn: (prescriptionId) => api.discardPrescription(prescriptionId),
        invalidates: branchPrefix,
      };
    },

    /* ── J, the ward ────────────────────────────────────────────────────────── */

    /**
     * Today's entry on the round — an `Idempotency-Key` AND the reconciliation in
     * `clinical/wardNote.ts`. Both, because they cover different failures.
     *
     * ── WHAT THE KEY FIXES ──────────────────────────────────────────────────────
     * The server now replays the original 201 for a repeated key and writes nothing, so a retry of
     * THIS submission can no longer append a second permanent note. That is the strong guarantee
     * and it belongs on the server, where it holds for every client.
     *
     * ── WHAT THE KEY DOES NOT FIX, AND WHY RECONCILIATION STAYS ─────────────────
     * The key makes a retry safe; it does not tell the DOCTOR what happened. When the response is
     * lost the phone still has no idea whether the note landed, and the honest answer to "is it on
     * the chart?" can only come from the chart. Reconciliation is what turns a dropped connection
     * into "the note is there — nothing was written twice" instead of a failure the doctor
     * responds to by writing it again somewhere else.
     *
     * They also fail differently: a key is scoped to one attempt on one device and expires, while
     * the chart is the record. Deleting either layer would be a regression, and the medico-legal
     * rule is unchanged — never claim a note was saved without evidence.
     *
     * `before` is the notes as the screen had them a moment ago. Passed in rather than fetched
     * here because the whole point is that it predates the attempt.
     */
    addWardNote(
      encounterId: string,
      context: {
        before: readonly WardNote[] | undefined;
        authorId?: string;
        /** Stable across the retries of ONE submission — see `lib/idempotency.ts`. */
        key?: string;
      },
    ): Write<string, WardNoteOutcome> {
      const deps: WardNoteDeps = {
        add: (text) => api.addWardNote(encounterId, text, context.key),
        reload: () => api.listWardNotes(encounterId),
        before: context.before,
        ...(context.authorId ? { authorId: context.authorId } : {}),
      };
      return {
        mutationFn: (text) => attemptWardNote(deps, text),
        invalidates: branchPrefix,
      };
    },

    /**
     * The end of the stay, through the reconciliation in `clinical/discharge.ts`.
     *
     * One call writes the summary AND closes the encounter, so the invalidation is doing real work
     * here: the ward list, the bed board, the patient's visits and the episode timeline are all
     * wrong the instant this succeeds. The branch prefix catches every one of them without anybody
     * having to remember the list.
     */
    discharge(encounterId: string): Write<DischargeInput, DischargeOutcome> {
      const deps: DischargeDeps = {
        discharge: (input) => api.discharge(encounterId, input),
        reload: () => api.getEncounter(encounterId),
        notes: () => api.listWardNotes(encounterId),
      };
      return {
        mutationFn: (input) => attemptDischarge(deps, input),
        invalidates: branchPrefix,
      };
    },
  };
}

export type ClinicalMutations = ReturnType<typeof clinicalMutations>;
