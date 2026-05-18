/**
 * @decision3/interouter-core
 *
 * Public API surface. Import everything you need from this single entrypoint.
 */

// Router
export { InterouterRouter } from "./router.js";
export type {
  AdapterError,
  ChainAdapter,
  InferenceProvider,
  RouteContext,
  RouteResult,
  RouterConfig,
} from "./router.js";

// Built-in adapters
export { NearAdapter } from "./adapters/NearAdapter.js";
export type {
  NearAdapterConfig,
  NearAccountState,
  NearBalance,
} from "./adapters/NearAdapter.js";
export { NearAdapterError } from "./adapters/NearAdapter.js";

export { OpenLedgerAdapter } from "./adapters/OpenLedgerAdapter.js";
export type {
  OpenLedgerAdapterConfig,
  OpenLedgerState,
  PaymentFlowStage,
  PaymentPayload,
  PaymentRequirement,
  TransferAuthorization,
} from "./adapters/OpenLedgerAdapter.js";
export { OpenLedgerAdapterError } from "./adapters/OpenLedgerAdapter.js";
