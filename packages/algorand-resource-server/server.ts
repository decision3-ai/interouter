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

app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────
const PAYTO = process.env.ALGORAND_PAYTO ?? "AYZ4QBTBJ2CONYYIPH34UPJ24EPTGFFDAYYKLMMKRRAU2UASYXOZ65OF24";
// GoPlausible facilitator. CONFIRM the exact competition facilitator URL —
// for the Challenge, payments MUST settle through the GoPlausible facilitator
// so volume is tracked on the leaderboard.
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://facilitator.goplausible.xyz";

const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const scheme = new ExactAvmScheme();

// ── Paid route ───────────────────────────────────────────────────────────
// One paid endpoint: POST /api/review. Priced at 0.01 USDC per call.
app.use(
  paymentMiddlewareFromConfig(
    {
      "POST /api/review": {
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
        description: "D3RCP code review",
        mimeType: "application/json",
      },
    },
    facilitator,
    [{ network: ALGORAND_MAINNET_CAIP2, server: scheme }],
  ),
);

// ── Handler (runs only AFTER payment is verified by the middleware) ─────────
const SYSTEM_PROMPT = `You are a senior code reviewer. The user is paying per request for a structured, actionable review — not a casual chat response. Analyze the submitted code and respond in this exact structure:

## Bugs & Correctness
[List concrete bugs, logic errors, or edge cases the code doesn't handle. If none found, say so explicitly.]

## Security
[Flag injection risks, unsafe input handling, exposed secrets, auth issues. If none found, say so explicitly.]

## Performance
[Note inefficiencies — unnecessary loops, N+1 queries, blocking calls that should be async, etc. If none found, say so explicitly.]

## Suggestions
[2-3 concrete, prioritized improvements — not generic advice.]

Be direct and specific. Reference exact line numbers or function names where possible. Do not pad the response with generic praise or disclaimers.`;

app.post("/api/review", async (req, res) => {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    res.status(500).json({
      ok: false,
      error: "DEEPSEEK_API_KEY is not set — configure it before using this endpoint",
    });
    return;
  }

  const { code } = req.body as { code: string };

  const dsRes = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: code },
      ],
    }),
  });

  if (!dsRes.ok) {
    const detail = await dsRes.text();
    res.status(502).json({ ok: false, error: `DeepSeek API error ${dsRes.status}`, detail });
    return;
  }

  const data = await dsRes.json() as { choices: Array<{ message: { content: string } }> };
  const review = data.choices[0]?.message.content ?? "";

  res.json({
    ok: true,
    service: "d3rcp-code-review",
    review,
    ts: new Date().toISOString(),
  });
});

// Free health check (no payment).
app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`x402 paid endpoint on :${PORT}`);
  console.log(`  paid:  POST /api/review   (0.01 USDC, ${ALGORAND_MAINNET_CAIP2})`);
  console.log(`  free:  GET /health`);
  console.log(`  payTo: ${PAYTO}`);
  console.log(`  facilitator: ${FACILITATOR_URL}`);
  if (PAYTO.startsWith("REPLACE")) {
    console.warn("  ⚠️  set ALGORAND_PAYTO to your testnet address before testing");
  }
});
