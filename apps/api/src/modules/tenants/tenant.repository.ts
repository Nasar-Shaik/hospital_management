/**
 * Tenant registry repository — the ONLY place tenant registry documents are read
 * or written (Doc 09 §10). Lookups are read-through cached (CACHE_STRATEGY).
 */
import type { FilterQuery } from "mongoose";
import {
  resolveEncounterPolicy,
  type EncounterPolicy,
  type OrganizationType,
} from "@medicore/permissions";
import { cacheDel, cacheGet, cacheKeys, cacheSet } from "../../core/redis/redis.js";
import { env } from "../../config/env.js";
import {
  getTenantModel,
  SERVABLE_TENANT_STATUSES,
  type TenantDoc,
  type TenantLicense,
  type TenantStatus,
} from "./tenant.model.js";
import { computeGraceUntil } from "./license.js";

/** Plain, cacheable projection of a registry entry — what resolution needs. */
export interface TenantRegistryEntry {
  id: string;
  hospitalName: string;
  slug: string;
  databaseName: string;
  dbUri?: string;
  customDomain?: string;
  status: TenantStatus;
  region?: string;
  /**
   * The edition this hospital bought (Doc 07). Entitlements resolve their flag
   * baseline from it (ADR-0010 layer 1), so it rides along on the cached entry
   * rather than costing a second master lookup on the hot path.
   */
  planCode?: string;
  /**
   * What kind of hospital this is (ADR-0013 §6). Rides on the cached registry entry
   * because the effective encounter policy is resolved on the hot path (every
   * encounter created), and a second master lookup per patient arrival is not free.
   *
   * DESCRIPTIVE ONLY. Nothing branches on it — callers resolve the POLICY.
   */
  organizationType?: OrganizationType;
  /** This hospital's deliberate deviations from its preset. Never a preset snapshot. */
  encounterPolicy?: Partial<EncounterPolicy>;
  /** Platform-set cap on how many branches this tenant may create (ADR-0015). Absent ⇒ 1. */
  maxBranches?: number;
  /**
   * Licence expiry denormalised as epoch milliseconds (ADR-0016), so the request gate
   * (`resolveTenant`) decides with a single integer compare on the hot path — no master
   * round-trip, and expiry fires to the second. Absent ⇒ perpetual (never expires).
   */
  licenseExpiresAt?: number;
  /** `expiresAt + graceDays` in epoch ms — the instant access is actually cut. */
  licenseGraceUntil?: number;
}

/**
 * The encounter policy actually in force for a hospital: its preset, plus whatever
 * it has deliberately changed (ADR-0013 §5).
 *
 * This is how a caller asks "does this hospital charge?" — `policy.billingMode`,
 * never `organizationType`. A government hospital that opens a paid private ward
 * changes one override; under a type branch it would need a code change.
 */
export function policyOf(tenant: TenantRegistryEntry): EncounterPolicy {
  return resolveEncounterPolicy(tenant.organizationType, tenant.encounterPolicy);
}

function toEntry(doc: TenantDoc): TenantRegistryEntry {
  const expiresAt = doc.license?.expiresAt ? new Date(doc.license.expiresAt) : null;
  const graceUntil = computeGraceUntil(expiresAt, doc.license?.graceDays);
  return {
    id: doc._id.toString(),
    hospitalName: doc.hospitalName,
    slug: doc.slug,
    databaseName: doc.databaseName,
    ...(doc.dbUri ? { dbUri: doc.dbUri } : {}),
    ...(doc.customDomain ? { customDomain: doc.customDomain } : {}),
    status: doc.status,
    ...(doc.region ? { region: doc.region } : {}),
    ...(doc.subscription?.planCode ? { planCode: doc.subscription.planCode } : {}),
    ...(doc.organizationType ? { organizationType: doc.organizationType } : {}),
    ...(doc.encounterPolicy ? { encounterPolicy: doc.encounterPolicy } : {}),
    ...(typeof doc.limits?.maxBranches === "number" ? { maxBranches: doc.limits.maxBranches } : {}),
    ...(expiresAt ? { licenseExpiresAt: expiresAt.getTime() } : {}),
    ...(graceUntil ? { licenseGraceUntil: graceUntil.getTime() } : {}),
  };
}

async function findOne(filter: FilterQuery<TenantDoc>): Promise<TenantRegistryEntry | undefined> {
  const Tenant = await getTenantModel();
  const doc = await Tenant.findOne(filter).lean<TenantDoc>().exec();
  return doc ? toEntry(doc) : undefined;
}

/**
 * Every hospital whose database may legitimately be opened right now.
 *
 * Read straight from the master, never from cache: the fleet loops that use this
 * (the outbox relay, the audit anchor job, the migration runner) walk *all*
 * tenants, and a stale registry there means a hospital silently stops being
 * processed — the kind of failure nobody notices until an auditor does.
 */
