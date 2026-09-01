/**
 * The licence, as the app currently believes it (M2 L). Policy lives in `lib/licence.ts`.
 *
 * ── TWO INDEPENDENT FACTS, KEPT INDEPENDENT ─────────────────────────────────
 * The store holds what each of the server's two channels last said, and DERIVES the answer:
 *
 *   `header`   the last `X-License-State` — ACTIVE, EXPIRING or GRACE.
 *   `refused`  whether the last thing we heard was the licence gate saying no (`HMS-TEN-005`).
 *
 * Collapsing them into one field looked simpler for about ten minutes and is a bug. The client
 * reports the header on EVERY response, including error responses — and a refused request carries
 * no licence headers, so the refusal arrives as `null`, which means "perpetual". One field would
 * therefore be written to ACTIVE by the very response that proves the licence has lapsed, with the
 * outcome depending on which of the two callbacks the api-client happens to invoke last.
 *
 * Kept apart, the order cannot matter: nothing the header channel reports can clear a refusal, and
 * only the one thing that genuinely disproves it does.
 *
 * ── WHAT CLEARS A REFUSAL: A REQUEST THAT WORKED ────────────────────────────
 * `served()` is the recovery path, and it is evidence rather than a timer. A hard-expired hospital
 * has no successful responses at all — every request dies in `resolveTenant` — so one that comes
 * back is proof the operator renewed. That is the whole of "the licence changed during a session",
 * and it needs no polling and no dedicated endpoint.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { fromHeader, LICENCE_UNKNOWN, type Licence, type LicenceState } from "../lib/licence";
import type { LicenseHeader } from "@medicore/api-client";

export interface LicenceStoreState {
  /** The last state the header described. Never `EXPIRED` — the header cannot say that. */
  header: Licence;
  /** True once the licence gate has refused a request and nothing has succeeded since. */
  refused: boolean;

  /** A response arrived; this is what its licence headers said (`null` = perpetual / none). */
  observed(header: LicenseHeader | null): void;
  /** The licence gate refused a request (`HMS-TEN-005`). */
  refuse(): void;
  /** A request succeeded, which a hard-expired hospital cannot produce. */
  served(): void;
  /** On sign-out. The next session re-learns from its own responses. */
  reset(): void;
}

export type LicenceStore = StoreApi<LicenceStoreState>;

export function createLicenceStore(): LicenceStore {
  return createStore<LicenceStoreState>((set, get) => ({
    header: LICENCE_UNKNOWN,
    refused: false,

    /**
     * Writes only on a real change. This runs on EVERY response — a ward round is dozens a minute —
     * and `fromHeader` mints a fresh object each time, so an unconditional `set` would hand every
     * subscriber a new snapshot and re-render the banner on each request for no new information.
     */
    observed: (header) => {
      const next = fromHeader(header);
      const current = get().header;
      if (current.state === next.state && current.daysLeft === next.daysLeft) return;
      set({ header: next });
    },
    refuse: () => {
      if (!get().refused) set({ refused: true });
    },
    /**
     * Clears the block and nothing else. The header is left alone deliberately: a renewed hospital
     * is usually EXPIRING or GRACE for a while afterwards, and that warning is still true.
     *
     * Guarded like `observed` — this fires on every successful read, which is the hottest path in
     * the app and almost always a no-op.
     */
    served: () => {
      if (get().refused) set({ refused: false });
    },
    reset: () => set({ header: LICENCE_UNKNOWN, refused: false }),
  }));
}

/**
 * A CONSTANT, not an object built per call — and that is load-bearing rather than tidy.
 *
 * `currentLicence` is passed to `useStore` by reference, which compares snapshots with `Object.is`.
 * A freshly minted `{ state: "EXPIRED", … }` would never equal the previous one, so React would
 * re-render, re-select, get another new object and spin until "Maximum update depth exceeded" — the
 * exact failure `routes.test.ts` scans for, in the one blind spot it admits to: a NAMED selector,
 * which it does not follow.
 */
const EXPIRED: Licence = { state: "EXPIRED", daysLeft: 0 };

/**
 * The one question a screen asks. A refusal outranks whatever the header last said, because it is
 * the more recent and the more consequential of the two.
 */
export function currentLicence(state: LicenceStoreState): Licence {
  return state.refused ? EXPIRED : state.header;
}

/** Convenience for the guard, which cares about one bit of this. */
export function licenceState(state: LicenceStoreState): LicenceState {
  return currentLicence(state).state;
}
