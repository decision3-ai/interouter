/**
 * OpenGradient inference adapter — x402 payment protocol on Base mainnet.
 *
 * Chain:   Base mainnet (chainId: 8453)
 * Token:   $OPG (ERC-20 on Base)
 * Signing: Permit2 (0x000000000022D473030F116dDEE9F6B43aC78BA3)
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

const BASE_MAINNET_CHAIN_ID = 8453;

/** Canonical Permit2 deployment — same address on all EVM chains. */
const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address;

// TODO: Confirm $OPG ERC-20 contract address on Base mainnet with OpenGradient.
const OPG_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000" as Address; // TODO

// ---------------------------------------------------------------------------
// x402 / OpenGradient protocol types
// ---------------------------------------------------------------------------

/**
 * Payment requirement returned in the HTTP 402 response body.
 *
 * TODO: Confirm exact field names and structure with OpenGradient API docs.
 * This mirrors the x402 spec shape — OpenGradient may use a different schema.
 */
export interface OpenGradientPaymentRequirement extends PaymentRequirement {
  /** URL of the inference resource being paid for. */
  resource: string;
  /** Human-readable description of the payment. */
  description: string;
  /** MIME type of the resource. */
  mimeType: string;
  /** EVM address to send the payment to. */
  payTo: Address;
  /** Seconds before the payment authorization expires. */
  maxTimeoutSeconds: number;
  /**
   * ERC-20 token contract address for payment.
   * Expected to be $OPG on Base mainnet.
   * TODO: Confirm with OpenGradient whether this is always $OPG or configurable.
   */
  asset: Address;
  extra?: { name: string; version: string };
}

/**
 * Permit2 PermitTransferFrom message — signed via EIP-712.
 *
 * Domain: { name: "Permit2", chainId: 8453, verifyingContract: PERMIT2_ADDRESS }
 *
 * Field names and types must match the on-chain Permit2 verifier exactly.
 * Reference: https://github.com/Uniswap/permit2
 */
export interface Permit2TransferFrom {
  /** ERC-20 token and amount being authorized. */
  permitted: {
    token: Address;
    amount: bigint;
  };
  /**
   * Address permitted to call transferFrom on behalf of the signer.
   * TODO: Confirm the OpenGradient spender address (their payment gateway contract).
   */
  spender: Address;
  /** Unique nonce — prevents replay. Permit2 tracks used nonces on-chain. */
  nonce: bigint;
  /** Unix timestamp — authorization expires after this second. */
  deadline: bigint;
}

/**
 * Wire payload sent as the payment header on the retry request.
 *
 * TODO: Confirm the exact payment header name with OpenGradient:
 *   - "X-PAYMENT" (x402 v1)?
 *   - "PAYMENT-SIGNATURE" (x402 v2)?
 *   - A custom OpenGradient header?
 */
export interface OpenGradientWirePayload {
  // TODO: Confirm x402Version used by OpenGradient (v1 or v2).
  x402Version: 1;
  scheme: OpenGradientPaymentRequirement["scheme"];
  network: OpenGradientPaymentRequirement["network"];
  payload: {
    signature: Hex;
    permit: Permit2TransferFrom;
  };
}

// ---------------------------------------------------------------------------
// Payment flow state machine
// ---------------------------------------------------------------------------

export type OpenGradientPaymentFlowStage =
  | { status: "idle" }
  | { status: "payment_required"; requirement: OpenGradientPaymentRequirement }
  | { status: "signing"; requirement: OpenGradientPaymentRequirement; permit: Permit2TransferFrom }
  | { status: "submitting"; requirement: OpenGradientPaymentRequirement; payload: OpenGradientWirePayload }
  | { status: "complete"; txHash: Hash; amountPaid: string; tokenAddress: Address }
  | { status: "failed"; reason: string };

// ---------------------------------------------------------------------------
// EIP-712 schema — Permit2 PermitTransferFrom
//
// IMPORTANT: field names and types must match the on-chain Permit2 verifier exactly.
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
// Config
// ---------------------------------------------------------------------------

export interface OpenGradientAdapterConfig {
  /**
   * OpenGradient inference endpoint URL.
   * TODO: Confirm base URL and path structure with OpenGradient API docs.
   */
  inferenceEndpoint: string;
  /** Base mainnet chain ID — defaults to 8453 if omitted. */
  chainId?: number;
  /** EVM JSON-RPC URL for Base mainnet. */
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

// ---------------------------------------------------------------------------
// Result state stored in RouteResult.chainState["opengradient"]
// ---------------------------------------------------------------------------

export interface OpenGradientState {
  /** Final parsed inference result. Null when no payment succeeded. */
  inferenceResult: unknown | null;
  /** Transaction hash of the payment, or null when no payment was required. */
  paymentTxHash: Hash | null;
  /** Amount paid in $OPG smallest unit. "0" when no payment was required. */
  amountPaid: string;
  /** ERC-20 token contract used for payment, or null when free. */
  tokenAddress: Address | null;
  /** Full stage snapshot for UI progress rendering. */
  flow: OpenGradientPaymentFlowStage;
}

// ---------------------------------------------------------------------------
// Typed error
// ---------------------------------------------------------------------------

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
    this.config = { ...config, chainId: config.chainId ?? BASE_MAINNET_CHAIN_ID, privateKey };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle: readState
  // ---------------------------------------------------------------------------

