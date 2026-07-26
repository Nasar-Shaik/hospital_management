/**
 * Wallet service — deposits, refunds, and settling a bill from advance.
 *
 * Every movement that touches money runs inside `withTransaction`, so the account balance
 * and its ledger row commit together or not at all (see `wallet.repository.ts` for why the
 * balance guard lives in the query rather than here).
 *
 * This module OWNS the wallet and depends on nothing clinical — the arrow points INTO it
 * (billing calls `debitForInvoice` to settle a bill from advance); it calls nothing back, so
 * the dependency graph stays acyclic.
 */
import { AppError } from "../../core/errors/appError.js";
import { withTransaction } from "../../core/db/transaction.js";
import { writeBranchId } from "../../core/context/activeBranch.js";
import { getPatient } from "../patients/index.js";
import * as repo from "./wallet.repository.js";
import type { ClientSession } from "mongoose";

export type { WalletEntry, WalletRegister, WalletMethodRow } from "./wallet.repository.js";

/** The advance register for a period — deposits, refunds, utilisation and the current liability. */
export function walletReport(range: { from: Date; to: Date }): Promise<repo.WalletRegister> {
  return repo.walletRegister(range.from, range.to);
}

export interface WalletView {
  patientId: string;
  balance: number;
  entries: repo.WalletEntry[];
}

/** One ledger entry by id — for regenerating an advance (deposit) receipt later. */
export async function getEntry(id: string): Promise<repo.WalletEntry> {
  const entry = await repo.findEntryById(id);
  if (!entry) throw new AppError("HMS-GEN-404", 404, "Receipt not found", { id });
  return entry;
}

/** Advances taken in a period — the deposits shown on the receipts register. */
export function listDeposits(range: { from: Date; to: Date }): Promise<repo.WalletEntry[]> {
  return repo.depositsBetween(range.from, range.to);
}

/** The balance and recent statement for a patient. */
export async function getWallet(patientId: string): Promise<WalletView> {
  await assertPatient(patientId);
  const [balance, entries] = await Promise.all([
    repo.getBalance(patientId),
    repo.listEntries(patientId),
  ]);
  return { patientId, balance, entries };
}

export interface DepositInput {
  /** Paise. */
  amount: number;
  method: string;
  reference?: string;
  reason?: string;
  encounterId?: string;
}

/**
 * The desk takes an advance — an OP advance, or (the case this was built for) an ADMISSION
 * advance when a doctor decides to admit. It is credit the patient holds, not a payment
 * against any one bill; the bill draws it down later.
 */
export async function deposit(patientId: string, input: DepositInput): Promise<WalletView> {
  await assertPatient(patientId);
  if (input.amount <= 0) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      amount: ["a deposit must be a positive amount"],
    });
  }

  // Money crossed the desk AT a branch — stamp the one the clerk is working in (ADR-0015),
  // so the advance register and any reconciliation attribute it to the right site.
  const branchId = await writeBranchId();

  const { balance } = await withTransaction((session) =>
    repo.credit(
      patientId,
      input.amount,
      "deposit",
      {
        method: input.method,
        ...(branchId ? { branchId } : {}),
        ...(input.reference ? { reference: input.reference } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.encounterId ? { encounterId: input.encounterId } : {}),
      },
      session,
    ),
  );

  return { patientId, balance, entries: await repo.listEntries(patientId) };
}

export interface RefundInput {
  /** Paise. */
  amount: number;
  method: string;
  reference?: string;
  reason?: string;
}

/**
 * Money handed back to the patient — the leftover advance on discharge. Refused when the
 * wallet cannot cover it: you cannot refund money that is not there.
 */
export async function refund(patientId: string, input: RefundInput): Promise<WalletView> {
  await assertPatient(patientId);
  if (input.amount <= 0) {
    throw new AppError("HMS-VAL-001", 400, "Validation failed", {
      amount: ["a refund must be a positive amount"],
    });
  }

  // A refund is a desk movement too — attribute it to the branch handing the money back.
  const branchId = await writeBranchId();

  const result = await withTransaction((session) =>
    repo.debit(
      patientId,
      input.amount,
      "refund",
      {
        method: input.method,
        ...(branchId ? { branchId } : {}),
        ...(input.reference ? { reference: input.reference } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      },
      session,
    ),
  );

  if (!result) {
    throw insufficient(patientId, input.amount);
  }

  return { patientId, balance: result.balance, entries: await repo.listEntries(patientId) };
}

/**
 * Draws a bill's settlement from the wallet, WITHIN a caller's transaction.
 *
 * Billing calls this while recording a `method: "wallet"` payment, passing its own session so
 * the debit and the invoice payment are one atomic act — a patient is never debited for a
 * payment that did not post, nor credited on a bill that was not paid. Throws a clean
 * "insufficient balance" (422) when the advance cannot cover it, which rolls the whole thing
 * back. Returns the balance left after the debit.
 */
export async function debitForInvoice(
  session: ClientSession,
  args: {
    patientId: string;
    amount: number;
    invoiceId: string;
    encounterId?: string;
    /**
     * The admitted-patient path: let the balance go NEGATIVE rather than refuse the debit, so an
     * inpatient's test is never held for want of advance (the shortfall is collected later). Off by
     * default — an OP settlement still cannot overspend.
     */
    allowNegative?: boolean;
  },
): Promise<number> {
  const meta = {
    invoiceId: args.invoiceId,
    reason: "Bill settled from advance",
    ...(args.encounterId ? { encounterId: args.encounterId } : {}),
  };

  if (args.allowNegative) {
    const result = await repo.debitAllowNegative(args.patientId, args.amount, meta, session);
    return result.balance;
  }

  const result = await repo.debit(args.patientId, args.amount, "debit", meta, session);
  if (!result) throw insufficient(args.patientId, args.amount);
  return result.balance;
}

/* ── helpers ───────────────────────────────────────────────────────────────── */

async function assertPatient(patientId: string): Promise<void> {
  const patient = await getPatient(patientId);
  if (!patient) throw new AppError("HMS-GEN-404", 404, "Patient not found", { id: patientId });
}

function insufficient(patientId: string, amount: number): AppError {
  return new AppError("HMS-STATE-001", 422, "Insufficient wallet balance", {
    patientId,
    requested: amount,
    hint: "collect a further advance, or settle the difference by another method",
  });
}
