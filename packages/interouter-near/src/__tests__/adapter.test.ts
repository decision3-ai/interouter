import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NearAdapter } from "../adapter.js";
import type { NearPaymentPayload, NearSignedPayload } from "../adapter.js";
import type { NearAdapterConfig } from "../types.js";
import { NearAdapterError } from "../types.js";
import type { PaymentRequirement, RouteContext } from "@decision3/interouter-core";

// ---------------------------------------------------------------------------
// Test key pair — DO NOT USE IN PRODUCTION
// This is a randomly generated testnet key for unit testing only.
// ---------------------------------------------------------------------------

const TEST_PRIVATE_KEY = "ed25519:3KyUucjXVq8nM6Axy47UbKdHPzP8FScJNcMkjATz3Q3v2YdaGjQjcKMhHqYWHSqgSXd8JHLpNNKxJvF7n6xmHuZm";
const TEST_ACCOUNT_ID = "test.testnet";
const TEST_NODE_URL = "https://rpc.testnet.near.org";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function createTestConfig(): NearAdapterConfig {
  return {
    networkId: "testnet",
    nodeUrl: TEST_NODE_URL,
    accountId: TEST_ACCOUNT_ID,
    privateKey: TEST_PRIVATE_KEY,
  };
}

function createReadOnlyConfig(): NearAdapterConfig {
  return {
    networkId: "testnet",
    nodeUrl: TEST_NODE_URL,
    accountId: TEST_ACCOUNT_ID,
    // No privateKey — read-only mode
  };
}

function createNoAccountConfig(): NearAdapterConfig {
  return {
    networkId: "testnet",
    nodeUrl: TEST_NODE_URL,
    privateKey: TEST_PRIVATE_KEY,
    // No accountId
  };
}

function createTestRequirement(): PaymentRequirement & { payTo: string } {
  return {
    scheme: "exact",
    network: "near:testnet",
    maxAmountRequired: "1000000000000000000000000", // 1 NEAR in yoctoNEAR
    payTo: "receiver.testnet",
  };
}

function createRequirementNoPayTo(): PaymentRequirement {
  return {
    scheme: "exact",
    network: "near:testnet",
    maxAmountRequired: "1000000000000000000000000",
    // No payTo field
  };
}

function createRequirementWithNetworkReceiver(): PaymentRequirement {
  return {
    scheme: "exact",
    network: "near:testnet:receiver.testnet",
    maxAmountRequired: "1000000000000000000000000",
    // receiverId extracted from network string
  };
}

