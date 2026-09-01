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
      name: "mobile-imports-packages-only",
      severity: "error",
      comment:
        "apps/mobile may reach shared packages and nothing else (M0 §4). Reaching into another " +
        "app would fork the API contract or the UI, which is the failure the shared packages exist " +
        "to prevent — and it would drag Node-only code into a React Native bundle.",
      from: { path: "^apps/mobile/" },
      to: { path: "^apps/(api|web|admin|workers)/" },
    },
    {
      name: "mobile-platform-modules-stay-at-the-edge",
      severity: "error",
      comment:
        "Native modules belong in apps/mobile/src/platform. `src/lib` holds the session, branch " +
        "and error logic, `src/clinical` holds the M2 domain rules, and both are testable in Node " +
        "precisely because they depend on the storage PORTS rather than on Keychain — importing a " +
        "native module there would end that.",
      from: { path: "^apps/mobile/src/(lib|state|query|navigation|clinical)/" },
      to: { path: "^apps/mobile/src/platform/" },
    },
    {
      name: "mobile-domain-logic-stays-out-of-react",
      severity: "error",
      comment:
        "`src/clinical` is the M2 domain layer: status labels, the release gate, critical-result " +
        "rules, the timeline merge. It must not import React, React Native or a component, because " +
        "the moment it does those rules can only be tested by rendering — and this suite runs in " +
        "Node with no simulator, which is the whole reason the rules are testable at all.",
      from: { path: "^apps/mobile/src/(lib|state|query|navigation|clinical)/" },
      to: { path: "^apps/mobile/src/(components|hooks|providers)/" },
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
