/**
 * Request context via AsyncLocalStorage (Doc 03 §1.2 step 4, Doc 04 §2.1).
 *
 * This is the ONLY channel through which a tenant database connection reaches a
 * repository. There is no global tenant-data connection — a query without a
 * context therefore cannot silently read another tenant's data; it throws.
 *
 * Services are framework-free (Doc 09 §11): they read context from here, never
 * from `req`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Connection } from "mongoose";

export interface RequestContext {
  traceId: string;
  /** Registry id of the host-resolved tenant. */
  tenantId: string;
  tenantSlug: string;
  /** The tenant's dedicated database connection (Connection Manager). */
  connection: Connection;
  /** Populated by `authenticate` (ADR-0009). */
  userId?: string;
  /** The actor's email, from the token — so the audit trail reads as people, not ids. */
  userEmail?: string;
  branchIds?: string[];
  roles?: string[];
  /**
   * Where the request came from. Carried in the context rather than read from
   * `req`, because the audit trail is written by services and repositories that
   * have no access to `req` (Doc 09 §11) — and "who changed this, from where" is
   * one question, not two. Populated by `resolveTenant`.
   */
  ip?: string;
  userAgent?: string;
  /** Populated by `authorize` (ADR-0010) — the caller's effective permissions. */
  permissions?: string[];
  /**
   * The row-scope decision for THIS request, published by `authorize` and applied
   * by repositories via `scopeFilter()`. A middleware sees a route, not a row —
   * so the last layer of authorization has to be handed down to where the query
   * is built.
   */
  scope?: RequestScope;
}

export interface RequestScope {
  /** The permission that admitted this request. */
  permission: string;
  level: "own" | "branch" | "tenant" | "global";
  branchIds: string[];
  userId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with the given context bound for the whole async call tree. */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** Returns the context or undefined — for code that legitimately runs without a tenant (health, platform routes). */
export function tryGetContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Returns the context or throws. Repositories use this: a missing context is a
 * programming error, never a silent fallback to some default database.
 */
export function getContext(): RequestContext {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      "No request context: tenant-scoped code ran outside a tenant-resolved request. " +
        "Repositories must obtain their connection from the request context (Doc 03 §1.2).",
    );
  }
  return ctx;
}

/** Convenience for repositories: the tenant connection for the current request. */
export function getTenantDb(): Connection {
  return getContext().connection;
}
