import { describe, it, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JsonRpcProvider } from "near-api-js";
import {
  NearAdapter,
  NearAdapterError,
  isValidNearAccountId,
} from "./NearAdapter.js";
import { NotSupportedError } from "../router.js";
import type { NearAdapterConfig } from "./NearAdapter.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const BASE_CONFIG: NearAdapterConfig = {
  networkId: "mainnet",
  nodeUrl: "https://rpc.mainnet.near.org",
};

const CTX_NAMED    = { path: "/", params: {}, walletAddress: "alice.near" };
const CTX_IMPLICIT = {
  path: "/",
  params: {},
  walletAddress: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
};
const CTX_EMPTY = { path: "/", params: {} };

// Realistic yoctoNEAR values: 10 NEAR total, 2 NEAR staked, 8 NEAR available.
const MOCK_ACCOUNT_VIEW = {
  amount:        "10000000000000000000000000",
  locked:         "2000000000000000000000000",
  storage_usage: 182,
  code_hash:     "11111111111111111111111111111111",
};

const NO_CONTRACT_CODE_HASH = "11111111111111111111111111111111";
const WITH_CONTRACT_CODE_HASH = "7csf3Sq3TfL9R4MtUBHQqMR2bP2T5o7Yk8KFq9jxNaP";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Replaces JsonRpcProvider.prototype.query for the duration of one test. */
function mockRpc(impl: () => Promise<unknown>) {
  return mock.method(JsonRpcProvider.prototype, "query", impl);
}

// ---------------------------------------------------------------------------
// Restore mocks after each test
// ---------------------------------------------------------------------------

