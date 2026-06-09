#!/usr/bin/env tsx
/**
 * Live integration probe — OpenGradientAdapter readState()
 *
 * Sends a real HTTP request to the OpenGradient inference endpoint.
 * Stops after readState() — no signing, no payment, no chain write.
 *
 * Required env:
 *   OG_PRIVATE_KEY  hex private key (with or without 0x prefix)
 *
 * Usage:
 *   OG_PRIVATE_KEY=0x... npx tsx scripts/test-opengradient-live.ts
 */

import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { OpenGradientAdapter } from "../src/adapters/OpenGradientAdapter.js";
import type { OpenGradientPaymentRequirement } from "../src/adapters/OpenGradientAdapter.js";

const rawKey = process.env["OG_PRIVATE_KEY"];
if (!rawKey) {
  console.error("ERROR: OG_PRIVATE_KEY env var is required");
  process.exit(1);
}

const privateKey = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex;
const account = privateKeyToAccount(privateKey);

console.log("=== OpenGradient live probe ===");
console.log(`Signer:   ${account.address}`);
console.log(`Endpoint: https://llm.opengradient.ai/v1/chat/completions`);
console.log(`Network:  Base Sepolia (chainId: 84532)\n`);

const adapter = new OpenGradientAdapter({
  inferenceEndpoint: "https://llm.opengradient.ai/v1/chat/completions",
  chainId: 84532,
  rpcUrl: "https://sepolia.base.org",
  signerAddress: account.address,
  privateKey,
});

console.log("Calling readState()...");

const { state, paymentRequired } = await adapter.readState({
  path: "/v1/chat/completions",
  params: {},
});

if (paymentRequired === null) {
  console.log("\nResponse: 200 (free tier — no payment required)");
  console.log("Inference result:", JSON.stringify(state.inferenceResult, null, 2));
} else {
  const req = paymentRequired as OpenGradientPaymentRequirement;
  console.log("\nResponse: 402 Payment Required");
  console.log(`  scheme:            ${req.scheme}`);
  console.log(`  network:           ${req.network}`);
  console.log(`  maxAmountRequired: ${req.maxAmountRequired}`);
  console.log(`  asset ($OPG):      ${req.asset}`);
  console.log(`  payTo:             ${req.payTo}`);
  console.log(`  maxTimeoutSeconds: ${req.maxTimeoutSeconds}`);
  console.log(`  resource:          ${req.resource}`);
  if (req.extra) {
    console.log(`  extra:             ${JSON.stringify(req.extra)}`);
  }
  console.log("\nFull paymentRequired:\n" + JSON.stringify(req, null, 2));
}
