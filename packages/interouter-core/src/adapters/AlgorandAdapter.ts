/**
 * AlgorandAdapter — transactional ChainAdapter for the Algorand Virtual Machine (AVM)
 * via the GoPlausible x402 facilitator (@x402-avm).
 *
 * Mirrors the OpenLedgerAdapter shape:
 *   - resolves a custodial signing key from config ?? env, throws if absent
 *   - extends PaymentRequirement into an AVM-specific requirement
 *   - submit() re-requests the same resource endpoint with an x402 payment header
 *     (no separate facilitator round-trip in the buyer path)
 *   - implements the full five-stage lifecycle from ../router.js
 *
 * Scheme: `exact` (the scheme AVM currently supports). Because it is `exact`,
 * SubmissionResult.actualCharge is intentionally NOT populated — the router's
 * budget circuit breaker only fires for `upto` adapters, so this adapter just
 * needs accepted: true.
 *
 * Finality: Algorand has single-block deterministic finality (~3s), so this
 * adapter is a strong candidate for adapters[0] (first priority) in the router.
 *
 * Wire format: payment construction, ed25519 signing, the x402 v2 header
 * (PAYMENT-SIGNATURE) and the settlement response (PAYMENT-RESPONSE) are all
 * delegated to GoPlausible's @x402-avm SDK (ExactAvmScheme + core http helpers),
 * so there is no hand-rolled encoding to keep in sync with their spec. The 402
 * requirement surfaced by readState is still read from the response body; switch
 * to PAYMENT-REQUIRED header parsing here if the facilitator emits it that way.
 */

import algosdk from "algosdk";

// Canonical AVM constants + the exact-scheme client from GoPlausible.
// ExactAvmScheme builds and signs the atomic ASA-transfer group; the
// @x402-avm/core http helpers handle the x402 wire encoding so we no longer
// hand-roll the payment header / settlement parsing.
import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
  ExactAvmScheme,
  toClientAvmSigner,
} from "@x402-avm/avm";
import {
  encodePaymentSignatureHeader,
  decodePaymentResponseHeader,
} from "@x402-avm/core/http";
import type {
  PaymentRequirements as AvmSdkRequirements,
  PaymentPayload as AvmWirePayload,
  SettleResponse,
} from "@x402-avm/core/types";

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
// Errors
// ---------------------------------------------------------------------------

export class AlgorandAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlgorandAdapterError";
  }
}

// ---------------------------------------------------------------------------
// AVM-specific payment types
// ---------------------------------------------------------------------------

/** x402 payment requirement for AVM, surfaced on a 402 from the resource. */
export interface AvmPaymentRequirement extends PaymentRequirement {
  scheme: "exact";
  /** CAIP-2 network id, e.g. "algorand:wGHE2..." */
  network: string;
  /** maxAmountRequired (base units of the asset) — inherited from base */
  /** Receiver address (58-char Algorand address). */
  payTo: string;
  /** ASA id of the payment asset (e.g. USDC). */
  asset: number;
  /** Resource being paid for. */
  resource: string;
  description?: string | undefined;
  mimeType?: string | undefined;
  maxTimeoutSeconds?: number | undefined;
  extra?: Record<string, unknown> | undefined;
}

/**
 * Prepared AVM payment. The actual txn group is built and signed inside the
 * `@x402-avm/avm` ExactAvmScheme during sign(), so all we carry forward is the
 * SDK-shaped requirement that drives that construction.
 */
export interface AvmPaymentPayload extends PaymentPayload {
  requirement: AvmPaymentRequirement;
  /** Requirement re-shaped to the @x402-avm/core PaymentRequirements contract. */
  sdkRequirement: AvmSdkRequirements;
}

type PaymentFlowStage =
  | "idle"
  | "requirement-read"
  | "prepared"
  | "signed"
  | "submitted"
  | "finalized";

