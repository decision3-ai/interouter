import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { OpenGradientAdapter, OpenGradientAdapterError } from "./OpenGradientAdapter.js";
import type {
  OpenGradientAdapterConfig,
  OpenGradientWirePayload,
  OpenGradientPaymentRequirement,
} from "./OpenGradientAdapter.js";

// ---------------------------------------------------------------------------
// Test constants — anvil/hardhat default accounts, safe to commit
// ---------------------------------------------------------------------------

const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const TEST_SIGNER    = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const TEST_RECIPIENT = "0x339c7de83d1a62edafbaac186382ee76584d294f" as const; // real OpenGradient payTo
const TEST_ASSET     = "0x240b09731D96979f50B2C649C9CE10FcF9C7987F" as const; // real $OPG testnet

const BASE_CONFIG: OpenGradientAdapterConfig = {
  inferenceEndpoint: "https://llm.opengradient.ai",
  chainId: 84532, // Base Sepolia testnet
  rpcUrl: "https://sepolia.base.org",
  signerAddress: TEST_SIGNER,
  privateKey: TEST_PRIVATE_KEY,
};

const SAMPLE_REQUIREMENT: OpenGradientPaymentRequirement = {
  scheme: "exact",
  network: "eip155:84532",
  maxAmountRequired: "1000000",
  resource: "https://llm.opengradient.ai/v1/chat/completions",
  payTo: TEST_RECIPIENT,
  maxTimeoutSeconds: 300,
  asset: TEST_ASSET,
  extra: { name: "OPG", version: "1" },
};

