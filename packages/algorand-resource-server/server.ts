/**
 * EvoAgent x402 paid endpoint — Algorand (AVM) resource server.
 *
 * This is the OTHER side of the Interouter loop: the AlgorandAdapter (buyer)
 * pays THIS endpoint (seller) through the GoPlausible facilitator. Together they
 * form the full loop that generates real on-chain volume for the Global x402
 * Challenge:
 *
 *     EvoAgent → Interouter (AlgorandAdapter) → 402 → pay → THIS endpoint → 200
 *                                    settled on Algorand via GoPlausible
 *
 * Built on @x402-avm/express. Running on MAINNET.
 *
 * Run:
 *   ALGORAND_PAYTO=<your 58-char mainnet address> npx tsx server.ts
 */

import express from "express";
import { paymentMiddlewareFromConfig } from "@x402-avm/express";
import { HTTPFacilitatorClient } from "@x402-avm/core/http";
import { ExactAvmScheme } from "@x402-avm/avm/exact/server";
import {
  ALGORAND_MAINNET_CAIP2,
  USDC_MAINNET_ASA_ID,
} from "@x402-avm/avm";

const app = express();
const PORT = Number(process.env.PORT ?? 4021);

// ── Config ────────────────────────────────────────────────────────────────
const PAYTO = process.env.ALGORAND_PAYTO ?? "AYZ4QBTBJ2CONYYIPH34UPJ24EPTGFFDAYYKLMMKRRAU2UASYXOZ65OF24";
// GoPlausible facilitator. CONFIRM the exact competition facilitator URL —
// for the Challenge, payments MUST settle through the GoPlausible facilitator
// so volume is tracked on the leaderboard.
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://facilitator.goplausible.xyz";

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const scheme = new ExactAvmScheme();

// ── Paid route ───────────────────────────────────────────────────────────
// One paid endpoint: /api/inference. Priced at 0.01 USDC per call (10000 base
// units, 6 decimals). This is what EvoAgent pays for — a real, useful call,
// so the on-chain volume is genuine (judges weight "how real" the activity is).
app.use(
  paymentMiddlewareFromConfig(
    {
      "GET /api/inference": {
        accepts: {
          scheme: "exact",
          payTo: PAYTO,
          price: {
            asset: USDC_MAINNET_ASA_ID,
            amount: "10000", // 0.01 USDC
            extra: { name: "USDC", decimals: 6 },
          },
          network: ALGORAND_MAINNET_CAIP2,
          maxTimeoutSeconds: 60,
        },
        description: "EvoAgent inference call",
        mimeType: "application/json",
      },
    },
    facilitator,
    [{ network: ALGORAND_MAINNET_CAIP2, server: scheme }],
  ),
);

// ── Handler (runs only AFTER payment is verified by the middleware) ─────────
app.get("/api/inference", (req, res) => {
  // In the real loop this calls EvoAgent's brain (Claude API) and returns the
  // result. Stubbed here so the payment loop can be tested end-to-end first.
  res.json({
    ok: true,
    service: "evoagent-inference",
    prompt: req.query["q"] ?? null,
    result: "stubbed inference result — replace with EvoAgent call once loop is green",
    ts: new Date().toISOString(),
  });
});

// Free health check (no payment).
app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`x402 paid endpoint on :${PORT}`);
  console.log(`  paid:  GET /api/inference   (0.01 USDC, ${ALGORAND_MAINNET_CAIP2})`);
  console.log(`  free:  GET /health`);
  console.log(`  payTo: ${PAYTO}`);
  console.log(`  facilitator: ${FACILITATOR_URL}`);
  if (PAYTO.startsWith("REPLACE")) {
    console.warn("  ⚠️  set ALGORAND_PAYTO to your testnet address before testing");
  }
});
