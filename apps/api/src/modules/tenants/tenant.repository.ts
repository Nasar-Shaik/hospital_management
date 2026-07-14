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
  type TenantStatus,
} from "./tenant.model.js";

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

/** Read-through by slug (subdomain tenancy). */
export async function findBySlug(slug: string): Promise<TenantRegistryEntry | undefined> {
  const key = cacheKeys.tenantBySlug(slug);
  const cached = await cacheGet<TenantRegistryEntry>(key);
  if (cached) return cached;

  const entry = await findOne({ slug });
  if (entry) await cacheSet(key, entry, env.TENANT_CACHE_TTL_SECONDS);
  return entry;
}

/** Read-through by verified custom domain. */
export async function findByCustomDomain(host: string): Promise<TenantRegistryEntry | undefined> {
  const key = cacheKeys.tenantByDomain(host);
  const cached = await cacheGet<TenantRegistryEntry>(key);
  if (cached) return cached;

  const entry = await findOne({ customDomain: host });
  if (entry) await cacheSet(key, entry, env.TENANT_CACHE_TTL_SECONDS);
  return entry;
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
    status: "provisioning",
  });
  return toEntry(doc.toObject<TenantDoc>());
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

/**
 * Explicit cache invalidation — MUST be called by whoever writes the registry,
 * in the same service method (CACHE_STRATEGY: invalidation discipline).
 */
export async function invalidate(entry: TenantRegistryEntry): Promise<void> {
  const keys = [cacheKeys.tenantBySlug(entry.slug)];
  if (entry.customDomain) keys.push(cacheKeys.tenantByDomain(entry.customDomain));
  await cacheDel(...keys);
}
