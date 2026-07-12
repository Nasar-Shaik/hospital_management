/** Ambient augmentation: every request carries a traceId (Doc 09 §7/§8). */
declare global {
  namespace Express {
    interface Request {
      traceId: string;
      /**
       * Set by the `authenticate` middleware (ADR-0009); undefined on public
       * routes. Optional by design — a handler that forgets to check it cannot
       * silently treat an anonymous caller as authenticated, because the type
       * forces the question. Use `requireAuth(req)` behind `authenticate()`.
       */
      auth?: {
        userId: string;
        roles: string[];
        branchIds: string[];
        /** Access-token id — used to blocklist it on logout. */
        jti: string;
        /** Access-token expiry (epoch seconds). */
        expiresAt: number;
      };
    }
  }
}

export {};
