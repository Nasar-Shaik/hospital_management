/**
 * Tamper evidence for the audit trail — periodic hash-chain anchoring (Doc 09 §9).
 *
 * WHAT THIS CAN AND CANNOT DO
 * ---------------------------
 * It cannot PREVENT tampering. Anyone with direct database access can edit a
 * document, and no amount of application code stops them. What it does is make
 * tampering *detectable*: every entry carries a content hash, and an anchor seals
 * a contiguous range of entries under a root hash that is itself chained to the
 * previous anchor. To forge one entry undetectably you must also recompute every
 * anchor after it — and if the anchors are shipped off-box (S3 object lock, a
 * signed daily email to the compliance officer, a public timestamping service),
 * you must alter those too.
 *
 * That distinction matters in a hospital. When a patient dies and a chart entry
 * is later found to have been backdated, the question in court is not "could the
 * system have stopped it" — it is "can you prove what the record said at the
 * time". This is how we answer that.
 *
 * WHY ANCHORING IS PERIODIC AND NOT PER-WRITE
 * -------------------------------------------
 * A per-write chain (`hash_n = H(hash_{n-1} + entry_n)`) needs a global lock on
 * the tail: two concurrent writers would read the same predecessor and produce a
 * fork. Serializing every audit write behind a lock would make the audit trail
 * the throughput ceiling of the entire hospital — and audit must never be the
 * reason a nurse cannot chart. So writes are lock-free and gap-free (`seq` from
 * an atomic counter), and a single-writer job seals ranges after the fact. The
 * chain is therefore eventually-consistent, which is exactly what "periodic
 * anchoring" in Doc 09 §9 means.
 *
 * Detection this yields:
 *   - entry CONTENT edited  → recomputed leaf hash ≠ stored hash
 *   - entry HASH edited too → recomputed root ≠ anchor root
 *   - entry DELETED         → hole in `seq` (and count mismatch inside the range)
 *   - entry INSERTED late   → `seq` inside an already-sealed range
 *   - an ANCHOR rewritten   → its `prevHash` no longer matches its predecessor
 */
import { createHash } from "node:crypto";
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { getContext } from "../context/requestContext.js";
import { getAuditLogModel } from "./audit.model.js";
import { hashAuditEntry, type AuditLeaf } from "./auditWriter.js";

/**
 * Entries younger than this are not sealed yet.
 *
 * A writer that allocated `seq` 41 may still be in flight while `seq` 42 is
 * already committed, so sealing right up to the newest entry would seal a range
 * with a hole in it — and that hole would then look, forever, like a deletion.
 * Waiting a couple of minutes costs nothing and removes an entire class of false
 * accusation.
 */
const SEAL_LAG_MS = 120_000;

export interface AuditAnchorDoc {
  _id: Types.ObjectId;
  tenantId: string;
  /** Anchors form their own sequence — 1, 2, 3 … — so a missing anchor is visible too. */
  index: number;
  fromSeq: number;
  toSeq: number;
  /** How many entries were actually present. `toSeq - fromSeq + 1` if there were no holes. */
  count: number;
  /** H(prevHash ‖ leaf₁ ‖ leaf₂ ‖ … ‖ leafₙ) */
  rootHash: string;
  /** The previous anchor's rootHash — this is what makes it a *chain*. */
  prevHash: string;
  sealedAt: Date;
}

const auditAnchorSchema = new Schema<AuditAnchorDoc>(
  {
    tenantId: { type: String, required: true },
    index: { type: Number, required: true },
    fromSeq: { type: Number, required: true },
    toSeq: { type: Number, required: true },
    count: { type: Number, required: true },
    rootHash: { type: String, required: true },
    prevHash: { type: String, required: true },
    sealedAt: { type: Date, required: true },
  },
  { timestamps: false, collection: "auditAnchors", autoIndex: false },
);

function getAnchorModel(conn: Connection): Model<AuditAnchorDoc> {
  return (
    (conn.models.AuditAnchor as Model<AuditAnchorDoc>) ??
    conn.model<AuditAnchorDoc>("AuditAnchor", auditAnchorSchema)
  );
}

/** The genesis link: the first anchor of a hospital has no predecessor. */
const GENESIS = "0".repeat(64);

function rootOf(prevHash: string, leaves: string[]): string {
  const digest = createHash("sha256").update(prevHash);
  for (const leaf of leaves) digest.update(leaf);
  return digest.digest("hex");
}

/**
 * The leaf hash recomputed from what is STORED — not from what was claimed at
 * write time. It goes through the same `hashAuditEntry` projection the writer
 * used, so the two can never disagree about which fields are covered.
 */
function recomputeLeaf(doc: AuditLogLike): string {
  return hashAuditEntry(doc);
}

