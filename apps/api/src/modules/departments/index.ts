/**
 * Departments module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5, Modules B2/B3).
 *
 * Owns the STORE of a tenant's organisational units and their hierarchy. A leaf master, like
 * `branches` — it depends on nothing operational, and nothing operational depends on it:
 * `encounters` carries a `departmentId` string it treats as opaque, so it never imports this
 * module. The graph stays acyclic.
 */
export { departmentRouter } from "./department.routes.js";

export {
  listDepartments,
  getDepartment,
  createDepartment,
  updateDepartment,
  type Department,
} from "./department.service.js";

export {
  DEPARTMENT_KINDS,
  DEPARTMENT_STATUSES,
  type DepartmentKind,
  type DepartmentStatus,
} from "./department.model.js";
