/**
 * OpenGradient inference adapter — x402 payment protocol on Base Sepolia.
 *
 * Chain:   Base Sepolia testnet (chainId: 84532)
 * Token:   $OPG — testnet: 0x240b09731D96979f50B2C649C9CE10FcF9C7987F
 *                  mainnet: 0xFbC2051AE2265686a469421b2C5A2D5462FbF5eB
 * Signing: EIP-3009 transferWithAuthorization
 * Header:  X-PAYMENT (x402 v1)
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

/** $OPG ERC-20 on Base mainnet (reference only — adapter currently targets testnet). */
// const OPG_TOKEN_MAINNET = "0xFbC2051AE2265686a469421b2C5A2D5462FbF5eB" as Address;

// ---------------------------------------------------------------------------
// x402 / OpenGradient protocol types
// ---------------------------------------------------------------------------

/**
 * Payment requirement returned in the HTTP 402 response body.
 * Parsed directly from the response JSON — no `accepts` wrapper.
 */
export interface OpenGradientPaymentRequirement extends PaymentRequirement {
  /** URL of the inference resource being paid for. */
  resource: string;
  /** EVM address to send the payment to. */
  payTo: Address;
  /** Seconds before the payment authorization expires. */
  maxTimeoutSeconds: number;
  /** $OPG ERC-20 token contract — the verifyingContract in the EIP-712 domain. */
  asset: Address;
  extra?: { name: string; version: string };
}

/**
 * EIP-3009 TransferWithAuthorization message — signed via EIP-712.
 *
 * Domain: { name: "OPG", version: "1", chainId: 84532, verifyingContract: asset }
 *
 * Field names and types must match the on-chain $OPG token verifier exactly.
 * Any deviation produces an invalid signature.
 */
export interface TransferWithAuthorization {
  /** Wallet address funding the payment. */
  from: Address;
  /** OpenGradient payment recipient address. */
  to: Address;
  /** Payment amount in $OPG smallest unit. */
  value: bigint;
  /** Unix timestamp — authorization not valid before this second. 0 = immediately valid. */
  validAfter: bigint;
  /** Unix timestamp — authorization expires after this second. */
  validBefore: bigint;
  /** 32-byte random nonce — prevents replay. */
  nonce: Hex;
}

/**
 * Encoded payment sent as the `X-PAYMENT` header on the retry request.
 */
export interface OpenGradientWirePayload {
  x402Version: 1;
  scheme: OpenGradientPaymentRequirement["scheme"];
  network: OpenGradientPaymentRequirement["network"];
  payload: {
    signature: Hex;
    authorization: TransferWithAuthorization;
  };
}

// ---------------------------------------------------------------------------
// Payment flow state machine
// ---------------------------------------------------------------------------

export type OpenGradientPaymentFlowStage =
  | { status: "idle" }
  | { status: "payment_required"; requirement: OpenGradientPaymentRequirement }
  | { status: "signing"; requirement: OpenGradientPaymentRequirement; authorization: TransferWithAuthorization }
  | { status: "submitting"; requirement: OpenGradientPaymentRequirement; payload: OpenGradientWirePayload }
  | { status: "complete"; txHash: Hash; amountPaid: string; tokenAddress: Address }
  | { status: "failed"; reason: string };

// ---------------------------------------------------------------------------
// EIP-712 schema — EIP-3009 TransferWithAuthorization
//
// IMPORTANT: field order, names, and types must match the on-chain $OPG verifier exactly.
// Any deviation produces an invalid signature.
// ---------------------------------------------------------------------------

const OPG_DOMAIN_NAME    = "OPG";
const OPG_DOMAIN_VERSION = "1";

