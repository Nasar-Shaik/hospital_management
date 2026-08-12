/**
 * The write side: may I save, how do I save, and what happens after.
 *
 * ── ONE PLACE, BECAUSE EVERY WRITE SCREEN NEEDS THE SAME FOUR THINGS ────────
 * A guard that says whether saving is even worth attempting, a mutation that never auto-retries,
 * invalidation that cannot be forgotten, and an error mapped for a clinician. Left to each screen,
 * the third screen gets three of the four — and the one it misses is invisible until a ward
 * notices the chart is stale.
 */
import { useEffect, useMemo } from "react";
import { Alert } from "react-native";
import { useNavigation } from "expo-router";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useRuntime } from "../providers/RuntimeProvider";
import { useBranch, useConnectivity, useSession } from "./useStores";
import { useClinical } from "./useClinical";
import { clinicalMutations, type ClinicalMutations, type Write } from "../query/mutations";
import { writeGuard, type WriteGuardResult } from "../lib/guard";
import { createIntentKeys, type IntentKeys } from "../lib/idempotency";

/**
 * May this action be attempted, and if not, what does the user have to fix first?
 *
 * `writeGuard` orders the blocks so the reported one is the one to fix FIRST — telling somebody
 * they lack permission when they are also offline sends them to an administrator for nothing.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * Not authorization. The server re-checks every request and is the only thing that decides. This
 * decides whether the request is worth making, and gives a disabled button something to say.
 *
 * ── THE LICENCE IS SERVER-ENFORCED, NOT OBSERVED HERE ───────────────────────
 * `createRuntime` accepts an `onLicenseState` hook and M1 left it unwired, so the phone holds no
 * licence state to guard on. Passing `false` is therefore the honest value rather than an
 * assumption: a lapsed subscription is refused server-side with `HMS-TEN-005`, which the error
 * map already renders as a blocking "an administrator must renew it". The cost of the gap is that
 * the refusal arrives after the tap instead of before it.
 */
export function useWriteGuard(needs?: string): WriteGuardResult {
  const online = useConnectivity((s) => s.online);
  const validated = useBranch((s) => s.validated);
  const activeBranchId = useBranch((s) => s.activeBranchId);
  const permissions = useSession((s) => s.permissions);

  return useMemo(
    () =>
      writeGuard({
        online,
        branchResolved: validated && activeBranchId !== undefined,
        // Every clinical write is stamped with a branch (ADR-0015), so every one of them needs a
        // single site resolved. All-branches mode is a reading posture.
        requiresBranch: true,
        licenceExpired: false,
        ...(needs ? { needs } : {}),
        // The store's own `Set`, passed through — not a copy. `writeGuard` only reads it, and
        // rebuilding one here would allocate on every render for no benefit.
        held: permissions,
      }),
    [online, validated, activeBranchId, needs, permissions],
  );
}

/** The write descriptors, bound to this client and branch. */
export function useClinicalMutations(): ClinicalMutations {
  const runtime = useRuntime();
  const { scope } = useClinical();
  return useMemo(() => clinicalMutations(runtime.api, scope), [runtime.api, scope]);
}

/**
 * Runs one write, then invalidates what it made stale.
 *
 * ── `retry: false`, RESTATED AT THE CALL SITE ───────────────────────────────
 * The query client's default for mutations is already `shouldRetryMutation` — never — and it is
 * repeated here because it is the single most consequential line on this path and it should not
 * take a trip to another file to confirm. A transport that silently re-sends a clinical write is
 * how one order becomes two needles. A retry is a button the user presses.
 */
export function useClinicalWrite<TInput, TResult>(
  write: Write<TInput, TResult>,
  options: { onSuccess?: (result: TResult) => void } = {},
): UseMutationResult<TResult, unknown, TInput> {
  const queryClient = useQueryClient();
  const { onSuccess } = options;

  return useMutation<TResult, unknown, TInput>({
    mutationFn: write.mutationFn,
    retry: false,
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: write.invalidates });
      onSuccess?.(result);
    },
  });
}

/**
 * Idempotency keys for one submission, stable across its retries.
 *
 * Held in a ref-like memo rather than in state: minting a key must not re-render, and the keys
 * must survive the re-renders a failed submission causes. `reset()` after a landed submission is
 * what makes the NEXT basket a new intent rather than a replay of the last one.
 */
export function useIntentKeys(): IntentKeys {
  const keys = useMemo(() => createIntentKeys(), []);
  return keys;
}

/**
 * "You have unsaved changes" — the confirmation before leaving a dirty clinical form.
 *
 * ── WHY `beforeRemove` AND NOT A BANNER ALONE ───────────────────────────────
 * The banner is there too, but it does not help the doctor who swipes back out of habit. This is
 * the React Navigation event that fires for every way out of a screen — the header chevron, the
 * hardware back button, and an edge swipe — which is exactly the set a per-button confirmation
 * would miss.
 *
 * It guards against LOSING work, not against failing to save it: the form state itself lives in
 * the screen and is never cleared on an error, so a save that fails leaves every word the doctor
 * typed on screen and says so.
 */
export function useUnsavedChanges(dirty: boolean, what = "note"): void {
  const navigation = useNavigation();

  useEffect(() => {
    if (!dirty) return undefined;

    /**
     * `e.data.action` is the navigation the user asked for. It is dispatched again from inside the
     * confirmation — that is the documented pattern, and it is why the listener is removed on
     * cleanup rather than guarded by a flag: re-dispatching while still subscribed would fire this
     * handler a second time and trap the user on the screen.
     */
    const onBeforeRemove = (event: {
      preventDefault: () => void;
      data: { action: Readonly<{ type: string }> };
    }): void => {
      event.preventDefault();
      Alert.alert(
        "Discard unsaved changes?",
        `This ${what} has not been saved. Leaving now loses what you have written.`,
        [
          { text: "Keep editing", style: "cancel" },
          {
            text: "Discard",
            style: "destructive",
            onPress: () => {
              navigation.dispatch(event.data.action);
            },
          },
        ],
      );
    };

    navigation.addListener("beforeRemove", onBeforeRemove);
    return () => {
      navigation.removeListener("beforeRemove", onBeforeRemove);
    };
  }, [dirty, what, navigation]);
}
