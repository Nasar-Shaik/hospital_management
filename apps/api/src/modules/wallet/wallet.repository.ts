/**
 * Wallet repository — the ONLY code that queries `walletAccounts` and `walletEntries`
 * (Constitution §6).
 *
 * ── THE BALANCE MOVES IN THE DATABASE, NEVER IN A `let` ─────────────────────
 * A credit is an atomic `$inc`. A debit is a CONDITIONAL `$inc` that the database refuses
 * when the balance would go negative (`balance: { $gte: amount }`) — so two cashiers who
 * both read "₹500 left" and both try to spend it cannot both win. The one whose update
 * matches first wins; the second matches nothing and is told there are insufficient funds.
 * A read-then-check in the service would have let both through.
 *
 * Both the account move and its ledger row are written in the SAME session — see the
 * service's `withTransaction`. Money that changes the balance and leaves no ledger row is
 * money nobody can audit.
 */
import type { ClientSession } from "mongoose";
import { Types } from "mongoose";
import { getContext, getTenantDb } from "../../core/context/requestContext.js";
import { repointPatientId, type PatientMergeRef } from "../../core/db/repointPatient.js";
import {
  getWalletAccountModel,
  getWalletEntryModel,
  type WalletAccountDoc,
  type WalletEntryDoc,
  type WalletEntryType,
} from "./wallet.model.js";

export interface WalletEntry {
  id: string;
  patientId: string;
  type: WalletEntryType;
  amount: number;
  balanceAfter: number;
  method?: string;
  reference?: string;
  reason?: string;
  invoiceId?: string;
  encounterId?: string;
  by?: string;
  at: Date;
}

function toEntry(d: WalletEntryDoc): WalletEntry {
  return {
    id: d._id.toString(),
    patientId: d.patientId.toString(),
    type: d.type,
    amount: d.amount,
    balanceAfter: d.balanceAfter,
    at: d.at,
    ...(d.method ? { method: d.method } : {}),
    ...(d.reference ? { reference: d.reference } : {}),
    ...(d.reason ? { reason: d.reason } : {}),
    ...(d.invoiceId ? { invoiceId: d.invoiceId.toString() } : {}),
    ...(d.encounterId ? { encounterId: d.encounterId.toString() } : {}),
    ...(d.by ? { by: d.by } : {}),
  };
}

/* ── Reads ─────────────────────────────────────────────────────────────────── */

/** The current balance in paise. A patient who never deposited has 0 — no row is a valid state. */
export async function getBalance(patientId: string): Promise<number> {
  if (!Types.ObjectId.isValid(patientId)) return 0;
  const doc = await getWalletAccountModel(getTenantDb())
    .findOne({ patientId: new Types.ObjectId(patientId) })
    .lean<WalletAccountDoc>();
  return doc?.balance ?? 0;
}

/** The recent ledger, newest first — the statement the desk reads. */
export async function listEntries(patientId: string, limit = 50): Promise<WalletEntry[]> {
  if (!Types.ObjectId.isValid(patientId)) return [];
  const docs = await getWalletEntryModel(getTenantDb())
    .find({ patientId: new Types.ObjectId(patientId) })
    .sort({ at: -1 })
    .limit(Math.min(Math.max(limit, 1), 200))
    .lean<WalletEntryDoc[]>();
  return docs.map(toEntry);
}

/* ── Movements (each writes account + ledger in one session) ────────────────── */

export interface MovementMeta {
  method?: string;
  reference?: string;
  reason?: string;
  invoiceId?: string;
  encounterId?: string;
  branchId?: string;
}

function entryDoc(
  patientId: string,
  type: WalletEntryType,
  amount: number,
  balanceAfter: number,
  meta: MovementMeta,
): Record<string, unknown> {
  const ctx = getContext();
  return {
    tenantId: ctx.tenantId,
    patientId: new Types.ObjectId(patientId),
    type,
    amount,
    balanceAfter,
    at: new Date(),
    ...(meta.method ? { method: meta.method } : {}),
    ...(meta.reference ? { reference: meta.reference } : {}),
    ...(meta.reason ? { reason: meta.reason } : {}),
    ...(meta.invoiceId ? { invoiceId: new Types.ObjectId(meta.invoiceId) } : {}),
    ...(meta.encounterId ? { encounterId: new Types.ObjectId(meta.encounterId) } : {}),
    ...(meta.branchId ? { branchId: meta.branchId } : {}),
    ...(ctx.userId ? { by: ctx.userId } : {}),
  };
}

