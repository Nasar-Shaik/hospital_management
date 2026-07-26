/**
 * Branches module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5, ADR-0015).
 *
 * Owns the STORE of a tenant's physical sites: creating them, listing them, editing them, and
 * answering "which branches may THIS user act in?" (the switcher). It depends on `tenants` (for the
 * platform branch cap) and `rbac` (for the caller's branch scope); nothing operational depends on
 * it — operational modules learn their branch from the request context (`writeBranchId`), not by
 * importing this module. The graph stays acyclic.
 */
export { branchRouter } from "./branch.routes.js";

export {
  listBranches,
  listMyBranches,
  getBranch,
  createBranch,
  updateBranch,
  type Branch,
} from "./branch.service.js";

export { BRANCH_STATUSES, type BranchStatus } from "./branch.model.js";
export { getBranchModel } from "./branch.model.js";