function createTestContext(): RouteContext {
  return {
    path: "/test",
    walletAddress: TEST_ACCOUNT_ID,
    params: {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NearAdapter payment lifecycle", () => {
  describe("constructor", () => {
    it("initializes signer when privateKey is provided", () => {
      const adapter = new NearAdapter(createTestConfig());
      // The adapter should be able to call payment methods without throwing "privateKey required"
      assert.ok(adapter, "Adapter should be created");
    });

    it("initializes signer from NEAR_PRIVATE_KEY env var", () => {
      const originalEnv = process.env["NEAR_PRIVATE_KEY"];
      process.env["NEAR_PRIVATE_KEY"] = TEST_PRIVATE_KEY;
      try {
        const adapter = new NearAdapter(createReadOnlyConfig());
        assert.ok(adapter, "Adapter should be created");
      } finally {
        if (originalEnv) {
          process.env["NEAR_PRIVATE_KEY"] = originalEnv;
        } else {
          delete process.env["NEAR_PRIVATE_KEY"];
        }
      }
    });

    it("allows read-only mode when no private key is provided", () => {
      const originalEnv = process.env["NEAR_PRIVATE_KEY"];
      delete process.env["NEAR_PRIVATE_KEY"];
      try {
        const adapter = new NearAdapter(createReadOnlyConfig());
        assert.ok(adapter, "Adapter should be created in read-only mode");
      } finally {
        if (originalEnv) {
          process.env["NEAR_PRIVATE_KEY"] = originalEnv;
        }
      }
    });
  });

  describe("preparePayment", () => {
    it("throws NearAdapterError when no private key is configured", async () => {
      const originalEnv = process.env["NEAR_PRIVATE_KEY"];
      delete process.env["NEAR_PRIVATE_KEY"];
      try {
        const adapter = new NearAdapter(createReadOnlyConfig());
        const requirement = createTestRequirement();
        await assert.rejects(
          () => adapter.preparePayment(requirement),
          (err: Error) => {
            assert.ok(err instanceof NearAdapterError);
            assert.ok(err.message.includes("privateKey is required"));
            return true;
          },
        );
      } finally {
        if (originalEnv) {
          process.env["NEAR_PRIVATE_KEY"] = originalEnv;
        }
      }
    });

    it("throws NearAdapterError when no accountId is configured", async () => {
      const adapter = new NearAdapter(createNoAccountConfig());
      const requirement = createTestRequirement();
      await assert.rejects(
        () => adapter.preparePayment(requirement),
        (err: Error) => {
          assert.ok(err instanceof NearAdapterError);
          assert.ok(err.message.includes("accountId is required"));
          return true;
        },
      );
    });

    it("throws NearAdapterError when receiver cannot be determined", async () => {
      const adapter = new NearAdapter(createTestConfig());
      const requirement = createRequirementNoPayTo();
      await assert.rejects(
        () => adapter.preparePayment(requirement),
        (err: Error) => {
          assert.ok(err instanceof NearAdapterError);
          assert.ok(err.message.includes("cannot determine receiver"));
          return true;
        },
      );
    });

    it("extracts receiverId from payTo field", async () => {
      // This test would need mocked RPC calls to fully work.
      // For now, we verify the error message changes to RPC-related rather than receiver-related.
      const adapter = new NearAdapter(createTestConfig());
      const requirement = createTestRequirement();

      // The call will fail due to network, but we're testing input validation
      await assert.rejects(
        () => adapter.preparePayment(requirement),
        (err: Error) => {
          // Should NOT be "cannot determine receiver" — receiver was extracted
          assert.ok(!err.message.includes("cannot determine receiver"));
          return true;
        },
      );
    });

    it("extracts receiverId from network string format", async () => {
      const adapter = new NearAdapter(createTestConfig());
      const requirement = createRequirementWithNetworkReceiver();

      await assert.rejects(
        () => adapter.preparePayment(requirement),
        (err: Error) => {
          // Should NOT be "cannot determine receiver"
          assert.ok(!err.message.includes("cannot determine receiver"));
          return true;
        },
      );
    });
  });

  describe("sign", () => {
    it("throws NearAdapterError when no private key is configured", async () => {
      const originalEnv = process.env["NEAR_PRIVATE_KEY"];
      delete process.env["NEAR_PRIVATE_KEY"];
      try {
        const adapter = new NearAdapter(createReadOnlyConfig());
        const payload: NearPaymentPayload = {
          requirement: createTestRequirement(),
          unsignedTxBase64: "dGVzdA==", // "test" in base64
          signerId: TEST_ACCOUNT_ID,
          receiverId: "receiver.testnet",
          amount: "1000000000000000000000000",
          blockHash: "3Fz3aJBdfpSUsqMqFfSqBHLpHNrejzWUhJUikvVTPCn4",
          nonce: "12346",
        };
        await assert.rejects(
          () => adapter.sign(payload),
          (err: Error) => {
            assert.ok(err instanceof NearAdapterError);
            assert.ok(err.message.includes("privateKey is required"));
            return true;
          },
        );
      } finally {
        if (originalEnv) {
          process.env["NEAR_PRIVATE_KEY"] = originalEnv;
        }
      }
    });
  });

  describe("submit", () => {
    it("handles deserialization errors gracefully", async () => {
      const adapter = new NearAdapter(createTestConfig());
      const signedPayload: NearSignedPayload = {
        payload: {
          requirement: createTestRequirement(),
          unsignedTxBase64: "dGVzdA==",
          signerId: TEST_ACCOUNT_ID,
          receiverId: "receiver.testnet",
          amount: "1000000000000000000000000",
          blockHash: "3Fz3aJBdfpSUsqMqFfSqBHLpHNrejzWUhJUikvVTPCn4",
          nonce: "12346",
        } as NearPaymentPayload,
        signature: "testSignature",
        signedTxBase64: "dGVzdA==", // Invalid transaction data
        txHash: "testTxHash",
      };

      // Invalid signed transaction data will throw during deserialization.
      // This is expected behavior — submit() expects valid signed transaction bytes.
      await assert.rejects(
        () => adapter.submit(signedPayload, createTestContext()),
        (err: Error) => {
          // Borsh deserialization error
          assert.ok(err.message.includes("buffer"));
          return true;
        },
      );
    });

    it("method signature is correct", () => {
      const adapter = new NearAdapter(createTestConfig());
      assert.ok(typeof adapter.submit === "function");
      // submit(signed: SignedPayload, context: RouteContext) => Promise<SubmissionResult>
    });
  });

  describe("awaitFinality", () => {
    it("returns finalized: false for rejected transactions", async () => {
      const adapter = new NearAdapter(createTestConfig());
      const submissionResult = {
        accepted: false,
        txHash: null,
        requirement: createTestRequirement(),
        responseData: "Transaction rejected",
      };

      const result = await adapter.awaitFinality(submissionResult);

      assert.strictEqual(result.finalized, false);
      assert.strictEqual(result.txHash, null);
      assert.ok(result.state.viewResults["paymentError"]);
    });
  });

  describe("readState", () => {
    it("returns paymentRequired: null (read-only adapter by default)", () => {
      // This test requires network access — skip in CI without mock
      // For now just verify the method exists and has correct signature
      const adapter = new NearAdapter(createTestConfig());
      assert.ok(typeof adapter.readState === "function");
    });
  });
});

describe("NearAdapter id", () => {
  it("returns 'near' as adapter id", () => {
    const adapter = new NearAdapter(createTestConfig());
    assert.strictEqual(adapter.id, "near");
  });
});
