/**
 * @decision3/interouter-near
 *
 * NEAR Protocol chain adapter for @decision3/interouter-core.
 */

export { NearAdapter } from "./adapter.js";
export type { NearPaymentPayload, NearSignedPayload } from "./adapter.js";
export { NearAdapterError } from "./types.js";

export type {
  NearAdapterConfig,
  NearBalance,
  NearState,
  NearViewResult,
  ViewCallConfig,
} from "./types.js";
