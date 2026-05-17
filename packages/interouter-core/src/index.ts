/**
 * @decision3/interouter-core
 *
 * Public API surface. Import everything you need from this single entrypoint.
 */

export {
  InterouterRouter,
} from "./router.js";

export type {
  AdapterError,
  ChainAdapter,
  InferenceProvider,
  RouteContext,
  RouteResult,
  RouterConfig,
} from "./router.js";
