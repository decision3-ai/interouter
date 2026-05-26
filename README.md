# Interouter

> The first facilitator-agnostic middleware for x402.
> Open-source infrastructure for the autonomous AI economy.

[![npm version](https://img.shields.io/npm/v/@decision3/interouter-core.svg)](https://www.npmjs.com/package/@decision3/interouter-core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Tests](https://img.shields.io/badge/tests-33%2F33-brightgreen.svg)]()

**Status:** Pre-alpha. v0.1.3 live on npm.

---

## What is Interouter?

Interouter sits between Next.js SSR runtimes, blockchain networks, and AI inference systems. A single deterministic API that orchestrates `402 Payment Required` (x402 standard) flows while handling runtime compatibility across diverging facilitator implementations (Coinbase CDP, foundation reference, self-hosted).

It is the runtime layer that makes the x402 standard actually work in production.

Built on the [x402 standard](https://github.com/x402-foundation/x402) — under the Linux Foundation, supported by Coinbase, Google, AWS, Stripe, Visa, and Cloudflare.

---

## Packages

This is a TypeScript monorepo.

| Package | Description | npm |
|---------|-------------|-----|
| [`@decision3/interouter-core`](./packages/interouter-core) | Core middleware: ChainAdapter lifecycle, router, NEAR + OpenLedger adapters | [![npm](https://img.shields.io/npm/v/@decision3/interouter-core.svg)](https://www.npmjs.com/package/@decision3/interouter-core) |

---

## Install

```bash
npm install @decision3/interouter-core
```

For full quick start, see the [package README](./packages/interouter-core/README.md).

---

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — Lifecycle spec, trust model, open blockers
- [CLAUDE.md](./CLAUDE.md) — Project engine: philosophy, protocols, current status
- [STRATEGIC_FAQ.md](./STRATEGIC_FAQ.md) — Positioning and defensibility

---

## Status

- [x] ChainAdapter 5-stage lifecycle
- [x] OpenLedgerAdapter (x402 exact scheme)
- [x] NearAdapter (read-only)
- [x] 33/33 tests passing
- [x] v0.1.3 published to npm
- [ ] Cross-facilitator compatibility (v0.2.0)
- [ ] Circuit breaker for budget enforcement (v0.3.0)
- [ ] NEAR session keys (v0.4.0)

---

## Contributing

We welcome contributions. Please open an issue or pull request.

---

## License

MIT © Decision3

Maintained by [@victordeflos](https://github.com/victordeflos).
