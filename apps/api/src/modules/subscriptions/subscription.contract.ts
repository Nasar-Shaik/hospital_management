/**
 * Subscription response contracts — the plan a hospital is on and how much of it it is using.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { LIMIT_METRICS } from "./subscription.service.js";
import type { SubscriptionView, UsageLine } from "./subscription.service.js";
import type { Plan } from "./subscription.repository.js";

/** Every limit is optional and `undefined` means "not capped by this edition". */
export const editionLimits = contract(
  "EditionLimits",
  z.object({
    maxUsers: z.number().optional(),
    maxDoctors: z.number().optional(),
    maxBranches: z.number().optional(),
    maxBeds: z.number().optional(),
    /** Never set by any edition — patients are people who walk in, not a thing a hospital buys. */
    maxPatients: z.number().optional(),
    storageGb: z.number().optional(),
  }),
);

export const usageLine = contract(
  "UsageLine",
  z.object({
    metric: z.enum(LIMIT_METRICS),
    label: z.string(),
    used: z.number(),
    /** `null` means unlimited (Enterprise/contractual) — distinct from 0. */
    limit: z.number().nullable(),
    /** 0–1, or null when unlimited. */
    ratio: z.number().nullable(),
    /** True from 80% — the nudge, not the wall. */
    warning: z.boolean(),
    /** True at 100% — the next creation will be refused. */
    exceeded: z.boolean(),
  }),
);
export type UsageLineProof = Proves<Matches<typeof usageLine, UsageLine>>;

export const subscriptionView = contract(
  "SubscriptionView",
  z.object({
    /** `null` before an operator has assigned a plan. */
    planCode: z.string().nullable(),
    planName: z.string().nullable(),
    features: z.array(z.string()),
    limits: editionLimits,
    usage: z.array(usageLine),
  }),
);
export type SubscriptionViewProof = Proves<Matches<typeof subscriptionView, SubscriptionView>>;

export const plan = contract(
  "Plan",
  z.object({
    code: z.string(),
    name: z.string(),
    entitlements: z.array(z.string()),
    limits: editionLimits,
    /** Minor units (paise). */
    priceMinor: z.number().int().optional(),
    currency: z.string().optional(),
  }),
);
export type PlanProof = Proves<Matches<typeof plan, Plan>>;
