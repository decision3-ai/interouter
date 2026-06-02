/**
 * OpenGradient inference adapter — x402 payment protocol on Base Sepolia.
 *
 * Chain:   Base Sepolia testnet (chainId: 84532)
 * Token:   $OPG — testnet: 0x240b09731D96979f50B2C649C9CE10FcF9C7987F
 * Signing: Permit2 PermitTransferFrom (EIP-712)
 * Header:  PAYMENT-SIGNATURE (x402 v2)
 *
 * @custodial-mvp
 *   Server holds the signing key via:
 *     process.env.OPENGRADIENT_PRIVATE_KEY
 *   All EIP-712 signing happens server-side using viem's privateKeyToAccount.
 *   Same custodial risk as OpenLedgerAdapter — full key exposure on server compromise.
 *
 * @v2-migration
 *   Future architecture migrates to NEAR-backed delegated session keys,
 *   eliminating server-side custodial risk entirely.
 */

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
// Constants
// ---------------------------------------------------------------------------

const BASE_SEPOLIA_CHAIN_ID = 84532;
const OPENGRADIENT_ENDPOINT = "https://llm.opengradient.ai";

/** $OPG ERC-20 on Base Sepolia testnet. */
const OPG_TOKEN_TESTNET = "0x240b09731D96979f50B2C649C9CE10FcF9C7987F" as Address;

/** Permit2 singleton — same address on all EVM chains. */
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;

// ---------------------------------------------------------------------------
// Protocol types
// ---------------------------------------------------------------------------

/**
 * Payment requirement from the HTTP 402 body.
 * Parsed from body.accepts[0].
 */
export interface OpenGradientPaymentRequirement extends PaymentRequirement {
  resource: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  asset: Address;
  extra?: { name: string; version: string };
}

/**
 * Permit2 PermitTransferFrom message — signed via EIP-712.
 *
 * Domain: { name: "Permit2", chainId: 84532, verifyingContract: PERMIT2_ADDRESS }
 * No `version` field in Permit2 domain.
 */
export interface PermitTransferFrom {
  permitted: { token: Address; amount: bigint };
  spender: Address;
  /** Unordered uint256 nonce — random, collision probability negligible. */
  nonce: bigint;
  deadline: bigint;
}

/** Encoded payment sent as the `PAYMENT-SIGNATURE` header on the retry request. */
export interface OpenGradientWirePayload {
  x402Version: 1;
  scheme: string;
  network: string;
  payload: {
    signature: Hex;
    permit: PermitTransferFrom;
  };
}

// ---------------------------------------------------------------------------
// Payment flow state machine
// ---------------------------------------------------------------------------

export type OpenGradientPaymentFlowStage =
  | { status: "idle" }
  | { status: "payment_required"; requirement: OpenGradientPaymentRequirement }
  | { status: "signing"; requirement: OpenGradientPaymentRequirement; permit: PermitTransferFrom }
  | { status: "submitting"; requirement: OpenGradientPaymentRequirement; payload: OpenGradientWirePayload }
  | { status: "complete"; txHash: Hash; amountPaid: string; tokenAddress: Address }
  | { status: "failed"; reason: string };

// ---------------------------------------------------------------------------
// EIP-712 schema — Permit2 PermitTransferFrom
//
// IMPORTANT: field order, names, and types must match the Permit2 contract exactly.
// Any deviation produces an invalid signature.
// ---------------------------------------------------------------------------

const PERMIT2_EIP712_TYPES = {
  PermitTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender",   type: "address" },
    { name: "nonce",     type: "uint256" },
    { name: "deadline",  type: "uint256" },
  ],
  TokenPermissions: [
    { name: "token",  type: "address" },
    { name: "amount", type: "uint256" },
  ],
} as const;

// ---------------------------------------------------------------------------
// Config / State / Error
// ---------------------------------------------------------------------------

