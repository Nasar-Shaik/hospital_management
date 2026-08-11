/**
 * Authentication response contracts.
 *
 * ── THE ONE PLACE A UNION IS THE REAL ANSWER ────────────────────────────────
 * `POST /auth/login` returns EITHER a token pair or an MFA challenge, and the spec has to say so.
 * Collapsing the two into one loose object with everything optional would document a shape the
 * server never sends and would let a client read `accessToken` off a challenge. `mfaRequired` is
 * the discriminator, and it is `true` in the literal sense — the challenge branch always carries
 * it and the token branch never does.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import type {
  AuthenticatedUser,
  LoginResult,
  MfaActivationResult,
  MfaChallenge,
  MfaSetupResult,
  TokenPair,
} from "./auth.service.js";
import type { Session } from "./auth.repository.js";

export const authenticatedUser = contract(
  "AuthenticatedUser",
  z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    roles: z.array(z.string()),
    branchIds: z.array(z.string()),
    mfaEnabled: z.boolean(),
    mustChangePassword: z.boolean(),
    /** `/auth/me` only, and for hiding menu items — never an authorization decision. */
    permissions: z.array(z.string()).optional(),
  }),
);
export type AuthenticatedUserProof = Proves<Matches<typeof authenticatedUser, AuthenticatedUser>>;

export const tokenPair = contract(
  "TokenPair",
  z.object({
    accessToken: z.string(),
    refreshToken: z.string(),
    /** Access-token life in seconds; the client refreshes before it elapses. */
    expiresIn: z.number(),
    user: authenticatedUser,
  }),
);
export type TokenPairProof = Proves<Matches<typeof tokenPair, TokenPair>>;

export const mfaChallenge = contract(
  "MfaChallenge",
  z.object({ mfaRequired: z.literal(true), mfaToken: z.string(), expiresIn: z.number() }),
);
export type MfaChallengeProof = Proves<Matches<typeof mfaChallenge, MfaChallenge>>;

/** 200 either way: the password step succeeded, so a challenge is not a failure. */
export const loginResult = contract("LoginResult", z.union([tokenPair, mfaChallenge]));
export type LoginResultProof = Proves<Matches<typeof loginResult, LoginResult>>;

export const session = contract(
  "Session",
  z.object({
    id: z.string(),
    userId: z.string(),
    family: z.string(),
    device: z.string().optional(),
    ip: z.string().optional(),
    userAgent: z.string().optional(),
    lastSeenAt: z.string(),
    expiresAt: z.string(),
    revokedAt: z.string().optional(),
    createdAt: z.string(),
  }),
);
export type SessionProof = Proves<Matches<typeof session, Session>>;

export const mfaSetupResult = contract(
  "MfaSetupResult",
  z.object({ otpauthUrl: z.string(), secret: z.string() }),
);
export type MfaSetupResultProof = Proves<Matches<typeof mfaSetupResult, MfaSetupResult>>;

export const mfaActivationResult = contract(
  "MfaActivationResult",
  z.object({ recoveryCodes: z.array(z.string()) }),
);
export type MfaActivationResultProof = Proves<
  Matches<typeof mfaActivationResult, MfaActivationResult>
>;

/* ── the acknowledgements ────────────────────────────────────────────────────
 * Named individually rather than behind one shared `Ack`. `{ loggedOut: true }` and
 * `{ passwordChanged: true, reauthenticationRequired: true }` are different facts, and a client
 * that reads the second one decides whether to send the user back to the login screen. A generic
 * acknowledgement would erase exactly the part that matters.
 */
export const forgotPasswordAck = contract("ForgotPasswordAck", z.object({ message: z.string() }));
export const passwordResetAck = contract(
  "PasswordResetAck",
  z.object({ passwordReset: z.literal(true) }),
);
export const loggedOutAck = contract("LoggedOutAck", z.object({ loggedOut: z.literal(true) }));
export const passwordChangedAck = contract(
  "PasswordChangedAck",
  z.object({
    passwordChanged: z.literal(true),
    /** Every other session was revoked — this device must sign in again. */
    reauthenticationRequired: z.literal(true),
  }),
);
export const sessionRevokedAck = contract(
  "SessionRevokedAck",
  z.object({ revoked: z.literal(true) }),
);
export const mfaDisabledAck = contract(
  "MfaDisabledAck",
  z.object({ mfaEnabled: z.literal(false) }),
);
