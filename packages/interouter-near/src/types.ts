import type { RouteContext } from "@decision3/interouter-core";

export type { RouteContext };

// ---------------------------------------------------------------------------
// Adapter configuration
// ---------------------------------------------------------------------------

export interface ViewCallConfig {
  contractId: string;
  methodName: string;
  /** JSON-serialisable args forwarded to the view function. */
  args?: Record<string, unknown>;
}

export interface NearAdapterConfig {
  networkId: "mainnet" | "testnet";
  /** NEAR RPC endpoint URL, e.g. "https://rpc.mainnet.near.org" */
  nodeUrl: string;
  /**
   * Fixed account ID to query. When omitted, fetchState() falls back to
   * context.walletAddress. If neither is present a NearAdapterError is thrown.
   */
  accountId?: string;
  /** Optional view-function calls to fan out alongside the account query. */
  viewCalls?: ViewCallConfig[];
}

// ---------------------------------------------------------------------------
// State shape returned by fetchState()
// ---------------------------------------------------------------------------

export interface NearBalance {
  /** Total balance in yoctoNEAR (string — too large for JS number). */
  total: string;
  /** Liquid available balance in yoctoNEAR. */
  available: string;
  /** Staked balance in yoctoNEAR. */
  staked: string;
}

export interface NearViewResult {
  error: true;
  reason: string;
}

export interface NearState {
  accountId: string;
  balance: NearBalance;
  /** On-chain storage consumed in bytes. */
  storageUsage: number;
  /**
   * SHA-256 hash of the deployed contract WASM.
   * All-ones string ("11111...") indicates no contract is deployed.
   */
  codeHash: string;
  /**
   * View-function results keyed by "contractId::methodName".
   * Individual call failures are stored as NearViewResult, not thrown.
   */
  viewResults: Record<string, unknown | NearViewResult>;
}

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

export class NearAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NearAdapterError";
  }
}