/**
 * Adds money to the wallet (a deposit, or the reversal of a rolled-back debit).
 *
 * Upsert on `{ patientId }`: the first deposit MATERIALISES the account, and the unique
 * index (migration 0023) arbitrates two first-deposits racing. `tenantScopePlugin` stamps
 * `tenantId` from the query filter on insert.
 */
export async function credit(
  patientId: string,
  amount: number,
  type: Extract<WalletEntryType, "deposit" | "reversal">,
  meta: MovementMeta,
  session: ClientSession,
): Promise<{ balance: number; entry: WalletEntry }> {
  const account = await getWalletAccountModel(getTenantDb())
    .findOneAndUpdate(
      { patientId: new Types.ObjectId(patientId) },
      { $inc: { balance: amount } },
      { new: true, upsert: true, setDefaultsOnInsert: true, session },
    )
    .lean<WalletAccountDoc>();

  if (!account) throw new Error("wallet credit returned nothing");

  const [entry] = await getWalletEntryModel(getTenantDb()).create(
    [entryDoc(patientId, type, amount, account.balance, meta)],
    { session },
  );
  if (!entry) throw new Error("wallet ledger insert returned nothing");

  return { balance: account.balance, entry: toEntry(entry) };
}

/**
 * Takes money from the wallet (a bill settled from advance, or a refund to the patient).
 *
 * The `balance: { $gte: amount }` in the FILTER is the whole guard: the update matches only
 * when the funds are there, and returns `undefined` when they are not (or the account does
 * not exist). The service turns `undefined` into a clean "insufficient balance" — it never
 * lets the balance go negative.
 */
export async function debit(
  patientId: string,
  amount: number,
  type: Extract<WalletEntryType, "debit" | "refund">,
  meta: MovementMeta,
  session: ClientSession,
): Promise<{ balance: number; entry: WalletEntry } | undefined> {
  const account = await getWalletAccountModel(getTenantDb())
    .findOneAndUpdate(
      { patientId: new Types.ObjectId(patientId), balance: { $gte: amount } },
      { $inc: { balance: -amount } },
      { new: true, session },
    )
    .lean<WalletAccountDoc>();

  if (!account) return undefined; // insufficient funds, or no wallet — the caller decides the message

  const [entry] = await getWalletEntryModel(getTenantDb()).create(
    [entryDoc(patientId, type, amount, account.balance, meta)],
    { session },
  );
  if (!entry) throw new Error("wallet ledger insert returned nothing");

  return { balance: account.balance, entry: toEntry(entry) };
}

/**
 * Move a merged patient's wallet onto the survivor (patient.patients.merged).
 *
 * The ledger rows repoint straightforwardly. The two ACCOUNT documents cannot simply both
 * carry the survivor's id — the unique `{ tenantId, patientId }` index forbids two — so the
 * loser's balance is folded into the survivor's and the loser's account is removed. Idempotent
 * on the ledger via `repointPatientId`; the account fold is guarded by re-reading.
 */
export async function repointPatient(ref: PatientMergeRef): Promise<number> {
  const conn = getTenantDb();
  const entries = await repointPatientId(getWalletEntryModel(conn), "patientId", ref, {
    objectId: true,
  });

  const accounts = getWalletAccountModel(conn);
  const loser = await accounts
    .findOneAndDelete({ patientId: new Types.ObjectId(ref.from) })
    .lean<WalletAccountDoc>();
  if (loser && loser.balance !== 0) {
    await accounts.findOneAndUpdate(
      { patientId: new Types.ObjectId(ref.to) },
      { $inc: { balance: loser.balance } },
      { upsert: true, setDefaultsOnInsert: true },
    );
  }

  return entries + (loser ? 1 : 0);
}
