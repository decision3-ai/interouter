import { JsonRpcProvider, yoctoToNear } from "near-api-js";
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
  /** Total balance in yoctoNEAR (raw string — exceeds JS number precision). */
  total: string;
  /** Liquid available balance in yoctoNEAR. */
  available: string;
  /** Staked / locked balance in yoctoNEAR. */
  staked: string;
  /** Total balance as a human-readable NEAR decimal string, e.g. "10.5". */
  totalNear: string;
  /** Available balance as a human-readable NEAR decimal string. */
  availableNear: string;
  /** Staked balance as a human-readable NEAR decimal string. */
  stakedNear: string;
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
// Address validation
//
// NEAR supports two account ID formats:
//   Implicit  — exactly 64 lowercase hex characters (public key as hex).
//   Named     — 2–64 chars, lowercase alnum + _ - ., must start and end with
//               an alphanumeric character.
// ---------------------------------------------------------------------------

const IMPLICIT_ACCOUNT_RE = /^[0-9a-f]{64}$/;
const NAMED_ACCOUNT_RE    = /^[a-z0-9]([a-z0-9_.\\-]*[a-z0-9])?$/;

export function isValidNearAccountId(id: string): boolean {
  if (id.length < 2 || id.length > 64) return false;
  if (id.length === 64 && IMPLICIT_ACCOUNT_RE.test(id)) return true;
  return NAMED_ACCOUNT_RE.test(id);
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

    if (!isValidNearAccountId(accountId)) {
      throw new NearAdapterError(
        `NearAdapter: invalid account ID "${accountId}" — ` +
        "must be a named account (2–64 chars, lowercase alnum + _ - .) " +
        "or a 64-character hex implicit address",
      );
    }

    const provider = new JsonRpcProvider({ url: this.config.nodeUrl });

    const view = await provider.query<AccountView>({
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });

    const total     = view.amount;
    const staked    = view.locked;
    const available = (BigInt(total) - BigInt(staked)).toString();

    return {
      accountId,
      balance: {
        total,
        available,
        staked,
        totalNear:     yoctoToNear(BigInt(total)),
        availableNear: yoctoToNear(BigInt(available)),
        stakedNear:    yoctoToNear(BigInt(staked)),
      },
      storageUsage: view.storage_usage,
      codeHash: view.code_hash,
    };
  }
}