  /**
   * Sends the initial inference request.
   *
   * - HTTP 200 → returns inference result with no payment required.
   * - HTTP 402 → parses the OpenGradient PaymentRequirement and signals it to the router.
   *
   * No signing or payment occurs here — pure read operation.
   *
   * TODO: Confirm whether OpenGradient 402 response body uses the x402 `accepts` array
   * shape, or a different schema.
   */
  async readState(context: RouteContext): Promise<ReadResult<OpenGradientState>> {
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
   * Builds an unsigned Permit2TransferFrom from the payment requirement.
   *
   * Determines: token, amount, spender, nonce, deadline.
   * Does NOT sign — returned as PaymentPayload for explicit signing in the next stage.
   *
   * TODO: Confirm nonce generation strategy with OpenGradient.
   * Permit2 nonces are unordered bitmaps — any unused 256-bit nonce is valid.
   */
  async preparePayment(requirement: PaymentRequirement): Promise<PaymentPayload> {
    const ogReq = requirement as OpenGradientPaymentRequirement;
    const permit = this.buildPermit(ogReq);
    return { requirement, permit };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle: sign
  // ---------------------------------------------------------------------------

  /**
   * Signs the Permit2TransferFrom using EIP-712 typed data.
   *
   * Signing key: this.account (derived from OPENGRADIENT_PRIVATE_KEY).
   * Domain: { name: "Permit2", chainId: 8453, verifyingContract: PERMIT2_ADDRESS }.
   * Type:   PermitTransferFrom — see PERMIT2_EIP712_TYPES.
   *
   * Signing is fully offline — no RPC call needed.
   * Throws on signing failure (e.g. domain separator mismatch).
   */
  async sign(payload: PaymentPayload): Promise<SignedPayload> {
    const ogPayload = payload as PaymentPayload & { permit: Permit2TransferFrom };
    const signature = await this.signPermit(ogPayload.permit);
    return { payload, signature };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle: submit
  // ---------------------------------------------------------------------------

  /**
   * Encodes the signed Permit2 authorization as a payment header and retries
   * the inference request.
   *
   * On success (HTTP 2xx): returns accepted=true with the inference response.
   * On failure: returns accepted=false with the error reason.
   *
   * TODO: Confirm payment header name and encoding with OpenGradient.
   * Currently mirrors OpenLedger's X-PAYMENT + base64(JSON) pattern.
   */
  async submit(signed: SignedPayload, context: RouteContext): Promise<SubmissionResult> {
    const ogPayload = signed.payload as PaymentPayload & { permit: Permit2TransferFrom };
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
    // TODO: Confirm the response header name for the transaction hash with OpenGradient.
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
   * Permit2 payments are verified atomically on submission — the server validates
   * the EIP-712 signature and settles inline. No separate finality wait.
   *
   * TODO: Confirm with OpenGradient whether they do any async settlement that
   * requires polling, or whether inline verification is guaranteed.
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
          tokenAddress: ogReq.asset ?? OPG_TOKEN_ADDRESS,
          flow: {
            status: "complete",
            txHash: result.txHash as Hash,
            amountPaid: ogReq.maxAmountRequired,
            tokenAddress: ogReq.asset ?? OPG_TOKEN_ADDRESS,
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
        tokenAddress: ogReq.asset ?? OPG_TOKEN_ADDRESS,
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
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (payment !== null) {
      // bigint fields (amount, nonce, deadline) serialised as decimal strings —
      // JSON.stringify throws on bigint by default.
      // TODO: Confirm payment header name and encoding format with OpenGradient.
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

  private async parsePaymentRequirement(response: Response): Promise<OpenGradientPaymentRequirement> {
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      !("accepts" in body) ||
      !Array.isArray((body as { accepts: unknown }).accepts) ||
      (body as { accepts: unknown[] }).accepts.length === 0
    ) {
      throw new OpenGradientAdapterError("402 response body missing valid payment requirement");
    }
    // TODO: Confirm 402 body schema with OpenGradient. Assuming x402 `accepts` array shape.
    return (body as { accepts: OpenGradientPaymentRequirement[] }).accepts[0] as OpenGradientPaymentRequirement;
  }

  private buildPermit(requirement: OpenGradientPaymentRequirement): Permit2TransferFrom {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    return {
      permitted: {
        token: requirement.asset ?? OPG_TOKEN_ADDRESS,
        amount: BigInt(requirement.maxAmountRequired),
      },
      // TODO: Confirm the OpenGradient spender address (their payment gateway contract on Base).
      spender: requirement.payTo,
      // Permit2 nonces are unordered — any random 256-bit value unused by this wallet is valid.
      nonce: BigInt("0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")),
      deadline: nowSec + BigInt(requirement.maxTimeoutSeconds),
    };
  }

  private async signPermit(permit: Permit2TransferFrom): Promise<Hex> {
    const domain = {
      name: "Permit2",
      chainId: this.config.chainId,
      verifyingContract: PERMIT2_ADDRESS,
    } as const;

    const message = {
      permitted: permit.permitted,
      spender:   permit.spender,
      nonce:     permit.nonce,
      deadline:  permit.deadline,
    };

    return this.account.signTypedData({
      domain,
      types: PERMIT2_EIP712_TYPES,
      primaryType: "PermitTransferFrom",
      message,
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
