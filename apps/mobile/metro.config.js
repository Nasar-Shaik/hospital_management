/**
 * Metro, taught about the monorepo.
 *
 * Two changes over the default, both required by pnpm workspaces:
 *   1. `watchFolders` must include the repo root, or editing `packages/api-client` never triggers
 *      a reload — the file is outside the project directory Metro watches by default.
 *   2. Both `node_modules` directories must be resolvable. pnpm's isolated layout puts a package's
 *      own dependencies under `apps/mobile/node_modules` and hoists the workspace links to the
 *      root, so resolving only one of the two finds half the tree.
 *
 * `unstable_enableSymlinks` is on because pnpm links everything; Metro has supported it since
 * 0.73 and it is what makes the isolated (non-hoisted) layout work at all. If bundling ever fails
 * to resolve a transitive React Native dependency, the documented escape hatch is
 * `node-linker=hoisted` in the ROOT `.npmrc` — it is a workspace-wide setting, not a per-app one.
 */
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
config.resolver.unstable_enableSymlinks = true;
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
