"use client";

/**
 * Operator session (Doc 02 A1).
 *
 * Deliberately simpler than the hospital app's AuthProvider, and deliberately
 * NOT shared with it. The two identity systems have different tokens, different
 * lifetimes, different login endpoints and different consequences — a shared
 * provider with a `mode` flag would be one refactor away from letting a hospital
 * user hold an operator session.
 *
 * The token lives in memory only. An operator token can reach every hospital on
 * the platform, so it must not survive a tab being closed, and it must never be
 * written where another script on the machine could read it (`localStorage` is
 * readable by every script on the origin).
 *
 * There is no silent refresh: an operator session is short (30 minutes) and
 * ending it deliberately is correct for an account this powerful. Log in again.
 */
import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { createApiClient, type ApiClient, type OperatorSession } from "@medicore/api-client";

/**
 * The API lives on the same hostname the console is served from, on the API port
 * — the same rule as the hospital app (a browser cannot set a Host header). In
 * production the gateway routes `/api/*` on the same origin and the port is empty.
 */
function apiBaseUrl(): string {
  const port = process.env.NEXT_PUBLIC_API_PORT;
  if (!port) return "";
  if (typeof window === "undefined") return "";
  return `${window.location.protocol}//${window.location.hostname}:${port}`;
}

interface OperatorContext {
  api: ApiClient;
  operator: OperatorSession["operator"] | null;
  isSuperAdmin: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const Ctx = createContext<OperatorContext | null>(null);

export function OperatorProvider({ children }: { children: ReactNode }) {
  const tokenRef = useRef<string | undefined>(undefined);
  const [operator, setOperator] = useState<OperatorSession["operator"] | null>(null);

  const api = useMemo(
    () =>
      createApiClient({
        baseUrl: apiBaseUrl(),
        getAccessToken: () => tokenRef.current,
        credentials: "omit", // operators use no cookie: the token is memory-only
      }),
    [],
  );

  const value = useMemo<OperatorContext>(
    () => ({
      api,
      operator,
      isSuperAdmin: operator?.roles.includes("SUPER_ADMIN") ?? false,
      async login(email, password) {
        const session = await api.operatorLogin(email, password);
        tokenRef.current = session.accessToken;
        setOperator(session.operator);
      },
      logout() {
        void api.operatorLogout().catch(() => undefined);
        tokenRef.current = undefined;
        setOperator(null);
      },
    }),
    [api, operator],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOperator(): OperatorContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useOperator must be used inside <OperatorProvider>");
  return ctx;
}
