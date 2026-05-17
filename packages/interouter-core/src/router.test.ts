import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InterouterRouter } from "./router.js";
import type { ChainAdapter, InferenceProvider, RouteContext, AdapterError } from "./router.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ctx: RouteContext = { path: "/test", params: {} };

function makeAdapter<T>(id: string, value: T, delayMs = 0): ChainAdapter<T> {
  return {
    id,
    fetchState: () =>
      new Promise((resolve) => setTimeout(() => resolve(value), delayMs)),
  };
}

function makeFailingAdapter(id: string, message = "boom"): ChainAdapter {
  return {
    id,
    fetchState: () => Promise.reject(new Error(message)),
  };
}

function makeSlowAdapter(id: string, delayMs: number): ChainAdapter {
  return {
    id,
    fetchState: () =>
      new Promise((resolve) => setTimeout(() => resolve({ slow: true }), delayMs)),
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

});
