# @decision3/interouter-core

Interouter is a Node.js middleware layer that sits between a Next.js SSR frontend and blockchain networks (NEAR, Sui, Walrus). It aggregates on-chain state, enriches it with optional AI inference results, and delivers a single optimized JSON payload to the frontend — in milliseconds.

---

## Vision

Modern dApps have a latency problem. The frontend has to juggle multiple async calls: one to NEAR for account state, one to Sui for object data, one to Walrus for blob metadata, and one to an AI model for personalized recommendations. Each call has its own error surface, retry logic, and caching concern.

Interouter collapses this complexity into a single `router.resolve(context)` call. The router fans out to all registered chain adapters in parallel, optionally passes the aggregated result to an AI provider, and returns one `RouteResult` object that the Next.js page component can consume directly from `getServerSideProps` or a Route Handler.

---

## Architecture

```
Next.js SSR / Route Handler
        |
        v
 InterouterRouter.resolve(context)
        |
   ┌────┴─────────────────────┐
   |  parallel fetchState()   |
   |  ┌────────┐ ┌────────┐   |
   |  │  NEAR  │ │  Sui   │   |
   |  │adapter │ │adapter │   |
   |  └────────┘ └────────┘   |
   |      ┌──────────┐        |
   |      │  Walrus  │        |
   |      │ adapter  │        |
   |      └──────────┘        |
   └──────────────────────────┘
        |
        v
   InferenceProvider (optional)
        |
        v
     RouteResult → JSON → Frontend
```

---

## Quick Start

```ts
import { InterouterRouter } from "@decision3/interouter-core";

const router = new InterouterRouter({
  adapters: [
    nearAdapter,  // @decision3/interouter-near (coming soon)
    suiAdapter,   // @decision3/interouter-sui  (coming soon)
  ],
  aiProvider: myInferenceProvider, // optional
  adapterTimeoutMs: 3000,
});

// Inside getServerSideProps or a Next.js Route Handler:
const result = await router.resolve({
  path: "/dashboard",
  walletAddress: "alice.near",
  params: {},
});

// result.chainState   — merged on-chain data keyed by adapter id
// result.inference    — AI output (or null)
// result.resolvedInMs — total latency
```

---

## Packages

| Package | Status | Description |
|---|---|---|
| `@decision3/interouter-core` | Active | Core router, interfaces, types |
| `@decision3/interouter-near` | Planned | NEAR Protocol chain adapter |
| `@decision3/interouter-sui`  | Planned | Sui chain adapter |
| `@decision3/interouter-walrus` | Planned | Walrus blob storage adapter |

---

## License

MIT — Decision3
