import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InterouterRouter, NotSupportedError } from "./router.js";
import type {
  ChainAdapter,
  InferenceProvider,
  RouteContext,
  AdapterError,
  PaymentRequirement,
} from "./router.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ctx: RouteContext = { path: "/test", params: {} };

/** Creates a read-only adapter that returns the given value from readState(). */
function makeAdapter<T>(id: string, value: T, delayMs = 0): ChainAdapter<T> {
  return {
    id,
    readState: () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ state: value, paymentRequired: null }), delayMs),
      ),
    preparePayment: () => { throw new NotSupportedError(id, "preparePayment"); },
    sign: () => { throw new NotSupportedError(id, "sign"); },
    submit: () => { throw new NotSupportedError(id, "submit"); },
    awaitFinality: () => { throw new NotSupportedError(id, "awaitFinality"); },
  };
}

function makeFailingAdapter(id: string, message = "boom"): ChainAdapter {
  return {
    id,
    readState: () => Promise.reject(new Error(message)),
    preparePayment: () => { throw new NotSupportedError(id, "preparePayment"); },
    sign: () => { throw new NotSupportedError(id, "sign"); },
    submit: () => { throw new NotSupportedError(id, "submit"); },
    awaitFinality: () => { throw new NotSupportedError(id, "awaitFinality"); },
  };
}

function makeSlowAdapter(id: string, delayMs: number): ChainAdapter {
  return {
    id,
    readState: () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ state: { slow: true }, paymentRequired: null }), delayMs),
      ),
    preparePayment: () => { throw new NotSupportedError(id, "preparePayment"); },
    sign: () => { throw new NotSupportedError(id, "sign"); },
    submit: () => { throw new NotSupportedError(id, "submit"); },
    awaitFinality: () => { throw new NotSupportedError(id, "awaitFinality"); },
  };
}

/** Creates an adapter that signals payment required and completes the full lifecycle. */
function makePayingAdapter<T>(
  id: string,
  initialState: T,
  finalState: T,
  requirement: PaymentRequirement,
): ChainAdapter<T> {
  return {
    id,
    readState: async () => ({ state: initialState, paymentRequired: requirement }),
    preparePayment: async (req) => ({ requirement: req }),
    sign: async (payload) => ({ payload, signature: "0xfakesig" }),
    submit: async (signed) => ({
      accepted: true,
      txHash: "0xdeadbeef",
      requirement: signed.payload.requirement,
      responseData: "inference-result",
    }),
    awaitFinality: async () => ({
      finalized: true,
      txHash: "0xdeadbeef",
      state: finalState,
    }),
  };
}

