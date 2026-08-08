/**
 * End-to-end buyer payment test for POST /api/audit.
 * Mirrors test-buyer-payment.ts but hits /api/audit with audit input.
 * Ephemeral — delete after use.
 *
 * Run on VPS: npx tsx --env-file=.env _test_audit_payment.ts
 * (server must be running on :4021)
 */

import { AlgorandAdapter } from "@decision3/interouter-core";
import { ALGORAND_MAINNET_CAIP2 } from "@x402-avm/avm";

const MNEMONIC = process.env.TEST_BUYER_MNEMONIC;
if (!MNEMONIC) {
  console.error(
    "❌ TEST_BUYER_MNEMONIC is not set — add it to .env before running this test",
  );
  process.exit(1);
}

const adapter = new AlgorandAdapter({
  mnemonic: MNEMONIC,
  resourceEndpoint: "http://localhost:4021/api/audit",
  algodUrl: "https://mainnet-api.algonode.cloud",
  network: ALGORAND_MAINNET_CAIP2,
  requestMethod: "POST",
  requestBody: {
    task: "Implementing a new blockchain payment adapter from scratch — writing code, running tests, debugging failures",
    current_tools: [
      { name: "Bash", description: "Run shell commands" },
      { name: "Read", description: "Read files from disk" },
      { name: "Edit", description: "Edit source files" },
      { name: "Grep", description: "Search file contents" },
    ],
  },
});

const context = { path: "/api/audit", params: {} };

async function main() {
  // ── Stage 1: readState ──────────────────────────────────────────────────
  console.log("\n[1] readState...");
  const { state, paymentRequired } = await adapter.readState(context);
  console.log("    flow:", state.flow);
  console.log("    paymentRequired:", paymentRequired !== null ? "YES" : "NO (open endpoint)");

  if (!paymentRequired) {
    console.log("\n✅ Endpoint open — no payment needed. State:", state);
    return;
  }

  console.log("    requirement:", JSON.stringify(paymentRequired, null, 4));

  // ── Stage 2: preparePayment ─────────────────────────────────────────────
  console.log("\n[2] preparePayment...");
  const payload = await adapter.preparePayment(paymentRequired);
  console.log("    sdkRequirement:", JSON.stringify((payload as any).sdkRequirement, null, 4));

  // ── Stage 3: sign ───────────────────────────────────────────────────────
  console.log("\n[3] sign...");
  const signed = await adapter.sign(payload);
  console.log("    PAYMENT-SIGNATURE header length:", signed.signature.length);

  // ── Stage 4: submit ─────────────────────────────────────────────────────
  console.log("\n[4] submit...");
  const submission = await adapter.submit(signed, context);
  console.log("    accepted:", submission.accepted);
  console.log("    txHash:", submission.txHash);
  console.log("    responseData:", JSON.stringify(submission.responseData, null, 4));

  // ── Stage 5: awaitFinality ──────────────────────────────────────────────
  console.log("\n[5] awaitFinality...");
  const finality = await adapter.awaitFinality(submission);
  console.log("    finalized:", finality.finalized);
  console.log("    txHash:", finality.txHash);

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════");
  console.log("  accepted:  ", submission.accepted);
  console.log("  txHash:    ", submission.txHash ?? "(none)");
  console.log("  finalized: ", finality.finalized);
  console.log("══════════════════════════════════════\n");
}

main().catch((err: unknown) => {
  console.error("\n❌ ERROR:", (err instanceof Error) ? err.message : err);
  if (err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
