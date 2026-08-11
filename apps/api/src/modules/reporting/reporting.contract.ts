/**
 * Reporting response contracts.
 *
 * Every money field is PAISE and integer. The `…Named` shapes are the plain repository reports
 * with ids resolved to names — a report that says `doctorId: 6a7b…` is not a report anybody reads.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import { DUES_BUCKETS } from "../billing/index.js";
import type { CollectionsReport } from "../billing/index.js";
import type {
  DischargeRegisterReport as DischargeRegister,
  VisitReport,
} from "../encounters/index.js";
import type { StockRegisterRow } from "../medicines/index.js";
import type { WalletRegister } from "../wallet/index.js";
import type {
  DiagnosticsReportNamed,
  DoctorLoadNamedRow,
  DuesAgeingReportNamed,
  MyActivity,
  ReceiptRow,
  RevenueLeakageReportNamed,
} from "./reporting.service.js";

const paise = z.number().int();
const keyCount = z.object({ key: z.string(), count: z.number() });
const monthCount = z.object({ month: z.string(), count: z.number() });

/** id, uhid and name — enough to open the chart from a report row. */
export const activityPatientRef = contract(
  "ActivityPatientRef",
  z.object({ id: z.string(), uhid: z.string(), name: z.string() }),
);

export const myActivity = contract(
  "MyActivity",
  z.object({
    /** DISTINCT patients seen, not visit count — a returning patient is one person. */
    patientsSeen: z.number(),
    visits: z.array(
      z.object({
        patient: activityPatientRef,
        encounterId: z.string(),
        at: z.string(),
        class: z.string(),
        status: z.string(),
      }),
    ),
    tests: z.array(
      z.object({
        patient: activityPatientRef,
        orderId: z.string(),
        name: z.string(),
        category: z.string(),
        status: z.string(),
        at: z.string(),
      }),
    ),
    prescriptions: z.array(
      z.object({
        patient: activityPatientRef,
        prescriptionId: z.string(),
        drugs: z.array(z.string()),
        at: z.string(),
      }),
    ),
  }),
);
export type MyActivityProof = Proves<Matches<typeof myActivity, MyActivity>>;

export const stockRegisterRow = contract(
  "StockRegisterRow",
  z.object({
    medicineId: z.string(),
    code: z.string(),
    name: z.string(),
    /** Balance the period opened with. */
    opening: z.number(),
    received: z.number(),
    /** Units handed OUT during the period, as a positive number. */
    dispensed: z.number(),
    /** Net of corrections during the period — signed. */
    adjusted: z.number(),
    /** opening + received − dispensed + adjusted. */
    closing: z.number(),
  }),
);
export type StockRegisterRowProof = Proves<Matches<typeof stockRegisterRow, StockRegisterRow>>;

export const visitReport = contract(
  "VisitReport",
  z.object({
    total: z.number(),
    byClass: z.array(keyCount),
    byOrigin: z.array(keyCount),
    byMonth: z.array(monthCount),
  }),
);
export type VisitReportProof = Proves<Matches<typeof visitReport, VisitReport>>;

export const doctorLoadRow = contract(
  "DoctorLoadRow",
  z.object({ doctorId: z.string(), doctorName: z.string(), patients: z.number() }),
);
export type DoctorLoadRowProof = Proves<Matches<typeof doctorLoadRow, DoctorLoadNamedRow>>;

export const diagnosticsReport = contract(
  "DiagnosticsReport",
  z.object({
    /** Diagnostic orders raised in the period (cancelled excluded). */
    total: z.number(),
    /** How many of those were actually performed. */
    performed: z.number(),
    byCategory: z.array(
      z.object({ category: z.string(), ordered: z.number(), performed: z.number() }),
    ),
    byPerformer: z.array(
      z.object({
        performedBy: z.string(),
        performerName: z.string(),
        performed: z.number(),
      }),
    ),
  }),
);
export type DiagnosticsReportProof = Proves<
  Matches<typeof diagnosticsReport, DiagnosticsReportNamed>
>;

