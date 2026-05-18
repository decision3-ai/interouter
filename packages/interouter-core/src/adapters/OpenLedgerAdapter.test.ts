import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { OpenLedgerAdapter, OpenLedgerAdapterError } from "./OpenLedgerAdapter.js";
import type {
  OpenLedgerAdapterConfig,
  PaymentPayload,
  PaymentRequirement,
} from "./OpenLedgerAdapter.js";

// ---------------------------------------------------------------------------
// Test constants — anvil/hardhat default accounts, safe to commit
// ---------------------------------------------------------------------------

const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const TEST_SIGNER    = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const TEST_RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const TEST_ASSET     = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;

const BASE_CONFIG: OpenLedgerAdapterConfig = {
  inferenceEndpoint: "https://api.dgrid.test/v1/inference",
  chainId: 97, // BNB testnet
  rpcUrl: "https://rpc.bnb.test",
  signerAddress: TEST_SIGNER,
  privateKey: TEST_PRIVATE_KEY,
};

const SAMPLE_REQUIREMENT: PaymentRequirement = {
  scheme: "exact",
  network: "bnb-testnet",
  maxAmountRequired: "1000000",
  resource: "https://api.dgrid.test/v1/inference/task-abc",
  description: "DGrid LLM inference",
  mimeType: "application/json",
  payTo: TEST_RECIPIENT,
  maxTimeoutSeconds: 300,
  asset: TEST_ASSET,
};

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

// ---------------------------------------------------------------------------
// Restore fetch and env between tests
// ---------------------------------------------------------------------------

