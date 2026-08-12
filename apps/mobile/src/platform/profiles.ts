/**
 * The hospitals this device knows about (M0 §6).
 *
 * A list of public hostnames, stored unencrypted on purpose — there is nothing secret in "this
 * phone has been used at Apollo". Each profile owns its own secure-store namespace for its refresh
 * token (`storageKeys`), so signing into a second hospital cannot sign you out of the first.
 */
import { preferences } from "./preferences.js";
import { storageKeys } from "../lib/storage.js";
import type { HospitalProfile } from "../lib/tenant.js";

export async function loadProfiles(): Promise<HospitalProfile[]> {
  const raw = await preferences.get(storageKeys.profiles);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as HospitalProfile[]) : [];
  } catch {
    // Corrupt storage is recoverable by re-entering a hospital code; crashing on launch is not.
    return [];
  }
}

export async function saveProfile(profile: HospitalProfile): Promise<HospitalProfile[]> {
  const existing = await loadProfiles();
  const next = [...existing.filter((p) => p.slug !== profile.slug), profile];
  await preferences.set(storageKeys.profiles, JSON.stringify(next));
  await preferences.set(storageKeys.lastProfile, profile.slug);
  return next;
}

export async function lastUsedProfile(): Promise<HospitalProfile | undefined> {
  const slug = await preferences.get(storageKeys.lastProfile);
  if (!slug) return undefined;
  return (await loadProfiles()).find((p) => p.slug === slug);
}
