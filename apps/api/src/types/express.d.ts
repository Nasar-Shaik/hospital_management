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
      /**
       * Set by `authenticatePlatform` (Doc 02 A1) — an OPERATOR, not a hospital
       * user. A SEPARATE field from `auth` on purpose: the two populations must
       * never be interchangeable, and a route that reads `req.auth` can never
       * accidentally be satisfied by an operator (or the reverse). The type system
       * enforces what the tokens already enforce.
       */
      operator?: {
        id: string;
        email: string;
        roles: ("SUPER_ADMIN" | "SUPPORT")[];
        jti: string;
        expiresAt: number;
      };
    }
  }
}

export {};
