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
import { scopeFilter } from "../../middleware/authorize.js";
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

/**
 * One ledger row by id — for regenerating an advance receipt later.
 *
 * Scoped, because `wallet:manage` is declared `"branch"` and `credit`/`debit` stamp the branch
 * the money crossed the desk at. This was a bare `findById`, so a receipt link — which carries
 * only the entry id — reprinted another site's receipt: the payer's name, the date and the
 * amount. Smaller than the report leak it was found alongside, and closed the same way.
 */
export async function findEntryById(id: string): Promise<WalletEntry | undefined> {
  if (!Types.ObjectId.isValid(id)) return undefined;
  const doc = await getWalletEntryModel(getTenantDb())
    .findOne({ _id: new Types.ObjectId(id), ...scopeFilter() })
    .lean<WalletEntryDoc>();
  return doc ? toEntry(doc) : undefined;
}

/** Advances TAKEN in a period `[from, to)`, newest first — the deposits half of the receipts register. */
export async function depositsBetween(from: Date, to: Date): Promise<WalletEntry[]> {
  const docs = await getWalletEntryModel(getTenantDb())
    .find({ type: "deposit", at: { $gte: from, $lt: to } })
    .sort({ at: -1 })
    .limit(500)
    .lean<WalletEntryDoc[]>();
  return docs.map(toEntry);
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

/* ── Reporting: the advance register (period on movement date, half-open) ───── */

export interface WalletMethodRow {
  method: string;
  amount: number;
  count: number;
}

export interface WalletRegister {
  /** Advances COLLECTED in the period — real money in (mostly admission advances). Paise. */
  deposits: { total: number; count: number; byMethod: WalletMethodRow[] };
  /** Advances REFUNDED in the period — money handed back (leftover on discharge). Paise. */
  refunds: { total: number; count: number; byMethod: WalletMethodRow[] };
  /** Advance APPLIED to bills in the period (wallet debits) — NOT new money, a transfer. Paise. */
  utilized: { total: number; count: number };
  /** Advance the hospital HOLDS right now, summed across all patients — a liability. Point-in-time. */
  outstandingHeld: number;
}

/**
 * The advance register for a period `[from, to)` — deposits, refunds and utilisation.
 *
 * The distinction this report exists to make: a DEPOSIT is real money crossing the counter, but a
 * UTILISATION (a bill settled from advance) is NOT — it is that same money, collected earlier,
 * moving from the patient's advance to the hospital's revenue. Counting utilisation as income would
 * double-count against the deposit. So deposits/refunds carry a `byMethod` breakdown (cash/card/upi)
 * for the drawer, and utilisation is reported on its own line, plainly labelled as a transfer.
 *
 * `outstandingHeld` is deliberately point-in-time (the sum of every current balance), not period-
 * bound: "how much of other people's money are we holding right now?" is a liability question, and a
 * liability is a snapshot, not a flow.
 */
export async function walletRegister(from: Date, to: Date): Promise<WalletRegister> {
  const entries = getWalletEntryModel(getTenantDb());

  const facet = await entries.aggregate<{
    deposits: { _id: string; amount: number; count: number }[];
    refunds: { _id: string; amount: number; count: number }[];
    utilized: { amount: number; count: number }[];
  }>([
    { $match: { at: { $gte: from, $lt: to } } },
    {
      $facet: {
        deposits: [
          { $match: { type: "deposit" } },
          {
            $group: {
              _id: { $ifNull: ["$method", "other"] },
              amount: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
          { $sort: { amount: -1 } },
        ],
        refunds: [
          { $match: { type: "refund" } },
          {
            $group: {
              _id: { $ifNull: ["$method", "other"] },
              amount: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
          { $sort: { amount: -1 } },
        ],
        utilized: [
          { $match: { type: "debit" } },
          { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } },
        ],
      },
    },
  ]);

  const f = facet[0];
  const rows = (r: { _id: string; amount: number; count: number }[]): WalletMethodRow[] =>
    r.map((x) => ({ method: x._id, amount: x.amount, count: x.count }));
  const sum = (r: WalletMethodRow[]): { total: number; count: number } =>
    r.reduce((a, x) => ({ total: a.total + x.amount, count: a.count + x.count }), {
      total: 0,
      count: 0,
    });

  const depositRows = rows(f?.deposits ?? []);
  const refundRows = rows(f?.refunds ?? []);

  const held = await getWalletAccountModel(getTenantDb()).aggregate<{ total: number }>([
    { $group: { _id: null, total: { $sum: "$balance" } } },
  ]);

  return {
    deposits: { ...sum(depositRows), byMethod: depositRows },
    refunds: { ...sum(refundRows), byMethod: refundRows },
    utilized: { total: f?.utilized[0]?.amount ?? 0, count: f?.utilized[0]?.count ?? 0 },
    outstandingHeld: held[0]?.total ?? 0,
  };
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
 * Takes money from the wallet WITHOUT the balance guard — the admitted-patient path.
 *
 * An inpatient's test must never wait for the advance to be topped up, so this debit is allowed
 * to drive the balance NEGATIVE (the relatives settle the shortfall later; the negative balance is
 * itself the record of what is owed). Upsert materialises the account for a patient who has no
 * advance yet, at a negative balance. Used ONLY for settling an inpatient order from advance — the
 * ordinary `debit` keeps its guard, so refunds and OP settlements can never go negative.
 */
export async function debitAllowNegative(
  patientId: string,
  amount: number,
  meta: MovementMeta,
  session: ClientSession,
): Promise<{ balance: number; entry: WalletEntry }> {
  const account = await getWalletAccountModel(getTenantDb())
    .findOneAndUpdate(
      { patientId: new Types.ObjectId(patientId) },
      { $inc: { balance: -amount } },
      { new: true, upsert: true, setDefaultsOnInsert: true, session },
    )
    .lean<WalletAccountDoc>();

  if (!account) throw new Error("wallet debit (allow-negative) returned nothing");

  const [entry] = await getWalletEntryModel(getTenantDb()).create(
    [entryDoc(patientId, "debit", amount, account.balance, meta)],
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