// 402 body uses accepts[] wrapper
const MOCK_402_BODY = { accepts: [SAMPLE_REQUIREMENT] };

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
  delete process.env["OPENGRADIENT_PRIVATE_KEY"];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenGradientAdapter", () => {

  // --- Constructor ---

  it("1. constructor throws OpenGradientAdapterError when no private key is available", () => {
    const { privateKey: _omitted, ...configWithoutKey } = BASE_CONFIG;
    delete process.env["OPENGRADIENT_PRIVATE_KEY"];
    assert.throws(
      () => new OpenGradientAdapter(configWithoutKey),
      (err: unknown) => {
        assert.ok(err instanceof OpenGradientAdapterError);
        assert.ok(err.message.includes("private key is required"));
        return true;
      },
    );
  });

  it("2. constructor reads private key from OPENGRADIENT_PRIVATE_KEY env var when config omits it", () => {
    const { privateKey: _omitted, ...configWithoutKey } = BASE_CONFIG;
    process.env["OPENGRADIENT_PRIVATE_KEY"] = TEST_PRIVATE_KEY;
    assert.doesNotThrow(() => new OpenGradientAdapter(configWithoutKey));
  });

  it("3. constructor normalises private key missing 0x prefix", () => {
    const keyWithout0x = TEST_PRIVATE_KEY.slice(2);
    assert.doesNotThrow(
      () => new OpenGradientAdapter({ ...BASE_CONFIG, privateKey: keyWithout0x as `0x${string}` }),
    );
  });

  // --- readState: free tier ---

  it("4. free tier (200) — readState returns idle flow, inference result populated, no payment required", async () => {
    const inferenceBody = { answer: "42", model: "opengradient-v1" };
    const spy = spyFetch(makeResponse(200, inferenceBody));
    globalThis.fetch = spy.fn;

    const adapter = new OpenGradientAdapter(BASE_CONFIG);
    const { state, paymentRequired } = await adapter.readState({ path: "/infer", params: {} });

    assert.equal(spy.calls.length, 1, "should only make one request");
    assert.deepEqual(state.inferenceResult, inferenceBody);
    assert.equal(state.amountPaid, "0");
    assert.equal(state.paymentTxHash, null);
    assert.equal(state.tokenAddress, null);
    assert.equal(state.flow.status, "idle");
    assert.equal(paymentRequired, null);
  });

  // --- readState: 402 surfaces payment requirement ---

  it("5. readState on 402 — surfaces payment requirement, no signing occurs", async () => {
    const spy = spyFetch(makeResponse(402, MOCK_402_BODY));
    globalThis.fetch = spy.fn;

    const adapter = new OpenGradientAdapter(BASE_CONFIG);
    const { state, paymentRequired } = await adapter.readState({ path: "/infer", params: {} });

    assert.equal(spy.calls.length, 1, "readState should only make the initial request");
    assert.ok(paymentRequired !== null, "paymentRequired should be set");
    assert.equal(paymentRequired.scheme, "exact");
    assert.equal(paymentRequired.network, "eip155:84532");
    assert.equal(paymentRequired.maxAmountRequired, "1000000");
    assert.equal(state.inferenceResult, null);
    assert.equal(state.flow.status, "payment_required");
  });

  // --- Full lifecycle ---

  it("6. full Permit2 lifecycle — preparePayment + sign + submit + awaitFinality produces complete state", async () => {
    const inferenceBody = { answer: "the meaning of life", model: "opengradient-v1" };
    const txHash = "0xdeadbeef00000000000000000000000000000000000000000000000000000001";

    const spy = spyFetch(
      makeResponse(402, MOCK_402_BODY),
      makeResponse(200, inferenceBody, { "x-payment-tx-hash": txHash }),
    );
    globalThis.fetch = spy.fn;

    const adapter = new OpenGradientAdapter(BASE_CONFIG);
    const ctx = { path: "/infer", params: {} };

    // Step 1: readState
    const { paymentRequired } = await adapter.readState(ctx);
    assert.ok(paymentRequired !== null);

    // Step 2: preparePayment
    const payload = await adapter.preparePayment(paymentRequired);
    assert.ok(payload.requirement === paymentRequired);

    // Step 3: sign — Permit2 EIP-712 produces a 65-byte hex signature
    const signed = await adapter.sign(payload);
    assert.ok(
      signed.signature.startsWith("0x") && signed.signature.length === 132,
      `signature should be a 65-byte hex string, got: ${signed.signature}`,
    );

    // Step 4: submit
    const submission = await adapter.submit(signed, ctx);
    assert.equal(submission.accepted, true);
    assert.equal(submission.txHash, txHash);

    // Verify PAYMENT-SIGNATURE header was sent on the retry request.
    assert.equal(spy.calls.length, 2, "should make initial request and paid retry");
    const secondRequest = spy.calls[1];
    assert.ok(secondRequest !== undefined);
    const paymentHeader = secondRequest.headers.get("PAYMENT-SIGNATURE");
    assert.ok(paymentHeader !== null, "PAYMENT-SIGNATURE header must be present on retry");

    // Decode and validate the wire payload.
    const decoded = JSON.parse(atob(paymentHeader)) as OpenGradientWirePayload;
    assert.equal(decoded.x402Version, 1);
    assert.equal(decoded.scheme, "exact");
    assert.equal(decoded.network, "eip155:84532");
    assert.equal(decoded.payload.permit.permitted.token, TEST_ASSET);
    assert.equal(decoded.payload.permit.permitted.amount, "1000000");
    assert.equal(decoded.payload.permit.spender, TEST_RECIPIENT);
    assert.ok(typeof decoded.payload.permit.nonce === "string", "nonce should be serialised string");
    assert.ok(typeof decoded.payload.permit.deadline === "string", "deadline should be serialised string");

    // Step 5: awaitFinality
    const finality = await adapter.awaitFinality(submission);
    assert.equal(finality.finalized, true);
    assert.equal(finality.txHash, txHash);
    assert.deepEqual(finality.state.inferenceResult, inferenceBody);
    assert.equal(finality.state.amountPaid, "1000000");
    assert.equal(finality.state.tokenAddress, TEST_ASSET);
    assert.equal(finality.state.paymentTxHash, txHash);
    assert.equal(finality.state.flow.status, "complete");
    if (finality.state.flow.status === "complete") {
      assert.equal(finality.state.flow.txHash, txHash);
      assert.equal(finality.state.flow.amountPaid, "1000000");
      assert.equal(finality.state.flow.tokenAddress, TEST_ASSET);
    }
  });

  // --- sign failure ---

  it("7. sign throws on signing failure — error is explicit, not hidden", async () => {
    const spy = spyFetch(makeResponse(402, MOCK_402_BODY));
    globalThis.fetch = spy.fn;

    const adapter = new OpenGradientAdapter(BASE_CONFIG);
    const { paymentRequired } = await adapter.readState({ path: "/infer", params: {} });
    assert.ok(paymentRequired !== null);

    const payload = await adapter.preparePayment(paymentRequired);

    // Monkey-patch the private account to simulate a viem signing failure.
    (adapter as unknown as { account: { signTypedData: () => Promise<never> } })
      .account.signTypedData = async () => {
        throw new Error("viem: domain separator mismatch");
      };

    await assert.rejects(
      () => adapter.sign(payload),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("viem: domain separator mismatch"));
        return true;
      },
    );

    assert.equal(spy.calls.length, 1, "should not retry after signing failure");
  });

  // --- submit: post-payment HTTP error ---

  it("8. submit returns accepted=false on post-payment non-200 response", async () => {
    const spy = spyFetch(
      makeResponse(402, MOCK_402_BODY),
      makeResponse(503, { error: "service unavailable" }),
    );
    globalThis.fetch = spy.fn;

    const adapter = new OpenGradientAdapter(BASE_CONFIG);
    const ctx = { path: "/infer", params: {} };
    const { paymentRequired } = await adapter.readState(ctx);
    assert.ok(paymentRequired !== null);

    const payload = await adapter.preparePayment(paymentRequired);
    const signed = await adapter.sign(payload);
    const submission = await adapter.submit(signed, ctx);

    assert.equal(submission.accepted, false);
    assert.equal(submission.txHash, null);
    assert.ok(
      typeof submission.responseData === "string" &&
      submission.responseData.includes("503"),
      `responseData should include HTTP status, got: ${String(submission.responseData)}`,
    );

    // awaitFinality should produce a failed state
    const finality = await adapter.awaitFinality(submission);
    assert.equal(finality.state.flow.status, "failed");
    if (finality.state.flow.status === "failed") {
      assert.ok(finality.state.flow.reason.includes("503"));
    }
    assert.equal(finality.state.inferenceResult, null);
  });

  // --- readState: malformed 402 body ---

  it("9. malformed 402 body — readState rejects with OpenGradientAdapterError", async () => {
    for (const badBody of [
      null,
      {},
      { accepts: [] },                                              // empty array
      { accepts: [{}] },                                            // missing all fields
      { accepts: [{ scheme: "exact" }] },                          // missing network, etc.
      { accepts: [{ scheme: "exact", network: "eip155:84532" }] }, // missing resource/payTo/asset
    ]) {
      const spy = spyFetch(makeResponse(402, badBody));
      globalThis.fetch = spy.fn;

      const adapter = new OpenGradientAdapter(BASE_CONFIG);
      await assert.rejects(
        () => adapter.readState({ path: "/infer", params: {} }),
        (err: unknown) => {
          assert.ok(err instanceof OpenGradientAdapterError);
          assert.ok(err.message.includes("missing valid payment requirement"));
          return true;
        },
        `expected rejection for body: ${JSON.stringify(badBody)}`,
      );
    }
  });

});
