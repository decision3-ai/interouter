/**
 * AlgorandAdapter tests.
 *
 * These exercise the adapter's lifecycle WITHOUT hitting the real network:
 * `fetch` is stubbed. This keeps them in the unit-test suite (fast,
 * deterministic) alongside the other adapter tests. Real testnet settlement is
 * a separate integration step.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import algosdk from "algosdk";
import { encodePaymentResponseHeader, encodePaymentRequiredHeader } from "@x402-avm/core/http";
import { AlgorandAdapter, AlgorandAdapterError } from "./AlgorandAdapter.js";
import type { RouteContext } from "../router.js";

const ctx: RouteContext = { path: "/api/inference", params: {} };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  const lc = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
    headers: { get: (key: string) => lc[key.toLowerCase()] ?? null },
  } as unknown as Response;
}

/** Captures all fetch calls and their arguments for inspection. */
function spyFetch(...responses: Response[]): { calls: Request[]; fn: typeof fetch } {
  const calls: Request[] = [];
  let i = 0;
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(new Request(input, init));
    return responses[i++] ?? makeResponse(500, { error: "no mock response" });
  }) as typeof fetch;
  return { calls, fn };
}

/** Builds an adapter with a fresh, checksum-valid throwaway mnemonic. */
function makeAdapter(): AlgorandAdapter {
  const acct = algosdk.generateAccount();
  const mnemonic = algosdk.secretKeyToMnemonic(acct.sk);
  return new AlgorandAdapter({
    mnemonic,
    resourceEndpoint: "https://example.test/api/inference",
    algodUrl: "https://testnet-api.test",
    network: undefined, // defaults to mainnet const; fine for unit tests
  });
}

// ---------------------------------------------------------------------------
// Restore fetch and env between tests
// ---------------------------------------------------------------------------

const _originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = _originalFetch;
  delete process.env["ALGORAND_MNEMONIC"];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AlgorandAdapter", () => {
  it("1. throws if no mnemonic is provided", () => {
    delete process.env["ALGORAND_MNEMONIC"];
    assert.throws(
      () =>
        new AlgorandAdapter({
          resourceEndpoint: "https://example.test/api/inference",
          algodUrl: "https://testnet-api.test",
        }),
      AlgorandAdapterError,
    );
  });

  it("2. throws on an invalid mnemonic", () => {
    assert.throws(
      () =>
        new AlgorandAdapter({
          mnemonic: "not a real mnemonic",
          resourceEndpoint: "https://example.test/api/inference",
          algodUrl: "https://testnet-api.test",
        }),
      AlgorandAdapterError,
    );
  });

  it("3. readState returns paymentRequired: null when resource is open (non-402)", async () => {
    const adapter = makeAdapter();
    const spy = spyFetch(makeResponse(200, { ok: true }));
    globalThis.fetch = spy.fn;

    const result = await adapter.readState(ctx);
    assert.equal(result.paymentRequired, null);
    assert.equal(result.state.flow, "idle");
  });

  it("4. readState surfaces an AVM PaymentRequirement on 402", async () => {
    const adapter = makeAdapter();
    // Real wire format: PAYMENT-REQUIRED header holds a base64 PaymentRequired object.
    const prHeader = encodePaymentRequiredHeader({
      x402Version: 2,
      resource: { url: "https://example.test/api/inference", description: "", mimeType: "application/json" },
      accepts: [{
        scheme: "exact",
        network: "algorand:test",
        amount: "10000",
        payTo: "RECEIVER".padEnd(58, "A"),
        asset: "12345",
        maxTimeoutSeconds: 60,
        extra: {},
      }],
    });
    const spy = spyFetch(makeResponse(402, {}, { "PAYMENT-REQUIRED": prHeader }));
    globalThis.fetch = spy.fn;

    const result = await adapter.readState(ctx);
    assert.notEqual(result.paymentRequired, null);
    assert.equal(result.paymentRequired?.scheme, "exact");
    assert.equal(result.paymentRequired?.maxAmountRequired, "10000");
    assert.equal(result.state.flow, "requirement-read");
  });

  it("5. throws if 402 returns no PAYMENT-REQUIRED header", async () => {
    const adapter = makeAdapter();
    const spy = spyFetch(makeResponse(402, {}));
    globalThis.fetch = spy.fn;

    await assert.rejects(adapter.readState(ctx), AlgorandAdapterError);
  });

  it("6. reads txHash from the settlement response and leaves actualCharge unset", async () => {
    const adapter = makeAdapter();
    const requirement = {
      scheme: "exact" as const,
      network: "algorand:test",
      maxAmountRequired: "10000",
      payTo: "RECEIVER".padEnd(58, "A"),
      asset: 12345,
      resource: "https://example.test/api/inference",
    };
    // x402 v2 settlement comes back in the PAYMENT-RESPONSE header as a base64
    // SettleResponse; the adapter decodes it and surfaces `transaction` as txHash.
    const settleHeader = encodePaymentResponseHeader({
      success: true,
      transaction: "TESTHASH",
      network: "algorand:test",
      payer: requirement.payTo,
    });
    const spy = spyFetch(makeResponse(200, { ok: true }, { "PAYMENT-RESPONSE": settleHeader }));
    globalThis.fetch = spy.fn;

    const signed = {
      payload: { requirement, sdkRequirement: {} },
      signature: "c2lnbmF0dXJl",
    };
    const submission = await adapter.submit(signed as never, ctx);
    assert.equal(submission.actualCharge, undefined);
    assert.equal(submission.accepted, true);
    assert.equal(submission.txHash, "TESTHASH");
  });
});
