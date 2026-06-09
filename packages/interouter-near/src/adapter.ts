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
import {
  JsonRpcProvider,
  KeyPairSigner,
  KeyPair,
  createTransaction,
  actions,
  baseEncode,
  baseDecode,
  decodeTransaction,
  decodeSignedTransaction,
} from "near-api-js";
import type { KeyPairString, SignedTransaction } from "near-api-js";
import type { NearAdapterConfig, NearState } from "./types.js";
import { NearAdapterError } from "./types.js";
import { fetchAccountData, fetchViewCalls } from "./rpc.js";

// ---------------------------------------------------------------------------
// NEAR-specific payment payload types
// ---------------------------------------------------------------------------

/**
 * Extended PaymentPayload with NEAR-specific transaction data.
 * Contains an unsigned transaction ready for signing.
 */
export interface NearPaymentPayload extends PaymentPayload {
  /** Unsigned NEAR transaction (serialized as base64 for transport). */
  unsignedTxBase64: string;
  /** Sender account ID. */
  signerId: string;
  /** Receiver account ID. */
  receiverId: string;
  /** Amount in yoctoNEAR. */
  amount: string;
  /** Block hash used for transaction validity (base58). */
  blockHash: string;
  /** Nonce for replay protection. */
  nonce: string;
}

/**
 * Extended SignedPayload with NEAR-specific signed transaction.
 */
