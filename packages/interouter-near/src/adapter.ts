import type {
  ChainAdapter,
  ReadResult,
  PaymentRequirement,
  PaymentPayload,
  SignedPayload,
  SubmissionResult,
  FinalityStatus,
  RouteContext,
} from "@decision3/interouter-core";
import { NotSupportedError } from "@decision3/interouter-core";
import type { NearAdapterConfig, NearState } from "./types.js";
import { NearAdapterError } from "./types.js";
import { fetchAccountData, fetchViewCalls } from "./rpc.js";

export class NearAdapter implements ChainAdapter<NearState> {
  readonly id = "near";
  private readonly config: NearAdapterConfig;

  constructor(config: NearAdapterConfig) {
    this.config = config;
  }

  async readState(context: RouteContext): Promise<ReadResult<NearState>> {
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
      state: {
        accountId,
        balance: accountData.balance,
        storageUsage: accountData.storageUsage,
        codeHash: accountData.codeHash,
        viewResults,
      },
      paymentRequired: null,
    };
  }

  async preparePayment(_requirement: PaymentRequirement): Promise<PaymentPayload> {
    throw new NotSupportedError(this.id, "preparePayment");
  }

  async sign(_payload: PaymentPayload): Promise<SignedPayload> {
    throw new NotSupportedError(this.id, "sign");
  }

  async submit(_signed: SignedPayload, _context: RouteContext): Promise<SubmissionResult> {
    throw new NotSupportedError(this.id, "submit");
  }

  async awaitFinality(_result: SubmissionResult): Promise<FinalityStatus<NearState>> {
    throw new NotSupportedError(this.id, "awaitFinality");
  }
}
