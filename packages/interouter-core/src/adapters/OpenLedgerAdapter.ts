import { keccak256, toHex } from "viem";
import type { Address, Hash, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainAdapter, RouteContext } from "../router.js";

// ---------------------------------------------------------------------------
// x402 protocol types
// ---------------------------------------------------------------------------

/**
 * Payment requirement returned in the HTTP 402 response body.
 * Mirrors the x402 spec as implemented by OpenLedger/DGrid.
 */
export interface PaymentRequirement {
  /** Payment scheme — "exact" means the full amount must be sent in one tx. */
  scheme: "exact";
  /** Chain network identifier, e.g. "bnb-testnet" or "openledger-l2". */
  network: string;
  /** Maximum payment amount in the token's smallest unit (string — avoids precision loss). */
  maxAmountRequired: string;
  /** URL of the inference resource being paid for. Used to derive inferenceId. */
  resource: string;
  /** Human-readable description of the payment. */
  description: string;
  /** MIME type of the resource. */
  mimeType: string;
  /** EVM address to send the payment to. */
  payTo: Address;
  /** Seconds before the payment authorization expires. */
  maxTimeoutSeconds: number;
  /** ERC-20 token contract address (the verifyingContract in the EIP-712 domain). */
  asset: Address;
  extra?: { name: string; version: string };
}

/**
 * EIP-712 message for DGrid inference payments.
 *
 * Field naming matches the on-chain `InferencePayment` type defined in the
 * DGrid payment contract — any rename here is a signing mismatch.
 */
export interface TransferAuthorization {
  /** Wallet address funding the payment. */
  from: Address;
  /** DGrid payment recipient address. */
  recipient: Address;
  /** Payment amount in the token's smallest unit. */
  amount: bigint;
  /** 32-byte random nonce — prevents replay. */
  nonce: Hex;
  /** keccak256 hash of the inference resource URL — ties the payment to one task. */
  inferenceId: Hex;
  /** Unix timestamp — authorization not valid before this second. */
  validAfter: bigint;
  /** Unix timestamp — authorization expires after this second. */
  validBefore: bigint;
}

/**
 * Encoded payment sent as the `X-PAYMENT` header on the retry request.
 */
export interface PaymentPayload {
  x402Version: 1;
  scheme: PaymentRequirement["scheme"];
  network: PaymentRequirement["network"];
  payload: {
    signature: Hex;
    authorization: TransferAuthorization;
  };
}

// ---------------------------------------------------------------------------
// x402 state machine
//
// A discriminated union tracks every stage of the payment flow so the frontend
// can render a live progress indicator without extra state management.
// ---------------------------------------------------------------------------

export type PaymentFlowStage =
  | { status: "idle" }
  | { status: "payment_required"; requirement: PaymentRequirement }
  | { status: "signing"; requirement: PaymentRequirement; authorization: TransferAuthorization }
  | { status: "submitting"; requirement: PaymentRequirement; payload: PaymentPayload }
  | { status: "complete"; txHash: Hash; amountPaid: string; tokenAddress: Address }
  | { status: "failed"; reason: string };

// ---------------------------------------------------------------------------
// EIP-712 schema — DGrid Inference Payment
//
// IMPORTANT: field names and types must match the on-chain verifier exactly.
// Any deviation produces an invalid signature.
// ---------------------------------------------------------------------------

const DGRID_PAYMENT_DOMAIN_NAME = "DGrid Inference Payment";
const DGRID_PAYMENT_DOMAIN_VERSION = "1";

const DGRID_EIP712_TYPES = {
  InferencePayment: [
    { name: "from",        type: "address" },
    { name: "recipient",   type: "address" },
    { name: "amount",      type: "uint256" },
    { name: "nonce",       type: "bytes32" },
    { name: "inferenceId", type: "bytes32" },
    { name: "validAfter",  type: "uint256" },
    { name: "validBefore", type: "uint256" },
  ],
} as const;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OpenLedgerAdapterConfig {
  /** AI inference endpoint URL. Receives the initial request and potential 402. */
  inferenceEndpoint: string;
  /** OpenLedger L2 / BNB chain ID. */
  chainId: number;
  /** EVM JSON-RPC URL for the payment chain. */
  rpcUrl: string;
  /** Address of the wallet funding inference payments. */
  signerAddress: Address;
  /**
   * Hex-encoded private key for signing EIP-712 authorizations.
   * When omitted, falls back to process.env.OPENLEDGER_PRIVATE_KEY.
   * Never hardcode this value — always load from an environment variable.
   */
  privateKey?: Hex;
}

// ---------------------------------------------------------------------------
// Result state stored in RouteResult.chainState["openledger"]
// ---------------------------------------------------------------------------

export interface OpenLedgerState {
  /** Final parsed inference result. Null when no payment succeeded. */
  inferenceResult: unknown | null;
  /** Transaction hash of the payment, or null when no payment was required. */
  paymentTxHash: Hash | null;
  /** Amount paid in the token's smallest unit. "0" when no payment was required. */
  amountPaid: string;
  /** ERC-20 token contract used for payment, or null when free. */
  tokenAddress: Address | null;
  /** Full stage snapshot for UI progress rendering. */
  flow: PaymentFlowStage;
}

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