export async function listServable(): Promise<TenantRegistryEntry[]> {
  const Tenant = await getTenantModel();
  const docs = await Tenant.find({ status: { $in: SERVABLE_TENANT_STATUSES } })
    .lean<TenantDoc[]>()
    .exec();
  return docs.map(toEntry);
}

/**
 * ── NEGATIVE CACHING: WHY A MISS IS WORTH REMEMBERING ────────────────────────
 *
 * The obvious read-through caches only what it FINDS. That leaves every request
 * to an unknown host as an uncached query against the MASTER registry — the single
 * database that routes every hospital on the platform.
 *
 * We publish wildcard DNS (`*.paperlesstech.in`), which means a stranger can spray
 * `a1.paperlesstech.in`, `a2.…`, `a3.…` and each one costs us a master-DB lookup.
 * Degrade the master registry and NOBODY can reach ANY hospital: it is the one
 * component whose failure is platform-wide. Remembering "this host does not exist"
 * makes that flood free to serve.
 *
 * The marker is a distinct shape rather than a cached `undefined`, because Redis
 * cannot store "I looked and there was nothing" any other way — and a cache that
 * cannot distinguish "not cached" from "cached as absent" would simply never cache
 * the miss.
 */
interface AbsentMarker {
  absent: true;
}
const ABSENT: AbsentMarker = { absent: true };

function isAbsent(value: TenantRegistryEntry | AbsentMarker): value is AbsentMarker {
  return (value as AbsentMarker).absent === true;
}

async function remember(
  key: string,
  entry: TenantRegistryEntry | undefined,
): Promise<TenantRegistryEntry | undefined> {
  await cacheSet(
    key,
    entry ?? ABSENT,
    // A miss is remembered for far less time than a hit. The cost of being wrong is
    // asymmetric: a stale hit serves an old plan code for 5 minutes; a stale MISS
    // 404s a hospital that exists. `create()` busts the key regardless — this TTL
    // is the safety net for anything that writes the registry without telling us.
    entry ? env.TENANT_CACHE_TTL_SECONDS : env.TENANT_MISS_CACHE_TTL_SECONDS,
  );
  return entry;
}

/** Read-through by slug (subdomain tenancy). Caches misses — see above. */
export async function findBySlug(slug: string): Promise<TenantRegistryEntry | undefined> {
  const key = cacheKeys.tenantBySlug(slug);
  const cached = await cacheGet<TenantRegistryEntry | AbsentMarker>(key);
  if (cached) return isAbsent(cached) ? undefined : cached;

  return remember(key, await findOne({ slug }));
}

/** Read-through by verified custom domain. Caches misses — see above. */
export async function findByCustomDomain(host: string): Promise<TenantRegistryEntry | undefined> {
  const key = cacheKeys.tenantByDomain(host);
  const cached = await cacheGet<TenantRegistryEntry | AbsentMarker>(key);
  if (cached) return isAbsent(cached) ? undefined : cached;

  return remember(key, await findOne({ customDomain: host }));
}

export async function findById(id: string): Promise<TenantRegistryEntry | undefined> {
  return findOne({ _id: id });
}

export async function create(input: {
  hospitalName: string;
  slug: string;
  databaseName: string;
  customDomain?: string;
  region?: string;
  planCode?: string;
  organizationType?: OrganizationType;
  /** Platform branch cap (ADR-0015). Absent ⇒ single-site. */
  maxBranches?: number;
  /** Tenure (ADR-0016). Absent ⇒ the provisioning flow seeds a trial. */
  license?: TenantLicense;
}): Promise<TenantRegistryEntry> {
  const Tenant = await getTenantModel();
  const doc = await Tenant.create({
    hospitalName: input.hospitalName,
    slug: input.slug,
    databaseName: input.databaseName,
    ...(input.organizationType ? { organizationType: input.organizationType } : {}),
    ...(input.customDomain ? { customDomain: input.customDomain } : {}),
    ...(input.region ? { region: input.region } : {}),
    subscription: input.planCode ? { planCode: input.planCode } : {},
    ...(typeof input.maxBranches === "number"
      ? { limits: { maxBranches: input.maxBranches } }
      : {}),
    ...(input.license ? { license: input.license } : {}),
    status: "provisioning",
  });

  const entry = toEntry(doc.toObject<TenantDoc>());

  /**
   * Forget any cached ABSENCE of this slug, the moment the hospital exists.
   *
   * Negative caching (see `remember`) means a slug someone probed before it existed
   * — a typo, a crawler, an operator checking whether the name was free — is cached
   * as absent. If that is never forgotten, the brand-new hospital 404s for the rest
   * of the miss TTL, and the person it 404s at is the customer we onboarded thirty
   * seconds ago, on their first ever visit.
   *
   * HONESTY ABOUT WHAT THIS LINE ACTUALLY DOES: provisioning ends by activating the
   * tenant (`transitionStatus` → `updateStatus` → `invalidate`), so that path
   * already clears the key — deleting this line alone does NOT break the suite, and
   * the falsification proved it. It is kept because it narrows the window: between
   * `create()` and activation there are migrations and seeds, any of which can fail
   * and leave the tenant un-activated with a stale absence still cached. The
   * invariant worth stating is not "this line fixes it" but:
   *
   *     REMEMBERING AN ABSENCE OBLIGES YOU TO FORGET IT THE INSTANT IT STOPS BEING
   *     TRUE — and the registry has exactly one place where that becomes true.
   */
  await invalidate(entry);
  return entry;
}

