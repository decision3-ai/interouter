# @decision3/interouter-core

> AI Resource Payment Router. Open-source middleware for AI-native applications.

[![npm version](https://img.shields.io/npm/v/@decision3/interouter-core.svg)](https://www.npmjs.com/package/@decision3/interouter-core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Status:** Pre-alpha. API may change.

---

## What is Interouter?

Interouter sits between Next.js SSR runtimes, blockchain networks, and AI inference systems.

A single deterministic API that:
- Reads multi-chain state in parallel (NEAR + EVM L2)
- Orchestrates `402 Payment Required` (x402 standard) flows
- Handles runtime compatibility across diverging x402 facilitator implementations (CDP, foundation reference, self-hosted)
- Prevents fund loss caused by wire-shape divergences between implementations
- Executes payment retries automatically
- Hides blockchain complexity from frontend applications

**Positioning:** The first facilitator-agnostic middleware for x402. Not a blockchain SDK, not an RPC wrapper.

Built on the [x402 standard](https://github.com/x402-foundation/x402) — under the Linux Foundation, supported by Coinbase, Google, AWS, Stripe, Visa, and Cloudflare.

---

## Install

```bash
npm install @decision3/interouter-core
```

## Quick Start

```typescript
import { InterouterRouter, NearAdapter, OpenLedgerAdapter } from "@decision3/interouter-core";

const router = new InterouterRouter({
  adapters: [
    new NearAdapter({ rpcUrl: "https://rpc.mainnet.near.org" }),
    new OpenLedgerAdapter({
      chainId: 1234,
      privateKey: process.env.OPENLEDGER_PRIVATE_KEY,
      resourceUrl: "https://api.example.com/inference",
    }),
  ],
});

const result = await router.resolve({ walletAddress: "victor.near" });

console.log(result.chainState.near);
console.log(result.chainState.openledger);
```

## Architecture

Every adapter implements a strict 5-stage lifecycle:

```typescript
interface ChainAdapter {
  readState(): Promise<ChainState>
  preparePayment(requirement: PaymentRequirement): Promise<PaymentPayload>
  sign(payload: PaymentPayload): Promise<SignedPayload>
  submit(signed: SignedPayload): Promise<SubmissionResult>
  awaitFinality(result: SubmissionResult): Promise<FinalityStatus>
}
```

Signing is always explicit — never hidden inside read operations.

For full architectural details, security model, and open blockers: see [ARCHITECTURE.md](https://github.com/decision3-ai/interouter/blob/master/ARCHITECTURE.md).

## Roadmap

**Current (v0.1.x):**
- 5-stage ChainAdapter lifecycle (done)
- NearAdapter read-only (done)
- OpenLedgerAdapter x402 `exact` scheme (done)
- Custodial MVP signing model (done)

**Next:**
- Map wire-shape divergences across CDP, foundation, and self-hosted facilitators
- Implement `upto` scheme with cross-facilitator compatibility (reference: x402-foundation/x402#2437)
- Circuit breaker for budget enforcement
- NEAR session keys (delegated, scoped signing)
- Edge runtime support (Cloudflare Workers, Vercel Edge)

## License

MIT © Decision3

## Links

- GitHub: https://github.com/decision3-ai/interouter
- x402 standard: https://github.com/coinbase/x402
- x402 Foundation: https://x402.org