export interface NearSignedPayload extends SignedPayload {
  /** Signed transaction (serialized as base64). */
  signedTxBase64: string;
  /** Transaction hash (base58). */
  txHash: string;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class NearAdapter implements ChainAdapter<NearState> {
  readonly id = "near";
  private readonly config: NearAdapterConfig;
  private signer: KeyPairSigner | null = null;

  constructor(config: NearAdapterConfig) {
    this.config = config;

    // Initialize signer if private key is available.
    const rawKey = config.privateKey ?? process.env["NEAR_PRIVATE_KEY"];
    if (rawKey) {
      const keyPair = KeyPair.fromString(rawKey as KeyPairString);
      this.signer = new KeyPairSigner(keyPair);
    }
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

  // ---------------------------------------------------------------------------
  // Lifecycle: preparePayment
  // ---------------------------------------------------------------------------

  /**
   * Builds an unsigned NEAR native token transfer transaction.
   *
   * Requires:
   * - requirement.network to be "near:mainnet" or "near:testnet"
   * - requirement.maxAmountRequired in yoctoNEAR
   * - config.accountId or a receiver derived from the requirement
   *
   * Does NOT sign — returns an unsigned transaction payload.
   */
  async preparePayment(requirement: PaymentRequirement): Promise<NearPaymentPayload> {
    if (!this.signer) {
      throw new NearAdapterError(
        "NearAdapter: privateKey is required for payment operations. " +
        "Set config.privateKey or NEAR_PRIVATE_KEY environment variable.",
      );
    }

    // Extract receiver from requirement — expect format like "near:mainnet:receiver.near"
    // or a payTo field if extended requirement is used.
    const receiverId = this.extractReceiverId(requirement);
    const signerId = this.config.accountId;
    if (!signerId) {
      throw new NearAdapterError(
        "NearAdapter: accountId is required for payment operations — set it in config.",
      );
    }

    const provider = new JsonRpcProvider({ url: this.config.nodeUrl });
    const publicKey = await this.signer.getPublicKey();

    // Get access key nonce and latest block hash for transaction validity.
    const [accessKeyInfo, block] = await Promise.all([
      provider.viewAccessKey({
        accountId: signerId,
        publicKey: publicKey.toString(),
      }),
      provider.viewBlock({ finality: "final" }),
    ]);

    const nonce = accessKeyInfo.nonce + 1n;
    const blockHash = baseDecode(block.header.hash);

    // Build transfer action with the payment amount.
    const amount = BigInt(requirement.maxAmountRequired);
    const transferAction = actions.transfer(amount);

    // Create unsigned transaction.
    const transaction = createTransaction(
      signerId,
      publicKey,
      receiverId,
      nonce,
      [transferAction],
      blockHash,
    );

    // Serialize transaction for transport.
    const unsignedTxBase64 = Buffer.from(transaction.encode()).toString("base64");

    return {
      requirement,
      unsignedTxBase64,
      signerId,
      receiverId,
      amount: requirement.maxAmountRequired,
      blockHash: block.header.hash,
      nonce: nonce.toString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle: sign
  // ---------------------------------------------------------------------------

  /**
   * Signs the prepared NEAR transaction using the configured private key.
   * Returns a signed transaction ready for broadcast.
   */
  async sign(payload: PaymentPayload): Promise<NearSignedPayload> {
    if (!this.signer) {
      throw new NearAdapterError(
        "NearAdapter: privateKey is required for signing. " +
        "Set config.privateKey or NEAR_PRIVATE_KEY environment variable.",
      );
    }

    const nearPayload = payload as NearPaymentPayload;

    // Deserialize the unsigned transaction.
    const txBuffer = Buffer.from(nearPayload.unsignedTxBase64, "base64");
    const txBytes = new Uint8Array(txBuffer.buffer, txBuffer.byteOffset, txBuffer.byteLength);
    const transaction = decodeTransaction(txBytes);

    // Sign the transaction.
    const { txHash, signedTransaction } = await this.signer.signTransaction(transaction);

    // Serialize signed transaction and hash.
    const signedTxBase64 = Buffer.from(signedTransaction.encode()).toString("base64");
    const txHashBase58 = baseEncode(txHash);

    return {
      payload,
      signature: txHashBase58,
      signedTxBase64,
      txHash: txHashBase58,
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle: submit
  // ---------------------------------------------------------------------------

  /**
   * Broadcasts the signed transaction to the NEAR network.
   * Uses sendTransaction which waits for execution.
   */
  async submit(signed: SignedPayload, _context: RouteContext): Promise<SubmissionResult> {
    const nearSigned = signed as NearSignedPayload;

    // Deserialize the signed transaction.
    const signedTxBuffer = Buffer.from(nearSigned.signedTxBase64, "base64");
    const signedTxBytes = new Uint8Array(signedTxBuffer.buffer, signedTxBuffer.byteOffset, signedTxBuffer.byteLength);
    const signedTransaction: SignedTransaction = decodeSignedTransaction(signedTxBytes);

    const provider = new JsonRpcProvider({ url: this.config.nodeUrl });

    try {
      // Submit and wait for inclusion (not full finality).
      const result = await provider.sendTransaction(signedTransaction);

      // Check if transaction succeeded.
      const status = result.status;
      const isSuccess = typeof status === "object" && "SuccessValue" in status;

      return {
        accepted: isSuccess,
        txHash: nearSigned.txHash,
        requirement: signed.payload.requirement,
        responseData: result,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        accepted: false,
        txHash: nearSigned.txHash,
        requirement: signed.payload.requirement,
        responseData: `Transaction submission failed: ${reason}`,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle: awaitFinality
  // ---------------------------------------------------------------------------

  /**
   * Polls transaction status until finality is confirmed.
   * Returns the final adapter state after the payment is settled.
   */
  async awaitFinality(result: SubmissionResult): Promise<FinalityStatus<NearState>> {
    const signerId = this.config.accountId ?? "";

    if (!result.accepted || !result.txHash) {
      // Transaction was rejected — return failure state.
      return {
        finalized: false,
        txHash: result.txHash,
        state: await this.buildFailureState(signerId, result),
      };
    }

    const provider = new JsonRpcProvider({ url: this.config.nodeUrl });

    // Poll for FINAL status.
    const maxAttempts = 30;
    const pollIntervalMs = 1000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const txStatus = await provider.viewTransactionStatus({
          txHash: result.txHash,
          accountId: signerId,
          waitUntil: "FINAL",
        });

        const status = txStatus.status;
        const isSuccess = typeof status === "object" && "SuccessValue" in status;

        if (isSuccess) {
          // Refresh account state after successful payment.
          const accountData = await fetchAccountData(this.config, signerId);

          return {
            finalized: true,
            txHash: result.txHash,
            state: {
              accountId: signerId,
              balance: accountData.balance,
              storageUsage: accountData.storageUsage,
              codeHash: accountData.codeHash,
              viewResults: {},
            },
          };
        }

        // Transaction failed on-chain.
        if (typeof status === "object" && "Failure" in status) {
          return {
            finalized: true,
            txHash: result.txHash,
            state: await this.buildFailureState(signerId, result),
          };
        }
      } catch (err) {
        // Transaction not yet visible — continue polling.
        if (attempt < maxAttempts - 1) {
          await this.sleep(pollIntervalMs);
          continue;
        }
        throw err;
      }

      await this.sleep(pollIntervalMs);
    }

    throw new NearAdapterError(
      `NearAdapter: transaction ${result.txHash} did not reach finality within ${maxAttempts} attempts`,
    );
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Extracts receiver account ID from the payment requirement.
   * Expects either a `payTo` field or parses from network string.
   */
  private extractReceiverId(requirement: PaymentRequirement): string {
    // Check for payTo field (extended requirement).
    const extended = requirement as PaymentRequirement & { payTo?: string };
    if (extended.payTo) {
      return extended.payTo;
    }

    // Parse from network string: "near:mainnet:receiver.near" or "near:testnet:receiver.testnet"
    const parts = requirement.network.split(":");
    if (parts.length >= 3 && parts[2]) {
      return parts[2];
    }

    throw new NearAdapterError(
      "NearAdapter: cannot determine receiver — set payTo in requirement or use network format 'near:network:receiver'",
    );
  }

  private async buildFailureState(
    accountId: string,
    result: SubmissionResult,
  ): Promise<NearState> {
    try {
      const accountData = await fetchAccountData(this.config, accountId);
      return {
        accountId,
        balance: accountData.balance,
        storageUsage: accountData.storageUsage,
        codeHash: accountData.codeHash,
        viewResults: {
          paymentError: {
            error: true,
            reason: typeof result.responseData === "string"
              ? result.responseData
              : "Payment failed",
          },
        },
      };
    } catch {
      // Can't fetch account data — return minimal state.
      return {
        accountId,
        balance: { total: "0", available: "0", staked: "0" },
        storageUsage: 0,
        codeHash: "",
        viewResults: {
          paymentError: {
            error: true,
            reason: typeof result.responseData === "string"
              ? result.responseData
              : "Payment failed",
          },
        },
      };
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