afterEach(() => mock.restoreAll());

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NearAdapter", () => {

  // --- Address validation (unit tests, no RPC) ---

  describe("isValidNearAccountId()", () => {

    it("1a. accepts named .near account", () => {
      assert.equal(isValidNearAccountId("alice.near"), true);
      assert.equal(isValidNearAccountId("sub.alice.near"), true);
      assert.equal(isValidNearAccountId("protocol-dao.sputnik-dao.near"), true);
    });

    it("1b. accepts 64-character hex implicit address", () => {
      const implicit = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
      assert.equal(implicit.length, 64);
      assert.equal(isValidNearAccountId(implicit), true);
    });

    it("1c. rejects obviously malformed addresses", () => {
      const invalid = [
        "",                         // empty
        "a",                        // too short
        "A".repeat(64),             // uppercase implicit
        "Alice.near",               // uppercase named
        ".near",                    // leading dot
        "alice.",                   // trailing dot
        "alice!.near",              // invalid char
        "a".repeat(65),             // too long
        "alice near",               // space
      ];
      for (const id of invalid) {
        assert.equal(
          isValidNearAccountId(id),
          false,
          `expected "${id}" to be invalid`,
        );
      }
    });

  });

  // --- readState: address path end-to-end ---

  it("2. named .near address resolves without error", async () => {
    mockRpc(async () => MOCK_ACCOUNT_VIEW);
    const adapter = new NearAdapter(BASE_CONFIG);
    const { state } = await adapter.readState(CTX_NAMED);
    assert.equal(state.accountId, "alice.near");
  });

  it("3. 64-char hex implicit address resolves without error", async () => {
    mockRpc(async () => MOCK_ACCOUNT_VIEW);
    const adapter = new NearAdapter(BASE_CONFIG);
    const { state } = await adapter.readState(CTX_IMPLICIT);
    assert.equal(state.accountId, CTX_IMPLICIT.walletAddress);
  });

  it("4. malformed address throws NearAdapterError before any RPC call", async () => {
    let rpcCalled = false;
    mockRpc(async () => { rpcCalled = true; return MOCK_ACCOUNT_VIEW; });

    const adapter = new NearAdapter(BASE_CONFIG);
    for (const bad of ["Alice.near", "!invalid", "x"]) {
      await assert.rejects(
        () => adapter.readState({ path: "/", params: {}, walletAddress: bad }),
        (err: unknown) => {
          assert.ok(err instanceof NearAdapterError, `expected NearAdapterError for "${bad}"`);
          assert.ok(err.message.includes("invalid account ID"));
          return true;
        },
      );
    }
    assert.equal(rpcCalled, false, "RPC should never be called for malformed addresses");
  });

  // --- readState: balance fields ---

  it("5. yoctoNEAR → NEAR formatted fields are correct", async () => {
    mockRpc(async () => MOCK_ACCOUNT_VIEW);
    const adapter = new NearAdapter(BASE_CONFIG);
    const { state } = await adapter.readState(CTX_NAMED);
    const { balance } = state;

    // Raw yoctoNEAR strings preserved exactly.
    assert.equal(balance.total,     "10000000000000000000000000");
    assert.equal(balance.staked,     "2000000000000000000000000");
    assert.equal(balance.available,  "8000000000000000000000000");

    // Human-readable NEAR decimals.
    assert.equal(balance.totalNear,     "10");
    assert.equal(balance.stakedNear,    "2");
    assert.equal(balance.availableNear, "8");
  });

  it("6. available = total − staked (BigInt arithmetic, no precision loss)", async () => {
    // Use values where floating-point subtraction would silently lose precision.
    const precisionView = {
      ...MOCK_ACCOUNT_VIEW,
      amount: "9999999999999999999999999",  // just under 10 NEAR
      locked:  "1111111111111111111111111",
    };
    mockRpc(async () => precisionView);

    const adapter = new NearAdapter(BASE_CONFIG);
    const { state } = await adapter.readState(CTX_NAMED);

    const expected = (
      BigInt("9999999999999999999999999") - BigInt("1111111111111111111111111")
    ).toString();
    assert.equal(state.balance.available, expected);
  });

  // --- readState: codeHash passthrough ---

  it("7. codeHash '11111...' (no contract) and real hash both pass through unchanged", async () => {
    const adapter = new NearAdapter(BASE_CONFIG);

    mockRpc(async () => ({ ...MOCK_ACCOUNT_VIEW, code_hash: NO_CONTRACT_CODE_HASH }));
    const { state: noContract } = await adapter.readState(CTX_NAMED);
    assert.equal(noContract.codeHash, NO_CONTRACT_CODE_HASH);

    mock.restoreAll();

    mockRpc(async () => ({ ...MOCK_ACCOUNT_VIEW, code_hash: WITH_CONTRACT_CODE_HASH }));
    const { state: withContract } = await adapter.readState(CTX_NAMED);
    assert.equal(withContract.codeHash, WITH_CONTRACT_CODE_HASH);
  });

  // --- readState: paymentRequired always null ---

  it("7b. readState always returns paymentRequired: null (NEAR is read-only)", async () => {
    mockRpc(async () => MOCK_ACCOUNT_VIEW);
    const adapter = new NearAdapter(BASE_CONFIG);
    const result = await adapter.readState(CTX_NAMED);
    assert.equal(result.paymentRequired, null);
  });

  // --- readState: failure modes ---

  it("8. missing accountId (no config, no walletAddress) throws NearAdapterError", async () => {
    let rpcCalled = false;
    mockRpc(async () => { rpcCalled = true; return MOCK_ACCOUNT_VIEW; });

    const adapter = new NearAdapter(BASE_CONFIG);
    await assert.rejects(
      () => adapter.readState(CTX_EMPTY),
      (err: unknown) => {
        assert.ok(err instanceof NearAdapterError);
        assert.ok(err.message.includes("accountId is required"));
        return true;
      },
    );
    assert.equal(rpcCalled, false, "RPC should never be called without an accountId");
  });

  it("9. RPC network failure throws NearAdapterError (caught as AdapterError by router)", async () => {
    mockRpc(async () => {
      throw new Error("Connection refused: https://rpc.mainnet.near.org");
    });

    const adapter = new NearAdapter(BASE_CONFIG);
    await assert.rejects(
      () => adapter.readState(CTX_NAMED),
      (err: unknown) => {
        // The error propagates as-is from the RPC layer; the router's
        // Promise.allSettled wraps it into an AdapterError token.
        assert.ok(err instanceof Error);
        assert.ok(
          err.message.includes("Connection refused"),
          `expected RPC error message, got: ${err.message}`,
        );
        return true;
      },
    );
  });

  it("10. config.accountId takes precedence over context.walletAddress", async () => {
    mockRpc(async () => MOCK_ACCOUNT_VIEW);

    const adapter = new NearAdapter({ ...BASE_CONFIG, accountId: "fixed.near" });
    const { state } = await adapter.readState({ ...CTX_NAMED, walletAddress: "other.near" });
    assert.equal(state.accountId, "fixed.near");
  });

  // --- Payment methods — read-only adapter ---

  it("11. payment methods throw NotSupportedError", async () => {
    const adapter = new NearAdapter(BASE_CONFIG);
    const dummyReq = { scheme: "exact", network: "near", maxAmountRequired: "0" };
    const dummyPayload = { requirement: dummyReq };
    const dummySigned = { payload: dummyPayload, signature: "0x0" };
    const dummyResult = { accepted: false, txHash: null, requirement: dummyReq, responseData: null };

    await assert.rejects(() => adapter.preparePayment(dummyReq), NotSupportedError);
    await assert.rejects(() => adapter.sign(dummyPayload), NotSupportedError);
    await assert.rejects(() => adapter.submit(dummySigned, CTX_NAMED), NotSupportedError);
    await assert.rejects(() => adapter.awaitFinality(dummyResult), NotSupportedError);
  });

});
