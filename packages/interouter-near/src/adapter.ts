import type { ChainAdapter, RouteContext } from "@decision3/interouter-core";
import type { NearAdapterConfig, NearState } from "./types.js";
import { NearAdapterError } from "./types.js";
import { fetchAccountData, fetchViewCalls } from "./rpc.js";

export class NearAdapter implements ChainAdapter<NearState> {
  readonly id = "near";
  private readonly config: NearAdapterConfig;

  constructor(config: NearAdapterConfig) {
    this.config = config;
  }

  async fetchState(context: RouteContext): Promise<NearState> {
    const accountId = this.config.accountId ?? context.walletAddress;
    if (accountId === undefined || accountId === "") {
      throw new NearAdapterError(
        "NearAdapter: accountId is required — provide it in config or via context.walletAddress",
      );
    }

    const viewCalls = this.config.viewCalls ?? [];

    // Account data and view calls are independent — run in parallel.
    const [accountData, viewResults] = await Promise.all([
      fetchAccountData(this.config, accountId),
      viewCalls.length > 0 ? fetchViewCalls(this.config, viewCalls) : Promise.resolve({}),
    ]);

    return {
      accountId,
      balance: accountData.balance,
      storageUsage: accountData.storageUsage,
      codeHash: accountData.codeHash,
      viewResults,
    };
  }
}
