/**
 * The hospitals this device knows about (M0 §6).
 *
 * A list of public hostnames, stored unencrypted on purpose — there is nothing secret in "this
 * phone has been used at Apollo". Each profile owns its own secure-store namespace for its refresh
 * token (`storageKeys`), so signing into a second hospital cannot sign you out of the first.
 *
 * ── ONLY THE SLUG IS STORED; THE URL IS DERIVED ─────────────────────────────
 * `baseUrl` is a FUNCTION of the slug and the build profile, so persisting it stores an answer that
 * can go out of date while the question has not. Two consequences, one of each kind:
 *
 *   * It goes stale. A profile saved when the build resolved `localhost:4000` keeps pointing there
 *     after the build's domain changes — so a developer switching to a LAN-reachable domain, or a
 *     platform that ever moves domain, gets an install that cannot be repaired from inside the app.
 *     Every existing device would need its data cleared.
 *
 *   * It is attacker-influenced. This list lives in AsyncStorage, which is unencrypted and readable
 *     on a rooted device. Trusting a `baseUrl` from disk means an edited file can point the app —
 *     and the credentials typed into it — at any host. Deriving it means the worst a tampered entry
 *     can do is name a different SLUG, which still resolves through the build's own domain and
 *     still has to exist.
 *
 * So what lands on disk is identity, and `hydrate` rebuilds the rest from the current build.
 */
import { preferences } from "./preferences";
import { appConfig } from "./config";
import { storageKeys } from "../lib/storage";
import {
  hydrateProfile,
  toStoredProfile,
  type HospitalProfile,
  type StoredProfile,
} from "../lib/tenant";

/** This build's domain and transport rule — the inputs a stored slug is re-resolved against. */
const resolveAgainst = {
  tenantDomain: appConfig.tenantDomain,
  insecureTransportAllowed: appConfig.insecureTransportAllowed,
};

export async function loadProfiles(): Promise<HospitalProfile[]> {
  const raw = await preferences.get(storageKeys.profiles);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return (parsed as StoredProfile[])
      .map((stored) => hydrateProfile(stored, resolveAgainst))
      .filter((p): p is HospitalProfile => p !== undefined);
  } catch {
    // Corrupt storage is recoverable by re-entering a hospital code; crashing on launch is not.
    return [];
  }
}

export async function saveProfile(profile: HospitalProfile): Promise<HospitalProfile[]> {
  const existing = await loadProfiles();
  const next = [...existing.filter((p) => p.slug !== profile.slug), profile];
  await preferences.set(storageKeys.profiles, JSON.stringify(next.map(toStoredProfile)));
  await preferences.set(storageKeys.lastProfile, profile.slug);
  return next;
}

export async function lastUsedProfile(): Promise<HospitalProfile | undefined> {
  const slug = await preferences.get(storageKeys.lastProfile);
  if (!slug) return undefined;
  return (await loadProfiles()).find((p) => p.slug === slug);
}