export const collectionsReport = contract(
  "CollectionsReport",
  z.object({
    /** Money RECEIVED at the counter in the period. Excludes wallet settlements. */
    total: paise,
    count: z.number(),
    byMonth: z.array(z.object({ month: z.string(), amount: paise, count: z.number() })),
    byMethod: z.array(z.object({ method: z.string(), amount: paise, count: z.number() })),
    /** Bills settled FROM ADVANCE — reported apart, or the day's takings would be inflated. */
    settledFromAdvance: paise,
  }),
);
export type CollectionsReportProof = Proves<Matches<typeof collectionsReport, CollectionsReport>>;

export const revenueLeakageReport = contract(
  "RevenueLeakageReport",
  z.object({
    /** Posted as a charge in the period but never put on a bill. The money at risk. */
    total: paise,
    count: z.number(),
    byCategory: z.array(z.object({ category: z.string(), amount: paise, count: z.number() })),
    bySource: z.array(z.object({ source: z.string(), amount: paise, count: z.number() })),
    /** The visits carrying unbilled charges, heaviest first — where to go and bill. */
    byEncounter: z.array(
      z.object({
        encounterId: z.string(),
        patientId: z.string(),
        patientName: z.string(),
        uhid: z.string(),
        amount: paise,
        count: z.number(),
      }),
    ),
  }),
);
export type RevenueLeakageReportProof = Proves<
  Matches<typeof revenueLeakageReport, RevenueLeakageReportNamed>
>;

export const duesAgeingReport = contract(
  "DuesAgeingReport",
  z.object({
    /** Still owed on finalized-but-unpaid bills, as of the report date. */
    totalOutstanding: paise,
    invoiceCount: z.number(),
    /** The ageing the collections desk chases down. */
    buckets: z.array(z.object({ bucket: z.enum(DUES_BUCKETS), amount: paise, count: z.number() })),
    /** The heaviest debts, oldest money first — who to call. */
    topDebtors: z.array(
      z.object({
        invoiceId: z.string(),
        number: z.string().optional(),
        patientId: z.string(),
        patientName: z.string(),
        uhid: z.string(),
        outstanding: paise,
        ageDays: z.number(),
      }),
    ),
  }),
);
export type DuesAgeingReportProof = Proves<Matches<typeof duesAgeingReport, DuesAgeingReportNamed>>;

const walletMethodRow = z.object({ method: z.string(), amount: paise, count: z.number() });

export const walletRegister = contract(
  "WalletRegister",
  z.object({
    /** Advances COLLECTED in the period — real money in. */
    deposits: z.object({ total: paise, count: z.number(), byMethod: z.array(walletMethodRow) }),
    /** Advances REFUNDED — money handed back. */
    refunds: z.object({ total: paise, count: z.number(), byMethod: z.array(walletMethodRow) }),
    /** Advance APPLIED to bills — NOT new money, a transfer. */
    utilized: z.object({ total: paise, count: z.number() }),
    /** Advance the hospital HOLDS right now — a liability. Point-in-time. */
    outstandingHeld: paise,
  }),
);
export type WalletRegisterProof = Proves<Matches<typeof walletRegister, WalletRegister>>;

export const receiptRow = contract(
  "ReceiptRow",
  z.object({
    kind: z.enum(["bill", "advance"]),
    /** An invoice id for a bill, a wallet-entry id for an advance. */
    refId: z.string(),
    receiptNo: z.string(),
    patientId: z.string(),
    patientName: z.string(),
    uhid: z.string(),
    amount: paise,
    /** Payment method for an advance; blank for a bill, which may span methods. */
    method: z.string().optional(),
    at: z.string(),
  }),
);
export type ReceiptRowProof = Proves<Matches<typeof receiptRow, ReceiptRow>>;

export const dischargeRegister = contract(
  "DischargeRegister",
  z.object({
    /** Inpatient stays that ENDED in the window, however they ended. */
    total: z.number(),
    byDisposition: z.array(keyCount),
    /** The census an auditor reconciles against. */
    byMonth: z.array(monthCount),
  }),
);
export type DischargeRegisterProof = Proves<Matches<typeof dischargeRegister, DischargeRegister>>;
