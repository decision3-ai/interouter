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
 * ───────────────────────────────────────────────────────────────────────────
 * ⚠️ WIRE-FORMAT CONFIRMATION POINTS (read-only by design until verified)
 * Three spots are marked `CONFIRM:` below. They are the AVM-specific encodings
 * that must match GoPlausible's @x402-avm spec EXACTLY before sending real funds:
 *   1. How the 402 PaymentRequirements are surfaced (header name vs JSON body)
 *   2. The exact X-PAYMENT header name + payload JSON shape for AVM `exact`
 *   3. Whether settlement uses fee-abstraction atomic groups (facilitator co-signs)
 * GoPlausible docs are public:
 *   github.com/GoPlausible/.github/tree/main/profile/algorand-x402-documentation
 * Until these are confirmed against their types, keep this adapter on TESTNET.
 * ───────────────────────────────────────────────────────────────────────────
 */

import algosdk from "algosdk";

// Canonical AVM constants — import from GoPlausible rather than hardcoding
// genesis hashes / ASA ids. CONFIRM these export names against the installed
// @x402-avm/avm version (v2.6+).
import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  // USDC asset ids exposed by the package; confirm exact export names.
  USDC_TESTNET_ASA_ID,
} from "@x402-avm/avm";

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

/** Unsigned AVM payment: the encoded transaction(s) to be signed. */
export interface AvmPaymentPayload extends PaymentPayload {
  requirement: AvmPaymentRequirement;
  /** Unsigned transaction bytes (msgpack), base64-encoded. */
  unsignedTxnB64: string;
  /** Transaction id, threaded through to finality confirmation. */
  txId: string;
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

    this.network = config.network ?? ALGORAND_MAINNET_CAIP2;
    // Default asset: USDC. Testnet uses USDC_TESTNET_ASA_ID; mainnet USDC ASA is
    // 31566704. CONFIRM the mainnet constant export name in @x402-avm/avm.
    this.defaultAsset =
      config.asset ??
      (this.network === ALGORAND_TESTNET_CAIP2 ? Number(USDC_TESTNET_ASA_ID) : 31566704);
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

    const params = await this.algod.getTransactionParams().do();

    // exact-scheme USDC (ASA) transfer to payTo for the required amount.
    // CONFIRM #3: GoPlausible may wrap this in a fee-abstraction atomic group
    // where the facilitator co-signs a fee-covering txn (so the buyer needs no
    // ALGO for gas). For the first transactional version we send a plain ASA
    // transfer; the atomic-group enhancement is added once confirmed.
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: this.account.addr,
      receiver: req.payTo,
      amount: BigInt(req.maxAmountRequired),
      assetIndex: req.asset,
      suggestedParams: params,
    });

    const unsignedTxnB64 = Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString("base64");

    return {
      requirement: req,
      unsignedTxnB64,
      txId: txn.txID(),
    };
  }

  // --- Stage 3: sign ----------------------------------------------------------
  async sign(payload: PaymentPayload): Promise<SignedPayload> {
    const p = payload as AvmPaymentPayload;
    const unsigned = algosdk.decodeUnsignedTransaction(
      Buffer.from(p.unsignedTxnB64, "base64"),
    );
    const signedBytes = unsigned.signTxn(this.account.sk);
    return {
      payload: p,
      signature: Buffer.from(signedBytes).toString("base64"),
    };
  }

  // --- Stage 4: submit --------------------------------------------------------
  async submit(signed: SignedPayload, _context: RouteContext): Promise<SubmissionResult> {
    const payload = signed.payload as AvmPaymentPayload;
    const requirement = payload.requirement;

    // CONFIRM #2: the exact x402-avm payment header name + JSON shape.
    // OpenLedger uses base64(X402WirePayload) in a PAYMENT-SIGNATURE header and
    // re-requests the resource. The AVM equivalent wraps the signed txn group.
    const wire = {
      x402Version: 2,
      scheme: "exact",
      network: requirement.network,
      payload: {
        signedTxns: [signed.signature], // base64 signed txn(s)
      },
    };
    const paymentHeader = Buffer.from(JSON.stringify(wire)).toString("base64");

    const res = await fetch(requirement.resource, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-PAYMENT": paymentHeader, // CONFIRM header name
      },
    });

    const accepted = res.ok; // 200 → server verified + settled inline
    const responseData = await safeJson(res);
    // CONFIRM: tx hash header name (OpenLedger reads X-PAYMENT-TX-HASH).
    const txHash = res.headers.get("X-PAYMENT-TX-HASH") ?? payload.txId ?? null;

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
