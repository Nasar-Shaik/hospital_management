/**
 * Branch response contracts — what `/branches` and `/me/branches` actually send.
 *
 * `Proves<>` ties each schema to the DTO the repository returns, so adding a field to `Branch`
 * without documenting it fails the build rather than the next client that expects it.
 */
import { z } from "@medicore/validation";
import { contract, type Matches, type Proves, type Returns } from "../../core/http/contract.js";
import { BRANCH_STATUSES } from "./branch.model.js";
import type { Branch } from "./branch.repository.js";
import type { listMyBranches } from "./branch.service.js";

export const branch = contract(
  "Branch",
  z.object({
    id: z.string(),
    name: z.string(),
    code: z.string(),
    status: z.enum(BRANCH_STATUSES),
    isMain: z.boolean(),
    address: z.string().optional(),
    contactPhone: z.string().optional(),
    contactEmail: z.string().optional(),
    timezone: z.string().optional(),
    gstin: z.string().optional(),
  }),
);
export type BranchProof = Proves<Matches<typeof branch, Branch>>;

/** The branch switcher's payload: the sites this user may act in, and whether "All" is offered. */
export const myBranches = contract(
  "MyBranches",
  z.object({ branches: z.array(branch), canAggregate: z.boolean() }),
);
export type MyBranchesProof = Proves<Matches<typeof myBranches, Returns<typeof listMyBranches>>>;