type AuditLogLike = AuditLeaf & { hash: string };

export interface SealResult {
  sealed: boolean;
  index?: number;
  fromSeq?: number;
  toSeq?: number;
  count?: number;
  rootHash?: string;
}

/**
 * Seals every unsealed entry older than the lag window into one new anchor.
 * Idempotent: running it twice in a row seals nothing the second time.
 *
 * Must run inside a tenant context (the anchor job supplies one per hospital).
 */
export async function sealAuditRange(): Promise<SealResult> {
  const ctx = getContext();
  const anchors = getAnchorModel(ctx.connection);
  const logs = getAuditLogModel(ctx.connection);

  const last = await anchors.findOne({ tenantId: ctx.tenantId }).sort({ index: -1 }).lean();
  const fromSeq = (last?.toSeq ?? 0) + 1;
  const cutoff = new Date(Date.now() - SEAL_LAG_MS);

  const entries = (await logs
    .find({ seq: { $gte: fromSeq }, at: { $lt: cutoff } })
    .sort({ seq: 1 })
    .lean()) as unknown as AuditLogLike[];

  if (entries.length === 0) return { sealed: false };

  // Seal by STORED hash, not by recomputed hash: the anchor's job is to freeze
  // what the trail says today. `verifyAuditChain` is what later asks whether what
  // it says today is still what it said when it was sealed.
  const leaves = entries.map((e) => e.hash);
  const prevHash = last?.rootHash ?? GENESIS;
  const toSeq = entries[entries.length - 1]?.seq ?? fromSeq;

  const anchor = {
    tenantId: ctx.tenantId,
    index: (last?.index ?? 0) + 1,
    fromSeq,
    toSeq,
    count: entries.length,
    rootHash: rootOf(prevHash, leaves),
    prevHash,
    sealedAt: new Date(),
  };

  await anchors.create([anchor]);

  return {
    sealed: true,
    index: anchor.index,
    fromSeq,
    toSeq,
    count: anchor.count,
    rootHash: anchor.rootHash,
  };
}

export interface ChainProblem {
  anchorIndex: number;
  kind: "content-tampered" | "root-mismatch" | "broken-link" | "missing-entry" | "late-insert";
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  anchors: number;
  entriesVerified: number;
  problems: ChainProblem[];
}

/**
 * Walks the whole chain for the current tenant and reports what does not add up.
 * Read-only — verification never "repairs" anything, because a trail that repairs
 * itself is a trail that can be made to say anything.
 */
export async function verifyAuditChain(): Promise<VerifyResult> {
  const ctx = getContext();
  const anchors = getAnchorModel(ctx.connection);
  const logs = getAuditLogModel(ctx.connection);

  const chain = await anchors.find({}).sort({ index: 1 }).lean();
  const problems: ChainProblem[] = [];
  let entriesVerified = 0;
  let expectedPrev = GENESIS;

  for (const anchor of chain) {
    if (anchor.prevHash !== expectedPrev) {
      problems.push({
        anchorIndex: anchor.index,
        kind: "broken-link",
        detail: `anchor ${String(anchor.index)} claims prevHash ${anchor.prevHash.slice(0, 12)}… but its predecessor sealed to ${expectedPrev.slice(0, 12)}…`,
      });
    }

    const entries = (await logs
      .find({ seq: { $gte: anchor.fromSeq, $lte: anchor.toSeq } })
      .sort({ seq: 1 })
      .lean()) as unknown as AuditLogLike[];

    if (entries.length !== anchor.count) {
      problems.push({
        anchorIndex: anchor.index,
        kind: entries.length < anchor.count ? "missing-entry" : "late-insert",
        detail: `anchor ${String(anchor.index)} sealed ${String(anchor.count)} entries in seq ${String(anchor.fromSeq)}–${String(anchor.toSeq)}; ${String(entries.length)} are present now`,
      });
    }

    for (const entry of entries) {
      if (recomputeLeaf(entry) !== entry.hash) {
        problems.push({
          anchorIndex: anchor.index,
          kind: "content-tampered",
          detail: `entry seq ${String(entry.seq)} (${entry.action}) no longer hashes to its stored hash — its content was changed after it was written`,
        });
      }
    }

    if (
      rootOf(
        anchor.prevHash,
        entries.map((e) => e.hash),
      ) !== anchor.rootHash
    ) {
      problems.push({
        anchorIndex: anchor.index,
        kind: "root-mismatch",
        detail: `anchor ${String(anchor.index)} root does not reproduce from the entries it sealed`,
      });
    }

    entriesVerified += entries.length;
    expectedPrev = anchor.rootHash;
  }

  return { ok: problems.length === 0, anchors: chain.length, entriesVerified, problems };
}
