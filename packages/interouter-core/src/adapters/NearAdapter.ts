import { JsonRpcProvider } from "near-api-js";
import type { ChainAdapter, RouteContext } from "../router.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface NearAdapterConfig {
  networkId: "mainnet" | "testnet";
  /** NEAR RPC endpoint, e.g. "https://rpc.mainnet.near.org" */
  nodeUrl: string;
  /**
   * Fixed account to query. When omitted, fetchState() falls back to
   * context.walletAddress. Throws NearAdapterError if neither is present.
   */
  accountId?: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface NearBalance {
  /** Total balance in yoctoNEAR (string — value exceeds JS number precision). */
  total: string;
  /** Liquid available balance in yoctoNEAR. */
  available: string;
  /** Staked / locked balance in yoctoNEAR. */
  staked: string;
}

export interface NearAccountState {
  accountId: string;
  balance: NearBalance;
  /** On-chain storage consumed, in bytes. */
  storageUsage: number;
  /**
   * SHA-256 hash of the deployed contract WASM.
   * All-ones string ("11111...") means no contract is deployed.
   */
  codeHash: string;
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

// ---------------------------------------------------------------------------
// Internal RPC types
// ---------------------------------------------------------------------------

interface AccountView {
  amount: string;
  locked: string;
  storage_usage: number;
  code_hash: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class NearAdapter implements ChainAdapter<NearAccountState> {
  readonly id = "near";
  private readonly config: NearAdapterConfig;

  constructor(config: NearAdapterConfig) {
    this.config = config;
  }

  async fetchState(context: RouteContext): Promise<NearAccountState> {
    const accountId = this.config.accountId ?? context.walletAddress;
    if (accountId === undefined || accountId === "") {
      throw new NearAdapterError(
        "NearAdapter: accountId is required — set it in config or provide context.walletAddress",
      );
    }

    const provider = new JsonRpcProvider({ url: this.config.nodeUrl });

    const view = await provider.query<AccountView>({
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });

    const total = view.amount;
    const staked = view.locked;
    const available = (BigInt(total) - BigInt(staked)).toString();

    return {
      accountId,
      balance: { total, available, staked },
      storageUsage: view.storage_usage,
      codeHash: view.code_hash,
    };
  }
}
