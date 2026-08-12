/**
 * Which hospital this device is pointed at (M0 §6).
 *
 * Held above the runtime because it decides which runtime exists. Loading it is the first thing
 * the app does, before any navigation, so that a returning user goes straight to their hospital's
 * login rather than being asked for a code they entered months ago.
 */
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { HospitalProfile } from "../lib/tenant.js";
import { lastUsedProfile, loadProfiles, saveProfile } from "../platform/profiles.js";

interface ProfileContextValue {
  profile?: HospitalProfile;
  known: HospitalProfile[];
  /** Adds (or updates) a hospital and makes it current. */
  choose(profile: HospitalProfile): Promise<void>;
  /** Leaves the current hospital — used by "switch hospital", never by sign-out. */
  clear(): void;
  ready: boolean;
}

const ProfileContext = createContext<ProfileContextValue | undefined>(undefined);

export function ProfileProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [profile, setProfile] = useState<HospitalProfile | undefined>(undefined);
  const [known, setKnown] = useState<HospitalProfile[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void (async () => {
      const [last, all] = await Promise.all([lastUsedProfile(), loadProfiles()]);
      setProfile(last);
      setKnown(all);
      setReady(true);
    })();
  }, []);

  const choose = useCallback(async (next: HospitalProfile) => {
    setKnown(await saveProfile(next));
    setProfile(next);
  }, []);

  const clear = useCallback(() => setProfile(undefined), []);

  return (
    <ProfileContext.Provider value={{ profile, known, choose, clear, ready }}>
      {children}
    </ProfileContext.Provider>
  );
}

export function useProfile(): ProfileContextValue {
  const value = useContext(ProfileContext);
  if (!value) throw new Error("useProfile must be used inside ProfileProvider");
  return value;
}
