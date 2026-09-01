/**
 * API keys module — PUBLIC INTERFACE (Doc 04 §2.4, Constitution §5, Module A9).
 *
 * Issues, lists and revokes a hospital's API keys, and resolves a presented key to the user it
 * acts as. Depends on nothing operational; the `authenticate` middleware depends on it (for
 * `resolveApiKey`), exactly as `authorize` depends on `rbac`.
 *
 * The ROUTER is deliberately NOT re-exported here (app.ts imports it from `apiKey.routes.js`
 * directly, like `rbacRouter`): the router imports `authenticate`, so exposing it through this
 * index — which `authenticate` itself imports — would form an import cycle. The index stays the
 * router-free public interface.
 */
export {
  listApiKeys,
  createApiKey,
  revokeApiKey,
  resolveApiKey,
  API_KEY_PREFIX,
  type ApiKeyMeta,
  type CreatedApiKey,
} from "./apiKey.service.js";
