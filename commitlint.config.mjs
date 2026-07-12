/**
 * Conventional Commits enforcement (Doc 09 §17).
 * <type>(<scope>): <imperative summary ≤ 72 chars>
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "refactor", "perf", "test", "docs", "chore", "build", "ci"],
    ],
    "header-max-length": [2, "always", 72],
  },
};