function isAdapterError(v: unknown): v is AdapterError {
  return typeof v === "object" && v !== null && (v as AdapterError).error === true;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InterouterRouter.resolve()", () => {

  it("1. all adapters succeed — chainState populated correctly", async () => {
    const router = new InterouterRouter({
      adapters: [
        makeAdapter("near", { balance: 100 }),
        makeAdapter("sui",  { objects: 3 }),
      ],
    });

    const result = await router.resolve(ctx);

    assert.deepEqual(result.chainState["near"], { balance: 100 });
    assert.deepEqual(result.chainState["sui"],  { objects: 3 });
    assert.equal(typeof result.resolvedInMs, "number");
    assert.ok(result.resolvedInMs >= 0);
    assert.ok(!isNaN(Date.parse(result.resolvedAt)), "resolvedAt should be a valid ISO string");
    assert.equal(result.inference, null);
  });

  it("2. one adapter rejects — AdapterError stored, others unaffected", async () => {
    const router = new InterouterRouter({
      adapters: [
        makeAdapter("near", { balance: 42 }),
        makeFailingAdapter("sui", "contract error"),
      ],
    });

    const result = await router.resolve(ctx);

    assert.deepEqual(result.chainState["near"], { balance: 42 });
    const suiResult = result.chainState["sui"];
    assert.ok(isAdapterError(suiResult), "sui entry should be an AdapterError");
    assert.equal((suiResult as AdapterError).reason, "contract error");
  });

  it("3. adapter times out — AdapterError with timeout reason, resolve completes", async () => {
    const timeoutMs = 50;
    const router = new InterouterRouter({
      adapters: [makeSlowAdapter("walrus", 500)],
      adapterTimeoutMs: timeoutMs,
    });

    const before = Date.now();
    const result = await router.resolve(ctx);
    const elapsed = Date.now() - before;

    const walrusResult = result.chainState["walrus"];
    assert.ok(isAdapterError(walrusResult), "walrus entry should be an AdapterError");
    assert.ok(
      (walrusResult as AdapterError).reason.includes("timed out"),
      `reason should mention 'timed out', got: ${(walrusResult as AdapterError).reason}`,
    );
    // Should have completed near the timeout, not the full 500ms
    assert.ok(elapsed < 400, `resolve() should complete near timeout, took ${elapsed}ms`);
  });

  it("4. no adapters — empty chainState, valid metadata", async () => {
    const router = new InterouterRouter({ adapters: [] });
    const result = await router.resolve(ctx);

    assert.deepEqual(result.chainState, {});
    assert.equal(result.inference, null);
    assert.equal(typeof result.resolvedInMs, "number");
    assert.ok(!isNaN(Date.parse(result.resolvedAt)));
  });

  it("5. AI provider succeeds — inference field populated", async () => {
    const aiProvider: InferenceProvider = {
      id: "test-ai",
      infer: async (input) => ({ recommendation: "buy", inputKeys: Object.keys(input as object) }),
    };

    const router = new InterouterRouter({
      adapters: [makeAdapter("near", { balance: 10 })],
      aiProvider,
    });

    const result = await router.resolve(ctx);

    assert.ok(result.inference !== null, "inference should not be null");
    assert.equal((result.inference as { recommendation: string }).recommendation, "buy");
  });

  it("6. AI provider throws — inference is null, resolve() does not throw", async () => {
    const aiProvider: InferenceProvider = {
      id: "broken-ai",
      infer: async () => { throw new Error("model unavailable"); },
    };

    const router = new InterouterRouter({
      adapters: [makeAdapter("near", { balance: 10 })],
      aiProvider,
    });

    const result = await router.resolve(ctx);

    assert.equal(result.inference, null);
    assert.deepEqual(result.chainState["near"], { balance: 10 });
  });

  it("7. duplicate adapter ids — last writer wins", async () => {
    const router = new InterouterRouter({
      adapters: [
        makeAdapter("near", { balance: 1 }),
        makeAdapter("near", { balance: 2 }),
      ],
    });

    const result = await router.resolve(ctx);

    // Both adapters run; the second one overwrites the first in the chainState loop.
    assert.deepEqual(result.chainState["near"], { balance: 2 });
  });

  it("8. parallel execution — two slow adapters finish in ~max(delays), not sum", async () => {
    const router = new InterouterRouter({
      adapters: [
        makeAdapter("near", "a", 80),
        makeAdapter("sui",  "b", 80),
      ],
    });

    const before = Date.now();
    await router.resolve(ctx);
    const elapsed = Date.now() - before;

    // Sequential would be ~160ms; parallel should be well under that.
    assert.ok(elapsed < 140, `adapters should run in parallel, took ${elapsed}ms`);
  });

  it("9. payment lifecycle — router orchestrates readState → preparePayment → sign → submit → awaitFinality", async () => {
    const requirement: PaymentRequirement = {
      scheme: "exact",
      network: "test-net",
      maxAmountRequired: "1000",
    };

    const router = new InterouterRouter({
      adapters: [
        makePayingAdapter(
          "openledger",
          { partial: true },       // initial state from readState
          { complete: true },      // final state from awaitFinality
          requirement,
        ),
      ],
    });

    const result = await router.resolve(ctx);

    // The router should have run the full lifecycle and stored the final state.
    assert.deepEqual(result.chainState["openledger"], { complete: true });
  });

  it("10. payment lifecycle failure — sign throws → AdapterError", async () => {
    const requirement: PaymentRequirement = {
      scheme: "exact",
      network: "test-net",
      maxAmountRequired: "1000",
    };

    const adapter: ChainAdapter = {
      id: "broken-pay",
      readState: async () => ({ state: { partial: true }, paymentRequired: requirement }),
      preparePayment: async (req) => ({ requirement: req }),
      sign: async () => { throw new Error("signing key expired"); },
      submit: async (signed) => ({
        accepted: true,
        txHash: "0x0",
        requirement: signed.payload.requirement,
        responseData: null,
      }),
      awaitFinality: async () => ({
        finalized: true,
        txHash: "0x0",
        state: {},
      }),
    };

    const router = new InterouterRouter({ adapters: [adapter] });
    const result = await router.resolve(ctx);

    const entry = result.chainState["broken-pay"];
    assert.ok(isAdapterError(entry), "broken-pay should be an AdapterError");
    assert.ok(
      (entry as AdapterError).reason.includes("signing key expired"),
      `reason should contain signing error, got: ${(entry as AdapterError).reason}`,
    );
  });

});