const OPG_EIP712_TYPES = {
  TransferWithAuthorization: [
    { name: "from",        type: "address" },
    { name: "to",          type: "address" },
    { name: "value",       type: "uint256" },
    { name: "validAfter",  type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce",       type: "bytes32" },
  ],
} as const;

// ---------------------------------------------------------------------------
// Config
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
   * Hex-encoded private key for signing EIP-3009 authorizations.
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
  /** $OPG token contract used for payment, or null when free. */
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
   * - HTTP 402 → parses the x402 PaymentRequirement and signals it to the router.
   *
   * No signing or payment occurs here — this is a pure read operation.
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
   * Builds an unsigned TransferWithAuthorization from the x402 payment requirement.
   *
   * Determines: from, to, value, validAfter (0 = immediately), validBefore, nonce.
   * Does NOT sign — returned as PaymentPayload for explicit signing in the next stage.
   */
  async preparePayment(requirement: PaymentRequirement): Promise<PaymentPayload> {
    const ogReq = requirement as OpenGradientPaymentRequirement;
    const authorization = this.buildAuthorization(ogReq);
    return { requirement, authorization };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle: sign
  // ---------------------------------------------------------------------------

  /**
   * Signs the TransferWithAuthorization using EIP-712 typed data.
   *
   * Signing key: this.account (derived from OPENGRADIENT_PRIVATE_KEY).
   * Domain: { name: "OPG", version: "1", chainId: 84532, verifyingContract: asset }.
   * Type:   TransferWithAuthorization — see OPG_EIP712_TYPES.
   *
   * Signing is fully offline — no RPC call needed.
   * Throws on signing failure (e.g. domain separator mismatch).
   */
  async sign(payload: PaymentPayload): Promise<SignedPayload> {
    const ogPayload = payload as PaymentPayload & { authorization: TransferWithAuthorization };
    const x402Req = payload.requirement as OpenGradientPaymentRequirement;
    const signature = await this.signAuthorization(ogPayload.authorization, x402Req);
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
    const ogPayload = signed.payload as PaymentPayload & { authorization: TransferWithAuthorization };
    const ogReq = signed.payload.requirement as OpenGradientPaymentRequirement;

    const wirePayload: OpenGradientWirePayload = {
      x402Version: 1,
      scheme: ogReq.scheme,
      network: ogReq.network,
      payload: {
        signature: signed.signature as Hex,
        authorization: ogPayload.authorization,
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
   * EIP-3009 payments are verified atomically on submission — the server validates
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
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (payment !== null) {
      // bigint fields (value, validAfter, validBefore) serialised as decimal strings —
      // JSON.stringify throws on bigint by default.
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
      !("scheme" in body) ||
      !("network" in body) ||
      !("maxAmountRequired" in body) ||
      !("resource" in body) ||
      !("payTo" in body) ||
      !("asset" in body)
    ) {
      throw new OpenGradientAdapterError("402 response body missing valid payment requirement");
    }
    return body as OpenGradientPaymentRequirement;
  }

  private buildAuthorization(requirement: OpenGradientPaymentRequirement): TransferWithAuthorization {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    return {
      from:        this.config.signerAddress,
      to:          requirement.payTo,
      value:       BigInt(requirement.maxAmountRequired),
      validAfter:  0n,
      validBefore: nowSec + BigInt(requirement.maxTimeoutSeconds),
      nonce: ("0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")) as Hex,
    };
  }

  /**
   * Signs an EIP-3009 TransferWithAuthorization using EIP-712 typed data.
   *
   * Domain: { name: "OPG", version: "1", chainId, verifyingContract: requirement.asset }
   * Type:   TransferWithAuthorization — see OPG_EIP712_TYPES above.
   *
   * Uses privateKeyToAccount so signing is fully offline — no RPC call needed.
   */
  private async signAuthorization(
    authorization: TransferWithAuthorization,
    requirement: OpenGradientPaymentRequirement,
  ): Promise<Hex> {
    const domain = {
      name:              OPG_DOMAIN_NAME,
      version:           OPG_DOMAIN_VERSION,
      chainId:           this.config.chainId,
      verifyingContract: requirement.asset,
    } as const;

    const message = {
      from:        authorization.from,
      to:          authorization.to,
      value:       authorization.value,
      validAfter:  authorization.validAfter,
      validBefore: authorization.validBefore,
      nonce:       authorization.nonce,
    };

    return this.account.signTypedData({
      domain,
      types: OPG_EIP712_TYPES,
      primaryType: "TransferWithAuthorization",
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