export class OpenLedgerAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenLedgerAdapterError";
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenLedgerAdapter implements ChainAdapter<OpenLedgerState> {
  readonly id = "openledger";
  private readonly config: OpenLedgerAdapterConfig;
  private readonly account: ReturnType<typeof privateKeyToAccount>;

  constructor(config: OpenLedgerAdapterConfig) {
    this.config = config;

    // Resolve private key — config takes precedence over env var.
    const rawKey = config.privateKey ?? process.env["OPENLEDGER_PRIVATE_KEY"];
    if (!rawKey) {
      throw new OpenLedgerAdapterError(
        "OpenLedgerAdapter: private key is required. " +
        "Set config.privateKey or the OPENLEDGER_PRIVATE_KEY environment variable.",
      );
    }
    const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex;
    this.account = privateKeyToAccount(privateKey);
  }

  /**
   * Runs the full x402 payment state machine:
   *
   *   1. Send inference request → may receive 402.
   *   2. Parse PaymentRequirement from the 402 body.
   *   3. Build TransferAuthorization and sign via EIP-712.
   *   4. Encode PaymentPayload and retry with X-PAYMENT header.
   *   5. Return inference result + payment receipt.
   *
   * Signing errors are caught and returned as a `failed` flow stage — this
   * method never throws.
   */
  async fetchState(context: RouteContext): Promise<OpenLedgerState> {
    // Stage 1 — initial inference request.
    const initialResponse = await this.makeInferenceRequest(context, null);

    if (initialResponse.status !== 402) {
      const result: unknown = await initialResponse.json();
      return this.buildFreeResult(result);
    }

    // Stage 2 — parse payment requirement from 402 body.
    const requirement = await this.parsePaymentRequirement(initialResponse);

    // Stage 3 — build authorization and sign. Signing errors → failed stage.
    const authorization = this.buildAuthorization(requirement);
    let signature: Hex;
    try {
      signature = await this.signAuthorization(authorization, requirement);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        inferenceResult: null,
        paymentTxHash: null,
        amountPaid: "0",
        tokenAddress: requirement.asset,
        flow: { status: "failed", reason },
      };
    }

    // Stage 4 — encode payload and retry with X-PAYMENT header.
    const payload: PaymentPayload = {
      x402Version: 1,
      scheme: requirement.scheme,
      network: requirement.network,
      payload: { signature, authorization },
    };

    const paidResponse = await this.makeInferenceRequest(context, payload);

    if (!paidResponse.ok) {
      return {
        inferenceResult: null,
        paymentTxHash: null,
        amountPaid: "0",
        tokenAddress: requirement.asset,
        flow: {
          status: "failed",
          reason: `Inference request failed after payment: HTTP ${paidResponse.status}`,
        },
      };
    }

    // Stage 5 — return inference result + payment receipt.
    const inferenceResult: unknown = await paidResponse.json();
    const txHash = (paidResponse.headers.get("X-PAYMENT-TX-HASH") ?? "0x0") as Hash;

    return {
      inferenceResult,
      paymentTxHash: txHash,
      amountPaid: requirement.maxAmountRequired,
      tokenAddress: requirement.asset,
      flow: {
        status: "complete",
        txHash,
        amountPaid: requirement.maxAmountRequired,
        tokenAddress: requirement.asset,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private makeInferenceRequest(
    context: RouteContext,
    payment: PaymentPayload | null,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (payment !== null) {
      headers["X-PAYMENT"] = btoa(JSON.stringify(payment));
    }
    return fetch(this.config.inferenceEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: context.path, params: context.params }),
    });
  }

  private async parsePaymentRequirement(response: Response): Promise<PaymentRequirement> {
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("accepts" in body) ||
      !Array.isArray((body as { accepts: unknown }).accepts) ||
      (body as { accepts: unknown[] }).accepts.length === 0
    ) {
      throw new OpenLedgerAdapterError("402 response body missing valid payment requirement");
    }
    return (body as { accepts: PaymentRequirement[] }).accepts[0] as PaymentRequirement;
  }

  private buildAuthorization(requirement: PaymentRequirement): TransferAuthorization {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    return {
      from: this.config.signerAddress,
      recipient: requirement.payTo,
      amount: BigInt(requirement.maxAmountRequired),
      nonce: ("0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")) as Hex,
      // Deterministic per-resource ID — keccak256 of the inference endpoint URL.
      inferenceId: keccak256(toHex(requirement.resource)),
      validAfter: nowSec - 60n,
      validBefore: nowSec + BigInt(requirement.maxTimeoutSeconds),
    };
  }

  /**
   * Signs a DGrid InferencePayment using EIP-712 typed data.
   *
   * Domain: { name, version, chainId, verifyingContract: requirement.asset }
   * Type:   InferencePayment — see DGRID_EIP712_TYPES above.
   *
   * Uses privateKeyToAccount so signing is fully offline — no RPC call needed.
   */
  private async signAuthorization(
    authorization: TransferAuthorization,
    requirement: PaymentRequirement,
  ): Promise<Hex> {
    const domain = {
      name: DGRID_PAYMENT_DOMAIN_NAME,
      version: DGRID_PAYMENT_DOMAIN_VERSION,
      chainId: this.config.chainId,
      verifyingContract: requirement.asset,
    } as const;

    const message = {
      from:        authorization.from,
      recipient:   authorization.recipient,
      amount:      authorization.amount,
      nonce:       authorization.nonce,
      inferenceId: authorization.inferenceId,
      validAfter:  authorization.validAfter,
      validBefore: authorization.validBefore,
    };

    return this.account.signTypedData({
      domain,
      types: DGRID_EIP712_TYPES,
      primaryType: "InferencePayment",
      message,
    });
  }

  private buildFreeResult(inferenceResult: unknown): OpenLedgerState {
    return {
      inferenceResult,
      paymentTxHash: null,
      amountPaid: "0",
      tokenAddress: null,
      flow: { status: "idle" },
    };
  }
}
