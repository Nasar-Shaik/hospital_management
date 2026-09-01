/**
 * Ward, room and bed response contracts.
 *
 * All three are BRANCH-SCOPED (ADR-0015): two sites may each run an "ICU", and a bed that does not
 * say which hospital it stands in is not addressable.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves } from "../../core/http/contract.js";
import {
  BED_STATUSES,
  ROOM_KINDS,
  ROOM_STATUSES,
  WARD_KINDS,
  WARD_STATUSES,
} from "./ward.model.js";
import type { Bed, Room, Ward } from "./ward.repository.js";

export const ward = contract(
  "Ward",
  z.object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(WARD_KINDS),
    tariffCode: z.string(),
    status: z.enum(WARD_STATUSES),
    branchId: z.string().optional(),
  }),
);
export type WardProof = Proves<Matches<typeof ward, Ward>>;

export const room = contract(
  "Room",
  z.object({
    id: z.string(),
    wardId: z.string(),
    name: z.string(),
    kind: z.enum(ROOM_KINDS),
    /** The room-class tariff, when set — the middle link of the bed → room → ward price chain. */
    tariffCode: z.string().optional(),
    status: z.enum(ROOM_STATUSES),
    branchId: z.string().optional(),
    /** Denormalized from the ward, so the catalogue reads in one shape. */
    wardName: z.string(),
  }),
);
export type RoomProof = Proves<Matches<typeof room, Room>>;

export const bed = contract(
  "Bed",
  z.object({
    id: z.string(),
    wardId: z.string(),
    roomId: z.string().optional(),
    code: z.string(),
    /** LEGACY free-text room label — superseded by `roomId`. */
    room: z.string().optional(),
    /** The tariff the bed-day bills at — bed → room → ward, most specific wins. */
    tariffCode: z.string(),
    status: z.enum(BED_STATUSES),
    blockedReason: z.string().optional(),
    branchId: z.string().optional(),
    /** Denormalized from the ward for the list and the admit picker — never stored. */
    wardName: z.string(),
    wardKind: z.enum(WARD_KINDS),
    wardStatus: z.enum(WARD_STATUSES),
    roomName: z.string().optional(),
    roomKind: z.enum(ROOM_KINDS).optional(),
  }),
);
export type BedProof = Proves<Matches<typeof bed, Bed>>;
