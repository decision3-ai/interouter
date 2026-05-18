import type { Address, Hash, Hex } from "viem";
import type { ChainAdapter, RouteContext } from "../router.js";

// ---------------------------------------------------------------------------
// x402 protocol types
// ---------------------------------------------------------------------------

/**
 * Payment requirement returned in the HTTP 402 response body.
 * Mirrors the x402 spec as implemented by OpenLedger.
 */
export interface PaymentRequirement {
  /** Payment scheme — "exact" means the full amount must be sent in one tx. */
  scheme: "exact";
  /** Chain network identifier, e.g. "bnb-testnet" or "openledger-l2". */
  network: string;
  /** Maximum payment amount in the token's smallest unit (string to avoid precision loss). */
  maxAmountRequired: string;
  /** URL of the resource being paid for. */
  resource: string;
  /** Human-readable description of the payment. */
  description: string;
  /** MIME type of the resource. */
  mimeType: string;
  /** EVM address to send the payment to. */
  payTo: Address;
  /** Seconds before the payment authorization expires. */
  maxTimeoutSeconds: number;
  /** ERC-20 token contract address used for payment. */
  asset: Address;
  extra?: { name: string; version: string };
}

/**
 * EIP-3009 transfer authorization signed by the payer.
 * Allows the recipient to pull the payment atomically with the service delivery.
 */
export interface TransferAuthorization {
  from: Address;
  to: Address;
  /** Payment amount in smallest token units. */
  value: bigint;
  /** Unix timestamp — authorization is not valid before this. */
  validAfter: bigint;
  /** Unix timestamp — authorization expires after this. */
  validBefore: bigint;
  /** Random nonce preventing replay. */
  nonce: Hex;
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
// A discriminated union tracks every stage of the payment flow so callers can
// inspect exactly where the transaction is and surface partial state to the UI.
// ---------------------------------------------------------------------------

export type PaymentFlowStage =
  | { status: "idle" }
  | { status: "payment_required"; requirement: PaymentRequirement }
  | { status: "signing"; requirement: PaymentRequirement; authorization: TransferAuthorization }
  | { status: "submitting"; requirement: PaymentRequirement; payload: PaymentPayload }
  | { status: "complete"; txHash: Hash; amountPaid: string; tokenAddress: Address }
  | { status: "failed"; reason: string };

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
  /** Private key for signing EIP-3009 authorizations. Keep in an env var — never hardcode. */
  privateKey: Hex;
}

// ---------------------------------------------------------------------------
// Result state stored in RouteResult.chainState["openledger"]
// ---------------------------------------------------------------------------

export interface OpenLedgerState {
  /** Final parsed inference result. Null until the flow reaches "complete". */
  inferenceResult: unknown | null;
  /** Transaction hash of the payment, or null when no payment was required. */
  paymentTxHash: Hash | null;
  /** Amount paid in the token's smallest unit. "0" when no payment was required. */
  amountPaid: string;
  /** Address of the ERC-20 token used for payment, or null when free. */
  tokenAddress: Address | null;
  /** Full stage snapshot — lets the frontend render a payment progress indicator. */
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

  constructor(config: OpenLedgerAdapterConfig) {
    this.config = config;
  }

  /**
   * Runs the full x402 payment state machine:
   *
   *   1. Send inference request → may get 402.
   *   2. Parse PaymentRequirement from the 402 body.
   *   3. Build and sign an EIP-3009 TransferAuthorization.
   *   4. Encode as PaymentPayload and retry with X-PAYMENT header.
   *   5. Return parsed inference result + payment receipt.
   */
  async fetchState(context: RouteContext): Promise<OpenLedgerState> {
    // Stage 1 — initial inference request.
    const initialResponse = await this.makeInferenceRequest(context, null);

    if (initialResponse.status !== 402) {
      // Free-tier response — no payment needed.
      const result: unknown = await initialResponse.json();
      return this.buildFreeResult(result);
    }

    // Stage 2 — parse payment requirement.
    const requirement = await this.parsePaymentRequirement(initialResponse);

    // Stage 3 — build and sign the EIP-3009 transfer authorization.
    const authorization = this.buildAuthorization(requirement);
    const signature = await this.signAuthorization(authorization, requirement);

    // Stage 4 — encode payment payload and retry.
    const payload: PaymentPayload = {
      x402Version: 1,
      scheme: requirement.scheme,
      network: requirement.network,
      payload: { signature, authorization },
    };

    const paidResponse = await this.makeInferenceRequest(context, payload);

    if (!paidResponse.ok) {
      throw new OpenLedgerAdapterError(
        `Inference request failed after payment: HTTP ${paidResponse.status}`,
      );
    }

    // Stage 5 — return result + payment receipt.
    const inferenceResult: unknown = await paidResponse.json();

    return {
      inferenceResult,
      paymentTxHash: null, // TODO: extract from paidResponse headers once spec is finalised
      amountPaid: requirement.maxAmountRequired,
      tokenAddress: requirement.asset,
      flow: {
        status: "complete",
        txHash: "0x0" as Hash, // TODO: replace with real tx hash from on-chain receipt
        amountPaid: requirement.maxAmountRequired,
        tokenAddress: requirement.asset,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers — each maps to one stage of the state machine
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
    // x402 responses carry the requirement as JSON in the response body.
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
    // Take the first accepted payment option.
    return (body as { accepts: PaymentRequirement[] }).accepts[0] as PaymentRequirement;
  }

  private buildAuthorization(requirement: PaymentRequirement): TransferAuthorization {
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    return {
      from: this.config.signerAddress,
      to: requirement.payTo,
      value: BigInt(requirement.maxAmountRequired),
      validAfter: nowSec - 60n,
      validBefore: nowSec + BigInt(requirement.maxTimeoutSeconds),
      nonce: ("0x" + Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")) as Hex,
    };
  }

  private async signAuthorization(
    _authorization: TransferAuthorization,
    _requirement: PaymentRequirement,
  ): Promise<Hex> {
    // TODO: implement EIP-3009 / EIP-712 signing via viem walletClient.
    //   const client = createWalletClient({ ... });
    //   return client.signTypedData({ domain, types, primaryType, message });
    throw new OpenLedgerAdapterError("signAuthorization: not yet implemented");
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