export interface OpenGradientAdapterConfig {
  /** OpenGradient inference endpoint. Defaults to https://llm.opengradient.ai */
  inferenceEndpoint?: string;
  /** Chain ID. Defaults to 84532 (Base Sepolia testnet). */
  chainId?: number;
  /** EVM JSON-RPC URL for the payment chain. */
  rpcUrl: string;
  /** Address of the wallet funding inference payments. */
  signerAddress: Address;
  /**
   * Hex-encoded private key for signing Permit2 authorizations.
   * When omitted, falls back to process.env.OPENGRADIENT_PRIVATE_KEY.
   * Never hardcode this value — always load from an environment variable.
   */
  privateKey?: Hex;
}

export interface OpenGradientState {
  /** Final parsed inference result. Null when no payment succeeded. */
  inferenceResult: unknown | null;
  /** Transaction hash of the payment, or null when no payment was required. */
  paymentTxHash: Hash | null;
  /** Amount paid in $OPG smallest unit. "0" when no payment was required. */
  amountPaid: string;
  /** $OPG token contract used for payment, or null when free. */
  tokenAddress: Address | null;
  /** Full stage snapshot for UI progress rendering. */
  flow: OpenGradientPaymentFlowStage;
}

export class OpenGradientAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenGradientAdapterError";
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class OpenGradientAdapter implements ChainAdapter<OpenGradientState> {
  readonly id = "opengradient";
  private readonly config: Required<OpenGradientAdapterConfig>;
  private readonly account: ReturnType<typeof privateKeyToAccount>;

  constructor(config: OpenGradientAdapterConfig) {
    const rawKey = config.privateKey ?? process.env["OPENGRADIENT_PRIVATE_KEY"];
    if (!rawKey) {
      throw new OpenGradientAdapterError(
        "OpenGradientAdapter: private key is required. " +
        "Set config.privateKey or the OPENGRADIENT_PRIVATE_KEY environment variable.",
      );
    }
    const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex;
    this.account = privateKeyToAccount(privateKey);
    this.config = {
      ...config,
      inferenceEndpoint: config.inferenceEndpoint ?? OPENGRADIENT_ENDPOINT,
      chainId: config.chainId ?? BASE_SEPOLIA_CHAIN_ID,
      privateKey,
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle: readState
  // ---------------------------------------------------------------------------

  /**
   * Sends the initial inference request.
   *
   * - HTTP 200 → returns the inference result with no payment required.
   * - HTTP 402 → parses body.accepts[0] as the payment requirement.
   *
   * No signing or payment occurs here — this is a pure read operation.
   */
  async readState(context: RouteContext): Promise<ReadResult<OpenGradientState>> {
    const response = await this.makeInferenceRequest(context, null);

    if (response.status !== 402) {
      const result: unknown = await response.json();
      return { state: this.buildFreeResult(result), paymentRequired: null };
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
   * Builds an unsigned Permit2 PermitTransferFrom from the payment requirement.
   *
   * Determines: permitted.token, permitted.amount, spender, nonce (random uint256), deadline.
   * Does NOT sign — returned as PaymentPayload for explicit signing in the next stage.
   */
  async preparePayment(requirement: PaymentRequirement): Promise<PaymentPayload> {
    const ogReq = requirement as OpenGradientPaymentRequirement;
    const permit = this.buildPermit(ogReq);
    const payload = { requirement, permit };
    return payload;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle: sign
  // ---------------------------------------------------------------------------

  /**
   * Signs the PermitTransferFrom using EIP-712 typed data.
   *
   * Domain: { name: "Permit2", chainId: 84532, verifyingContract: PERMIT2_ADDRESS }.
   * No `version` field — Permit2 domain omits it.
   *
   * Signing is fully offline — no RPC call needed.
   * Throws on signing failure (e.g. domain separator mismatch).
   */
  async sign(payload: PaymentPayload): Promise<SignedPayload> {
    const ogPayload = payload as PaymentPayload & { permit: PermitTransferFrom };
    const ogReq = payload.requirement as OpenGradientPaymentRequirement;
    const signature = await this.signPermit(ogPayload.permit, ogReq);
    return { payload, signature };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle: submit
  // ---------------------------------------------------------------------------

  /**
   * Encodes the signed permit as an x402 PAYMENT-SIGNATURE header and retries the inference request.
   *
   * On success (HTTP 2xx): returns accepted=true with the inference response.
   * On failure: returns accepted=false with the error reason.
   */
  async submit(signed: SignedPayload, context: RouteContext): Promise<SubmissionResult> {
    const ogPayload = signed.payload as PaymentPayload & { permit: PermitTransferFrom };
    const ogReq = signed.payload.requirement as OpenGradientPaymentRequirement;

    const wirePayload: OpenGradientWirePayload = {
      x402Version: 1,
      scheme: ogReq.scheme,
      network: ogReq.network,
      payload: {
        signature: signed.signature as Hex,
        permit: ogPayload.permit,
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
   * Permit2 payments are verified atomically on submission — the facilitator validates
   * the EIP-712 signature and settles inline. No separate finality wait.
   *
   * Builds the final OpenGradientState from the submission result.
   */
  async awaitFinality(result: SubmissionResult): Promise<FinalityStatus<OpenGradientState>> {
    const ogReq = result.requirement as OpenGradientPaymentRequirement;

    if (result.accepted) {
      return {
        finalized: true,
        txHash: result.txHash,
        state: {
          inferenceResult: result.responseData,
          paymentTxHash: result.txHash as Hash,
          amountPaid: ogReq.maxAmountRequired,
          tokenAddress: ogReq.asset,
          flow: {
            status: "complete",
            txHash: result.txHash as Hash,
            amountPaid: ogReq.maxAmountRequired,
            tokenAddress: ogReq.asset,
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
        tokenAddress: ogReq.asset,
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
    payment: OpenGradientWirePayload | null,
  ): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (payment !== null) {
      // bigint fields (amount, nonce, deadline) serialised as decimal strings —
      // JSON.stringify throws on bigint by default.
      headers["PAYMENT-SIGNATURE"] = btoa(
        JSON.stringify(payment, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
      );
    }
    return fetch(this.config.inferenceEndpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ path: context.path, params: context.params }),
    });
  }

  private async parsePaymentRequirement(response: Response): Promise<OpenGradientPaymentRequirement> {
    const body: unknown = await response.json();
    const accepts = (body as { accepts?: unknown[] } | null)?.accepts;
    const req = Array.isArray(accepts) ? accepts[0] : undefined;
    if (
      typeof req !== "object" || req === null ||
      !("scheme" in req) || !("network" in req) || !("maxAmountRequired" in req) ||
      !("resource" in req) || !("payTo" in req) || !("asset" in req)
    ) {
      throw new OpenGradientAdapterError("402 response body missing valid payment requirement");
    }
    return req as OpenGradientPaymentRequirement;
  }

  private buildPermit(requirement: OpenGradientPaymentRequirement): PermitTransferFrom {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    // Permit2 unordered nonce: random uint256 — collision probability negligible.
    const nonceBytes = crypto.getRandomValues(new Uint8Array(32));
    const nonce = nonceBytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
    return {
      permitted: {
        token:  requirement.asset,
        amount: BigInt(requirement.maxAmountRequired),
      },
      spender:  requirement.payTo,
      nonce,
      deadline: nowSec + BigInt(requirement.maxTimeoutSeconds),
    };
  }

  private async signPermit(
    permit: PermitTransferFrom,
    _requirement: OpenGradientPaymentRequirement,
  ): Promise<Hex> {
    return this.account.signTypedData({
      domain: {
        name:              "Permit2",
        chainId:           this.config.chainId,
        verifyingContract: PERMIT2_ADDRESS,
      },
      types:       PERMIT2_EIP712_TYPES,
      primaryType: "PermitTransferFrom",
      message: {
        permitted: {
          token:  permit.permitted.token,
          amount: permit.permitted.amount,
        },
        spender:  permit.spender,
        nonce:    permit.nonce,
        deadline: permit.deadline,
      },
    });
  }

  private buildFreeResult(inferenceResult: unknown): OpenGradientState {
    return {
      inferenceResult,
      paymentTxHash: null,
      amountPaid: "0",
      tokenAddress: null,
      flow: { status: "idle" },
    };
  }
}
