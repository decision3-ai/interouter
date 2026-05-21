/**
 * OpenLedger / DGrid inference adapter — x402 payment protocol.
 *
 * @custodial-mvp
 *   Server currently holds the signing key via:
 *     process.env.OPENLEDGER_PRIVATE_KEY
 *   All EIP-712 signing happens server-side using viem's privateKeyToAccount.
 *   The private key MUST be loaded from an environment variable — never hardcoded.
 *   This is acceptable for an MVP but carries full custodial risk: if the
 *   server is compromised, the signing key is exposed.
 *
 * @v2-migration
 *   Future architecture migrates to:
 *     NEAR-backed delegated session keys
 *   The user's NEAR wallet issues a time-bounded, scope-limited session key
 *   that the server can use for signing without holding the master key.
 *   This eliminates server-side custodial risk entirely.
 */

import { keccak256, toHex } from "viem";
import type { Address, Hash, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type {
  ChainAdapter,
  ReadResult,
  PaymentRequirement,
  PaymentPayload,
  SignedPayload,
  SubmissionResult,
  FinalityStatus,
  RouteContext,
} from "../router.js";

// ---------------------------------------------------------------------------
// x402 protocol types
// ---------------------------------------------------------------------------

/**
 * Payment requirement returned in the HTTP 402 response body.
 * Mirrors the x402 spec as implemented by OpenLedger/DGrid.
 * Extends the base PaymentRequirement with x402-specific fields.
 */
export interface X402PaymentRequirement extends PaymentRequirement {
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
 * Internal wire format for the x402 protocol — not part of the public lifecycle API.
 */
export interface X402WirePayload {
  x402Version: 1;
  scheme: X402PaymentRequirement["scheme"];
  network: X402PaymentRequirement["network"];
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
  | { status: "payment_required"; requirement: X402PaymentRequirement }
  | { status: "signing"; requirement: X402PaymentRequirement; authorization: TransferAuthorization }
  | { status: "submitting"; requirement: X402PaymentRequirement; payload: X402WirePayload }
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

  // ---------------------------------------------------------------------------
  // Lifecycle: readState
  // ---------------------------------------------------------------------------

  /**
   * Sends the initial inference request.
   *
   * - HTTP 200 → returns the inference result with no payment required.
   * - HTTP 402 → parses the x402 PaymentRequirement and signals it to the router.
   *
   * No signing or payment occurs here — this is a pure read operation.
   */
  async readState(context: RouteContext): Promise<ReadResult<OpenLedgerState>> {
    const response = await this.makeInferenceRequest(context, null);

    if (response.status !== 402) {
      const result: unknown = await response.json();
      return {
        state: this.buildFreeResult(result),
        paymentRequired: null,
      };
    }

    const requirement = await this.parsePaymentRequirement(response);
    return {
      state: {
        inferenceResult: null,
        paymentTxHash: null,
        amountPaid: "0",
        tokenAddress: requirement.asset,
        flow: { status: "payment_required", requirement },
      },
      paymentRequired: requirement,
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle: preparePayment
  // ---------------------------------------------------------------------------

  /**
   * Builds an unsigned TransferAuthorization from the x402 payment requirement.
   *
   * Determines: from address, recipient, amount, nonce, inferenceId, validity window.
   * Does NOT sign — the authorization is returned as part of the PaymentPayload
   * for explicit signing in the next stage.
   */
  async preparePayment(requirement: PaymentRequirement): Promise<PaymentPayload> {
    const x402Req = requirement as X402PaymentRequirement;
    const authorization = this.buildAuthorization(x402Req);
    const result = { requirement, authorization };
    return result;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle: sign
  // ---------------------------------------------------------------------------

  /**
   * Signs the prepared TransferAuthorization using EIP-712 typed data.
   *
   * Signing key: this.account (derived from OPENLEDGER_PRIVATE_KEY).
   * Domain: { name: "DGrid Inference Payment", version: "1", chainId, verifyingContract: asset }.
   * Type: InferencePayment — see DGRID_EIP712_TYPES.
   *
   * Signing is fully offline — no RPC call needed.
   * Throws on signing failure (e.g. domain separator mismatch).
   */
  async sign(payload: PaymentPayload): Promise<SignedPayload> {
    const olPayload = payload as PaymentPayload & { authorization: TransferAuthorization };
    const x402Req = payload.requirement as X402PaymentRequirement;

    const signature = await this.signAuthorization(olPayload.authorization, x402Req);
    return { payload, signature };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle: submit
  // ---------------------------------------------------------------------------

  /**
   * Encodes the signed authorization as an x402 X-PAYMENT header and retries
   * the inference request.
   *
   * On success (HTTP 2xx): returns accepted=true with the inference response.
   * On failure: returns accepted=false with the error reason.
   */
  async submit(signed: SignedPayload, context: RouteContext): Promise<SubmissionResult> {
    const olPayload = signed.payload as PaymentPayload & { authorization: TransferAuthorization };
    const x402Req = signed.payload.requirement as X402PaymentRequirement;

    const wirePayload: X402WirePayload = {
      x402Version: 1,
      scheme: x402Req.scheme,
      network: x402Req.network,
      payload: {
        signature: signed.signature as Hex,
        authorization: olPayload.authorization,
      },
    };

    const paidResponse = await this.makeInferenceRequest(context, wirePayload);

    if (!paidResponse.ok) {
      return {
        accepted: false,
        txHash: null,
        requirement: signed.payload.requirement,
        responseData: `Inference request failed after payment: HTTP ${paidResponse.status}`,
      };
    }

    const inferenceResult: unknown = await paidResponse.json();
    const txHash = (paidResponse.headers.get("X-PAYMENT-TX-HASH") ?? "0x0") as Hash;

    return {
      accepted: true,
      txHash,
      requirement: signed.payload.requirement,
      responseData: inferenceResult,
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle: awaitFinality
  // ---------------------------------------------------------------------------

  /**
   * x402 payments are verified atomically on submission — the server validates
   * the EIP-712 signature and settles inline. No separate finality wait.
   *
   * Builds the final OpenLedgerState from the submission result.
   */
  async awaitFinality(result: SubmissionResult): Promise<FinalityStatus<OpenLedgerState>> {
    const x402Req = result.requirement as X402PaymentRequirement;

    if (result.accepted) {
      return {
        finalized: true,
        txHash: result.txHash,
        state: {
          inferenceResult: result.responseData,
          paymentTxHash: result.txHash as Hash,
          amountPaid: x402Req.maxAmountRequired,
          tokenAddress: x402Req.asset,
          flow: {
            status: "complete",
            txHash: result.txHash as Hash,
            amountPaid: x402Req.maxAmountRequired,
            tokenAddress: x402Req.asset,
          },
        },
      };
    }

    return {
      finalized: true,
      txHash: null,
      state: {
        inferenceResult: null,
        paymentTxHash: null,
        amountPaid: "0",
        tokenAddress: x402Req.asset,
        flow: {
          status: "failed",
          reason: typeof result.responseData === "string"
            ? result.responseData
            : "Payment submission failed",
        },
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private makeInferenceRequest(
    context: RouteContext,
    payment: X402WirePayload | null,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (payment !== null) {
      // bigint fields (amount, validAfter, validBefore) must be serialised as
      // decimal strings — JSON.stringify throws on bigint by default.
      headers["X-PAYMENT"] = btoa(
        JSON.stringify(payment, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
      );
    }
    return fetch(this.config.inferenceEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: context.path, params: context.params }),
    });
  }

  private async parsePaymentRequirement(response: Response): Promise<X402PaymentRequirement> {
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
    return (body as { accepts: X402PaymentRequirement[] }).accepts[0] as X402PaymentRequirement;
  }

  private buildAuthorization(requirement: X402PaymentRequirement): TransferAuthorization {
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
    requirement: X402PaymentRequirement,
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