/** TState — mirrors OpenLedgerState in spirit. */
export interface AlgorandState {
  result: unknown | null;
  paymentTxHash: string | null;
  amountPaid: string;
  asset: number | null;
  network: string;
  flow: PaymentFlowStage;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AlgorandAdapterConfig {
  /** Custodial 25-word mnemonic; falls back to ALGORAND_MNEMONIC. */
  mnemonic?: string;
  /** The x402-gated resource endpoint this adapter pays to access. */
  resourceEndpoint: string;
  /** algod node URL (e.g. an Algonode/Nodely endpoint). */
  algodUrl: string;
  /** algod API token (often "" for public nodes). */
  algodToken?: string;
  /** algod port (often "" for https endpoints). */
  algodPort?: string;
  /** CAIP-2 network. Defaults to MAINNET (required for the competition). */
  network?: string;
  /** Payment asset id (ASA). Defaults to USDC for the chosen network. */
  asset?: number;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class AlgorandAdapter implements ChainAdapter<AlgorandState> {
  readonly id = "algorand";

  private readonly account: algosdk.Account;
  private readonly algod: algosdk.Algodv2;
  private readonly scheme: ExactAvmScheme;
  private readonly resourceEndpoint: string;
  private readonly network: string;
  private readonly defaultAsset: number;

  constructor(config: AlgorandAdapterConfig) {
    const mnemonic = config.mnemonic ?? process.env["ALGORAND_MNEMONIC"];
    if (!mnemonic) {
      throw new AlgorandAdapterError(
        "No signing key: set config.mnemonic or ALGORAND_MNEMONIC",
      );
    }
    try {
      this.account = algosdk.mnemonicToSecretKey(mnemonic.trim());
    } catch {
      throw new AlgorandAdapterError("ALGORAND_MNEMONIC is not a valid 25-word mnemonic");
    }

    if (!config.resourceEndpoint) {
      throw new AlgorandAdapterError("config.resourceEndpoint is required");
    }
    this.resourceEndpoint = config.resourceEndpoint;

    this.algod = new algosdk.Algodv2(
      config.algodToken ?? "",
      config.algodUrl,
      config.algodPort ?? "",
    );

    // toClientAvmSigner expects the 64-byte ed25519 secret key (seed + pubkey)
    // base64-encoded. algosdk stores exactly that in account.sk, so we convert
    // the mnemonic-derived key rather than asking callers for a second format.
    const signer = toClientAvmSigner(Buffer.from(this.account.sk).toString("base64"));
    // ExactAvmScheme calls algodClient.suggestedParams() (modern AlgodClient
    // API), so it must build its own client from the URL/token — algosdk's
    // Algodv2 (kept above for finality) is not compatible here.
    this.scheme = new ExactAvmScheme(signer, {
      algodUrl: config.algodUrl,
      algodToken: config.algodToken ?? "",
    });

    this.network = config.network ?? ALGORAND_MAINNET_CAIP2;
    // Default asset: USDC, resolved from the GoPlausible ASA-id constants.
    this.defaultAsset =
      config.asset ??
      Number(
        this.network === ALGORAND_TESTNET_CAIP2 ? USDC_TESTNET_ASA_ID : USDC_MAINNET_ASA_ID,
      );
  }

  // --- Stage 1: readState -----------------------------------------------------
  async readState(context: RouteContext): Promise<ReadResult<AlgorandState>> {
    const res = await fetch(this.resourceEndpoint, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    // Resource is open / already paid → no payment needed.
    if (res.status !== 402) {
      const result = await safeJson(res);
      return {
        state: {
          result,
          paymentTxHash: null,
          amountPaid: "0",
          asset: null,
          network: this.network,
          flow: "idle",
        },
        paymentRequired: null,
      };
    }

    // 402 → parse the AVM payment requirement.
    // CONFIRM #1: GoPlausible may put requirements in a PAYMENT-REQUIRED header
    // (base64 JSON) or in the response body. This reads the body; adjust to match.
    const body = (await safeJson(res)) as { accepts?: unknown[] } | null;
    const accept = Array.isArray(body?.accepts) ? body!.accepts[0] : body;
    const req = accept as Partial<AvmPaymentRequirement> | null;

    if (!req || req.maxAmountRequired === undefined || !req.payTo) {
      throw new AlgorandAdapterError("402 returned but AVM requirement is malformed");
    }

    const requirement: AvmPaymentRequirement = {
      scheme: "exact",
      network: req.network ?? this.network,
      maxAmountRequired: String(req.maxAmountRequired),
      payTo: req.payTo,
      asset: req.asset ?? this.defaultAsset,
      resource: req.resource ?? this.resourceEndpoint,
      description: req.description,
      mimeType: req.mimeType,
      maxTimeoutSeconds: req.maxTimeoutSeconds,
      extra: req.extra,
    };

    return {
      state: {
        result: null,
        paymentTxHash: null,
        amountPaid: requirement.maxAmountRequired,
        asset: requirement.asset,
        network: requirement.network,
        flow: "requirement-read",
      },
      paymentRequired: requirement,
    };
  }

  // --- Stage 2: preparePayment ------------------------------------------------
  async preparePayment(requirement: PaymentRequirement): Promise<AvmPaymentPayload> {
    const req = requirement as AvmPaymentRequirement;

    // Re-shape our requirement into the @x402-avm/core PaymentRequirements
    // contract. The actual atomic group is built + signed in sign(), which is
    // where ExactAvmScheme fetches suggested params and ed25519-signs.
    const sdkRequirement: AvmSdkRequirements = {
      scheme: "exact",
      network: req.network as AvmSdkRequirements["network"],
      asset: String(req.asset),
      amount: req.maxAmountRequired,
      payTo: req.payTo,
      maxTimeoutSeconds: req.maxTimeoutSeconds ?? 60,
      extra: req.extra ?? {},
    };

    return { requirement: req, sdkRequirement };
  }

  // --- Stage 3: sign ----------------------------------------------------------
  async sign(payload: PaymentPayload): Promise<SignedPayload> {
    const p = payload as AvmPaymentPayload;

    // ExactAvmScheme builds the (optionally fee-abstracted) atomic group and
    // ed25519-signs the client transactions, returning the x402 v2 partial
    // payload { paymentGroup, paymentIndex }.
    const partial = await this.scheme.createPaymentPayload(2, p.sdkRequirement);

    // Assemble the full x402 PaymentPayload exactly as the reference HTTP client
    // does, then base64-encode it for the PAYMENT-SIGNATURE header.
    const wire: AvmWirePayload = {
      x402Version: 2,
      payload: partial.payload,
      resource: { url: p.requirement.resource },
      accepted: p.sdkRequirement,
    };

    return { payload: p, signature: encodePaymentSignatureHeader(wire) };
  }

  // --- Stage 4: submit --------------------------------------------------------
  async submit(signed: SignedPayload, _context: RouteContext): Promise<SubmissionResult> {
    const payload = signed.payload as AvmPaymentPayload;
    const requirement = payload.requirement;

    // x402 v2 carries the encoded payload in the PAYMENT-SIGNATURE header; the
    // facilitator-backed resource verifies + settles inline and replies with a
    // base64 SettleResponse in PAYMENT-RESPONSE (X-PAYMENT-RESPONSE fallback).
    const res = await fetch(requirement.resource, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "PAYMENT-SIGNATURE": signed.signature,
      },
    });

    const responseData = await safeJson(res);

    const settleHeader =
      res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
    let settle: SettleResponse | null = null;
    if (settleHeader) {
      try {
        settle = decodePaymentResponseHeader(settleHeader) as SettleResponse;
      } catch {
        settle = null;
      }
    }

    // 200 → server settled inline. If a SettleResponse is present, honour its
    // success flag; otherwise fall back to the HTTP status.
    const accepted = res.ok && (settle ? settle.success : true);
    const txHash = settle?.transaction ?? null;

    return {
      accepted,
      txHash,
      requirement,
      responseData,
      // exact scheme → do NOT set actualCharge (no circuit-breaker path).
    };
  }

  // --- Stage 5: awaitFinality -------------------------------------------------
  async awaitFinality(result: SubmissionResult): Promise<FinalityStatus<AlgorandState>> {
    const requirement = result.requirement as AvmPaymentRequirement;
    let finalized = false;
    let confirmedHash = result.txHash;

    if (result.txHash) {
      try {
        // Algorand single-block finality — a few rounds is plenty.
        await algosdk.waitForConfirmation(this.algod, result.txHash, 5);
        finalized = true;
      } catch {
        finalized = false;
      }
    }

    return {
      finalized,
      txHash: confirmedHash,
      state: {
        result: result.responseData,
        paymentTxHash: confirmedHash,
        amountPaid: requirement.maxAmountRequired,
        asset: requirement.asset,
        network: requirement.network,
        flow: finalized ? "finalized" : "submitted",
      },
    };
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
