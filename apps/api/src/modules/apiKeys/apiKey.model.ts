/**
 * API keys (Module A9) — programmatic access to a hospital's API for its own integrations.
 *
 * ── THE PERSONAL-ACCESS-TOKEN MODEL ─────────────────────────────────────────
 * A key is bound to the USER who created it and authenticates AS that user: it carries exactly
 * that person's live permissions and branch scope, no more. This is deliberate and it is what
 * keeps `authorize` untouched — the whole authorization stack already answers "what may THIS user
 * do?" by user id, so a key that resolves to a user id needs no second permission system. The
 * cost, stated plainly, is that a key is as powerful as its owner; narrower per-key scopes are a
 * future enhancement, not smuggled in half-done here.
 *
 * ── ONLY THE DIGEST IS STORED ───────────────────────────────────────────────
 * The key is a 256-bit random secret shown to the creator ONCE. We persist only its SHA-256
 * digest (`generateOpaqueToken`/`digestToken`, the same discipline as refresh tokens), so a
 * database leak yields no usable keys. Lookup on every request is a single indexed query on the
 * digest.
 */
import { Schema, type Connection, type Model, type Types } from "mongoose";
import { tenantScopePlugin } from "../../core/db/plugins/tenantScope.js";
import { auditPlugin } from "../../core/db/plugins/auditPlugin.js";

export interface ApiKeyDoc {
  _id: Types.ObjectId;
  tenantId: string;

  /** A human label — "Billing export", "Analytics sync". */
  name: string;
  /** SHA-256 of the full key. The plaintext is never stored. */
  keyHash: string;
  /** The last 4 characters of the key, shown in the list so a person can tell keys apart. */
  last4: string;

  /** The user this key acts as — its permissions and branch scope are this user's, live. */
  userId: string;
  createdBy: string;

  /** Optional hard expiry. Absent means the key lives until it is revoked. */
  expiresAt?: Date;
  /** Set when the key is revoked; a revoked key authenticates nobody. Never deleted (audit). */
  revokedAt?: Date;
  /** Updated best-effort on use, so an admin can spot and cull a key nothing calls. */
  lastUsedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const apiKeySchema = new Schema<ApiKeyDoc>(
  {
    tenantId: { type: String, required: true, index: true },

    name: { type: String, required: true, trim: true, maxlength: 80 },
    keyHash: { type: String, required: true },
    last4: { type: String, required: true, maxlength: 8 },

    userId: { type: String, required: true },
    createdBy: { type: String, required: true },

    expiresAt: { type: Date },
    revokedAt: { type: Date },
    lastUsedAt: { type: Date },
  },
  { timestamps: true, collection: "apiKeys", autoIndex: false },
);

apiKeySchema.plugin(tenantScopePlugin);

// Configuration/security, not PHI — the `admin` category. `keyHash` is excluded from the audit
// diff: it is a credential digest and has no business being copied into the trail.
apiKeySchema.plugin(auditPlugin, { resource: "apiKey", category: "admin", ignore: ["keyHash"] });

export function getApiKeyModel(conn: Connection): Model<ApiKeyDoc> {
  return (conn.models.ApiKey as Model<ApiKeyDoc>) ?? conn.model<ApiKeyDoc>("ApiKey", apiKeySchema);
}
