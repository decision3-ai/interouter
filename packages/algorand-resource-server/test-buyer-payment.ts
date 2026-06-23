/**
 * End-to-end buyer payment test.
 * Runs the full AlgorandAdapter lifecycle against the local seller (port 4021).
 *
 * Run: npx tsx test-buyer-payment.ts
 * (seller must be running: ALGORAND_PAYTO=... npx tsx packages/algorand-resource-server/server.ts)
 */

import { AlgorandAdapter } from "@decision3/interouter-core";
import { ALGORAND_MAINNET_CAIP2 } from "@x402-avm/avm";

const MNEMONIC =
  "tower genuine second logic attend dizzy else future canoe ski cattle push trick risk salon angry disease eye friend again choose chunk frown ability hub";

const adapter = new AlgorandAdapter({
  mnemonic: MNEMONIC,
  resourceEndpoint: "http://localhost:4021/api/inference",
  algodUrl: "https://mainnet-api.algonode.cloud",
  network: ALGORAND_MAINNET_CAIP2,
});

const context = { path: "/api/inference", params: {} };

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
  console.log("    PAYMENT-SIGNATURE (first 80 chars):", signed.signature.slice(0, 80) + "...");

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
  console.log("    final state:", JSON.stringify(finality.state, null, 4));

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
