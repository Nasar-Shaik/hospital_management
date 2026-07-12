/**
 * Module boundary enforcement (Doc 04 §2.4, Constitution §5, PLATFORM_STRATEGY §4).
 * These rules are release-gating; disabling them is forbidden (risk T4).
 */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Module dependency graph must stay acyclic (Constitution §5).",
      from: {},
      to: { circular: true },
    },
    {
      name: "api-modules-no-cross-internal-imports",
      severity: "error",
      comment:
        "Backend modules may import other modules ONLY via their index.ts public interface (Doc 04 §2.4).",
      from: { path: "^apps/api/src/modules/([^/]+)/" },
      to: {
        path: "^apps/api/src/modules/([^/]+)/(?!index\\.ts)",
        pathNot: "^apps/api/src/modules/$1/",
      },
    },
    {
      name: "frontend-never-imports-backend",
      severity: "error",
      comment: "Next.js is presentation-tier only (ADR-0012, ruling N9).",
      from: { path: "^apps/(web|admin)/" },
      to: { path: "^apps/(api|workers)/" },
    },
    {
      name: "packages-never-import-apps",
      severity: "error",
      comment: "Shared packages must stay app-agnostic (Doc 09 §1).",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "\\.(test|spec)\\.ts$|/dist/|/\\.next/" },
    tsPreCompilationDeps: true,
  },
};