export async function updateStatus(
  id: string,
  status: TenantStatus,
): Promise<TenantRegistryEntry | undefined> {
  const Tenant = await getTenantModel();
  const doc = await Tenant.findByIdAndUpdate(id, { status }, { new: true })
    .lean<TenantDoc>()
    .exec();
  if (!doc) return undefined;
  const entry = toEntry(doc);
  await invalidate(entry);
  return entry;
}

/** The current stored licence for one tenant — the shape `setLicense` patches. */
export async function findLicense(id: string): Promise<TenantLicense | undefined> {
  const Tenant = await getTenantModel();
  const doc = await Tenant.findById(id).select("license").lean<Pick<TenantDoc, "license">>().exec();
  return doc?.license ?? undefined;
}

/** Raise/lower the branch cap (ADR-0015). Busts the registry cache so it takes effect at once. */
export async function updateLimits(
  id: string,
  limits: { maxBranches?: number },
): Promise<TenantRegistryEntry | undefined> {
  const Tenant = await getTenantModel();
  const doc = await Tenant.findByIdAndUpdate(
    id,
    { $set: { "limits.maxBranches": limits.maxBranches } },
    { new: true },
  )
    .lean<TenantDoc>()
    .exec();
  if (!doc) return undefined;
  const entry = toEntry(doc);
  await invalidate(entry);
  return entry;
}

/** Set/renew a tenant's licence (ADR-0016). Busts the cache so the new expiry gates at once. */
export async function updateLicense(
  id: string,
  license: TenantLicense,
): Promise<TenantRegistryEntry | undefined> {
  const Tenant = await getTenantModel();
  const doc = await Tenant.findByIdAndUpdate(id, { $set: { license } }, { new: true })
    .lean<TenantDoc>()
    .exec();
  if (!doc) return undefined;
  const entry = toEntry(doc);
  await invalidate(entry);
  return entry;
}

/**
 * Attach/replace/clear a hospital's custom domain. Busts BOTH the old and the new
 * domain cache keys — a stale positive on the old host would keep routing a domain
 * the operator just detached.
 */
export async function updateCustomDomain(
  id: string,
  customDomain: string | null,
): Promise<TenantRegistryEntry | undefined> {
  const Tenant = await getTenantModel();
  const before = await Tenant.findById(id)
    .select("customDomain")
    .lean<Pick<TenantDoc, "customDomain">>()
    .exec();
  const doc = await Tenant.findByIdAndUpdate(
    id,
    customDomain ? { $set: { customDomain } } : { $unset: { customDomain: "" } },
    { new: true },
  )
    .lean<TenantDoc>()
    .exec();
  if (!doc) return undefined;
  const entry = toEntry(doc);
  const oldDomain = before?.customDomain;
  if (oldDomain && oldDomain !== customDomain) await cacheDel(cacheKeys.tenantByDomain(oldDomain));
  await invalidate(entry);
  return entry;
}

/** True when another tenant already owns this custom domain — the caller refuses the write. */
export async function customDomainOwner(host: string): Promise<string | undefined> {
  const Tenant = await getTenantModel();
  const doc = await Tenant.findOne({ customDomain: host })
    .select("_id")
    .lean<{ _id: unknown }>()
    .exec();
  return doc ? String(doc._id) : undefined;
}

/**
 * Explicit cache invalidation — MUST be called by whoever writes the registry,
 * in the same service method (CACHE_STRATEGY: invalidation discipline).
 */
export async function invalidate(entry: TenantRegistryEntry): Promise<void> {
  const keys = [cacheKeys.tenantBySlug(entry.slug)];
  if (entry.customDomain) keys.push(cacheKeys.tenantByDomain(entry.customDomain));
  await cacheDel(...keys);
}
