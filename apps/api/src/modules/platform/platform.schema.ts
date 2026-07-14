/**
 * Platform DTOs (Doc 09 §5/§6).
 */
import { z } from "@medicore/validation";
import { ORGANIZATION_TYPES } from "@medicore/permissions";
import { env } from "../../config/env.js";
import { PLATFORM_ROLES } from "./platform.model.js";

export const operatorLoginSchema = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(1).max(512),
  })
  .strict();

export const operatorPasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(512),
    newPassword: z.string().min(env.PASSWORD_MIN_LENGTH).max(512),
  })
  .strict();

export const createHospitalSchema = z
  .object({
    /**
     * The slug becomes the hostname AND the database name, permanently. It cannot
     * be changed later without a migration, which is why it is validated hard here
     * and why reserved names are refused in the tenant service.
     */
    slug: z
      .string()
      .min(3)
      .max(40)
      .regex(
        /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/,
        "lowercase letters, numbers and hyphens; cannot start or end with a hyphen",
      ),
    hospitalName: z.string().min(2).max(120),
    planCode: z.string().regex(/^PLAN_[A-Z_]+$/, "must be a plan code such as PLAN_HOSPITAL"),
    /**
     * What KIND of hospital this is (ADR-0013 §6). Asked here because provisioning
     * is the one moment the question can be put cleanly to a human.
     *
     * It selects a policy PRESET — where a journey starts, when a token is issued,
     * whether patients are routed to a doctor or a department, and how they are
     * billed. `government_hospital` gets `billingMode: zero_tariff`: the patient
     * pays NOTHING, and every charge is still posted at ₹0, because the hospital
     * must report drug consumption and per-patient cost even when nobody pays.
     *
     * Optional — defaults to `private_hospital`, the commonest customer.
     */
    organizationType: z.enum(ORGANIZATION_TYPES).optional(),
    adminEmail: z.string().email().max(254),
    adminName: z.string().min(2).max(120).optional(),
    /** Omit and a strong one is generated and shown ONCE. */
    adminPassword: z.string().min(env.PASSWORD_MIN_LENGTH).max(512).optional(),
    trial: z.boolean().optional(),
  })
  .strict();

export const hospitalStatusSchema = z
  .object({
    status: z.enum(["active", "trial", "suspended", "terminated"]),
  })
  .strict();

export const hospitalPlanSchema = z
  .object({
    planCode: z.string().regex(/^PLAN_[A-Z_]+$/),
  })
  .strict();

export const issueAdminSchema = z
  .object({
    email: z.string().email().max(254),
    name: z.string().min(2).max(120).optional(),
  })
  .strict();

export const createOperatorSchema = z
  .object({
    email: z.string().email().max(254),
    name: z.string().min(2).max(120),
    roles: z.array(z.enum(PLATFORM_ROLES)).min(1),
  })
  .strict();
