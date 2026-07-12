/** Ambient augmentation: every request carries a traceId (Doc 09 §7/§8). */
declare global {
  namespace Express {
    interface Request {
      traceId: string;
    }
  }
}

export {};
