/**
 * @decision3/interouter-core
 *
 * Public API surface. Import everything you need from this single entrypoint.
 */

// Router
export { InterouterRouter, NotSupportedError, BudgetExceededError } from "./router.js";
export type {
  AdapterError,
  ChainAdapter,
  FinalityStatus,
  InferenceProvider,
  PaymentPayload,
  PaymentRequirement,
  ReadResult,
  RouteContext,
  RouteResult,
  RouterConfig,
  SignedPayload,
  SubmissionResult,
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
  TransferAuthorization,
  X402PaymentRequirement,
  X402WirePayload,
} from "./adapters/OpenLedgerAdapter.js";
export { OpenLedgerAdapterError } from "./adapters/OpenLedgerAdapter.js";

export { OpenGradientAdapter } from "./adapters/OpenGradientAdapter.js";
export type {
  OpenGradientAdapterConfig,
  OpenGradientState,
  OpenGradientPaymentFlowStage,
  OpenGradientPaymentRequirement,
  PermitTransferFrom,
  OpenGradientWirePayload,
} from "./adapters/OpenGradientAdapter.js";
export { OpenGradientAdapterError } from "./adapters/OpenGradientAdapter.js";

export { AlgorandAdapter } from "./adapters/AlgorandAdapter.js";