const _originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = _originalFetch;
  delete process.env["OPENLEDGER_PRIVATE_KEY"];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenLedgerAdapter", () => {

  // --- Constructor ---

  it("1. constructor throws OpenLedgerAdapterError when no private key is available", () => {
    const { privateKey: _omitted, ...configWithoutKey } = BASE_CONFIG;
    delete process.env["OPENLEDGER_PRIVATE_KEY"];
    assert.throws(
      () => new OpenLedgerAdapter(configWithoutKey),
      (err: unknown) => {
        assert.ok(err instanceof OpenLedgerAdapterError);
        assert.ok(err.message.includes("private key is required"));
        return true;
      },
    );
  });

  it("2. constructor reads private key from OPENLEDGER_PRIVATE_KEY env var when config omits it", () => {
    const { privateKey: _omitted, ...configWithoutKey } = BASE_CONFIG;
    process.env["OPENLEDGER_PRIVATE_KEY"] = TEST_PRIVATE_KEY;
    assert.doesNotThrow(() => new OpenLedgerAdapter(configWithoutKey));
  });

  it("3. constructor normalises private key missing 0x prefix", () => {
    const keyWithout0x = TEST_PRIVATE_KEY.slice(2); // strip "0x"
    assert.doesNotThrow(
      () => new OpenLedgerAdapter({ ...BASE_CONFIG, privateKey: keyWithout0x as `0x${string}` }),
    );
  });

  // --- fetchState: free tier ---

  it("4. free tier (200) — returns idle flow, inference result populated, no payment", async () => {
    const inferenceBody = { answer: "42", model: "dgrid-v1" };
    const spy = spyFetch(makeResponse(200, inferenceBody));
    globalThis.fetch = spy.fn;

    const adapter = new OpenLedgerAdapter(BASE_CONFIG);
    const result = await adapter.fetchState({ path: "/infer", params: {} });

    assert.equal(spy.calls.length, 1, "should only make one request");
    assert.deepEqual(result.inferenceResult, inferenceBody);
    assert.equal(result.amountPaid, "0");
    assert.equal(result.paymentTxHash, null);
    assert.equal(result.tokenAddress, null);
    assert.equal(result.flow.status, "idle");
  });

  // --- fetchState: x402 happy path ---

  it("5. x402 happy path — signs EIP-712, sends X-PAYMENT header, returns complete flow", async () => {
    const inferenceBody = { answer: "the meaning of life", model: "dgrid-v1" };
    const txHash = "0xdeadbeef00000000000000000000000000000000000000000000000000000001";

    const spy = spyFetch(
      makeResponse(402, { accepts: [SAMPLE_REQUIREMENT] }),
      makeResponse(200, inferenceBody, { "x-payment-tx-hash": txHash }),
    );
    globalThis.fetch = spy.fn;

    const adapter = new OpenLedgerAdapter(BASE_CONFIG);
    const result = await adapter.fetchState({ path: "/infer", params: {} });

    // Two requests made.
    assert.equal(spy.calls.length, 2, "should make initial request and paid retry");

    // Second request carries X-PAYMENT header.
    const secondRequest = spy.calls[1];
    assert.ok(secondRequest !== undefined);
    const paymentHeader = secondRequest.headers.get("X-PAYMENT");
    assert.ok(paymentHeader !== null, "X-PAYMENT header must be present on retry");

    // Decode and validate the payment payload.
    const decoded = JSON.parse(atob(paymentHeader)) as PaymentPayload;
    assert.equal(decoded.x402Version, 1);
    assert.equal(decoded.scheme, "exact");
    assert.equal(decoded.network, "bnb-testnet");
    assert.ok(
      decoded.payload.signature.startsWith("0x") && decoded.payload.signature.length === 132,
      `signature should be a 65-byte hex string, got: ${decoded.payload.signature}`,
    );
    assert.equal(decoded.payload.authorization.recipient, TEST_RECIPIENT);
    assert.equal(decoded.payload.authorization.amount, "1000000");
    assert.equal(decoded.payload.authorization.from, TEST_SIGNER);

    // Result shape.
    assert.deepEqual(result.inferenceResult, inferenceBody);
    assert.equal(result.amountPaid, "1000000");
    assert.equal(result.tokenAddress, TEST_ASSET);
    assert.equal(result.paymentTxHash, txHash);
    assert.equal(result.flow.status, "complete");
    if (result.flow.status === "complete") {
      assert.equal(result.flow.txHash, txHash);
      assert.equal(result.flow.amountPaid, "1000000");
      assert.equal(result.flow.tokenAddress, TEST_ASSET);
    }
  });

  // --- fetchState: signing failure ---

  it("6. signing throws — returns failed stage, fetchState() never rejects", async () => {
    const spy = spyFetch(makeResponse(402, { accepts: [SAMPLE_REQUIREMENT] }));
    globalThis.fetch = spy.fn;

    const adapter = new OpenLedgerAdapter(BASE_CONFIG);
    // Monkey-patch the private account to simulate a viem signing failure.
    (adapter as unknown as { account: { signTypedData: () => Promise<never> } })
      .account.signTypedData = async () => {
        throw new Error("viem: domain separator mismatch");
      };

    const result = await adapter.fetchState({ path: "/infer", params: {} });

    assert.equal(spy.calls.length, 1, "should not retry after signing failure");
    assert.equal(result.flow.status, "failed");
    if (result.flow.status === "failed") {
      assert.ok(
        result.flow.reason.includes("viem: domain separator mismatch"),
        `reason should contain the signing error, got: ${result.flow.reason}`,
      );
    }
    assert.equal(result.inferenceResult, null);
    assert.equal(result.amountPaid, "0");
  });

  // --- fetchState: post-payment HTTP error ---

  it("7. post-payment non-200 response — returns failed stage, does not throw", async () => {
    const spy = spyFetch(
      makeResponse(402, { accepts: [SAMPLE_REQUIREMENT] }),
      makeResponse(503, { error: "service unavailable" }),
    );
    globalThis.fetch = spy.fn;

    const adapter = new OpenLedgerAdapter(BASE_CONFIG);
    const result = await adapter.fetchState({ path: "/infer", params: {} });

    assert.equal(spy.calls.length, 2, "should attempt both requests");
    assert.equal(result.flow.status, "failed");
    if (result.flow.status === "failed") {
      assert.ok(
        result.flow.reason.includes("503"),
        `reason should include HTTP status, got: ${result.flow.reason}`,
      );
    }
    assert.equal(result.inferenceResult, null);
  });

  // --- fetchState: malformed 402 body ---

  it("8. malformed 402 body — rejects with OpenLedgerAdapterError (caught by router)", async () => {
    for (const badBody of [null, {}, { accepts: [] }, { accepts: "not-an-array" }]) {
      const spy = spyFetch(makeResponse(402, badBody));
      globalThis.fetch = spy.fn;

      const adapter = new OpenLedgerAdapter(BASE_CONFIG);
      await assert.rejects(
        () => adapter.fetchState({ path: "/infer", params: {} }),
        (err: unknown) => {
          assert.ok(err instanceof OpenLedgerAdapterError);
          assert.ok(err.message.includes("missing valid payment requirement"));
          return true;
        },
        `expected rejection for body: ${JSON.stringify(badBody)}`,
      );
    }
  });

});
