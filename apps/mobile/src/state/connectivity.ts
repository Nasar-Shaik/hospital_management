/**
 * Connectivity, measured where it actually matters (M0 §11).
 *
 * ── NOT "IS THE RADIO UP" ───────────────────────────────────────────────────
 * A phone can be firmly connected to hospital wifi that has no route to the API — a captive
 * portal, a VPN that dropped, a server that is down. `NetInfo` would report "connected" through
 * all three, and the write button would stay enabled while nothing could be saved.
 *
 * So the signal is taken from the transport itself: a request that came back means reachable, a
 * request whose `fetch` rejected means not. It is derived from the one event that answers the
 * question the UI is really asking — "if I press save, will it arrive?" — and it needs no native
 * module, which is also why it can be tested.
 *
 * The obvious cost is that it is LAGGING: the app only learns it is offline by trying. That is
 * acceptable because the write guard's job is to explain a failure the user is about to see
 * anyway, and every screen refetches on mount.
 */
import { createStore, type StoreApi } from "zustand/vanilla";

export interface ConnectivityState {
  online: boolean;
  /** When the last transport failure happened — drives "last updated HH:MM" banners. */
  lastFailureAt?: number;
  lastSuccessAt?: number;
  reachable(at: number): void;
  unreachable(at: number): void;
}

export type ConnectivityStore = StoreApi<ConnectivityState>;

export function createConnectivityStore(): ConnectivityStore {
  return createStore<ConnectivityState>((set) => ({
    // Optimistic until proven otherwise: assuming offline at launch would disable every button on
    // a working phone for as long as the first request takes.
    online: true,
    reachable: (at) => set({ online: true, lastSuccessAt: at }),
    unreachable: (at) => set({ online: false, lastFailureAt: at }),
  }));
}
