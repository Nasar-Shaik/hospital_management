/**
 * The reporting module's public face — only the router leaves it.
 *
 * This module owns no collection; it composes the reports the data-owning modules expose (see
 * `reporting.service.ts`). Nothing imports it back, so it sits at the top of the graph, like the
 * event consumer: a composition root, not a dependency.
 */
export { reportingRouter } from "./reporting.routes.js";
