# Interouter Architecture & Lifecycle Specification

**Document Status:** Internal Alpha / Active Refactor Validation
**Target Audience:** Decision3 Core Engineers & Integration Partners

---

## 1. ChainAdapter Lifecycle (5-Stage)

Monolithic execution is fully eliminated in favour of a strict state machine. Every network adapter must implement the `ChainAdapter` interface through five explicit stages:

```typescript
interface ChainAdapter {
  readState(): Promise<ChainState>
  preparePayment(requirement: PaymentRequirement): Promise<PaymentPayload>
  sign(payload: PaymentPayload): Promise<SignedPayload>
  submit(signed: SignedPayload): Promise<SubmissionResult>
  awaitFinality(result: SubmissionResult): Promise<FinalityStatus>
}
```

### Execution sequence in `router.ts`

- **readState()** — Router runs this in parallel for all registered adapters via `Promise.allSettled`. NearAdapter returns balances and account state. OpenLedgerAdapter sends the initial HTTP request. On 200 OK: `paymentRequired: null`, pipeline exits early. On 402: returns structured `X402PaymentRequirement`.
- **preparePayment()** — Called only if `paymentRequired` is present. Constructs unsigned `X402WirePayload`.
- **sign()** — Performs EIP-712 cryptographic signing. All errors here are explicit and immediately halt execution by throwing `AdapterError`.
- **submit()** — Encodes signed payload into `X-PAYMENT` header and retries the original HTTP request.
- **awaitFinality()** — Awaits execution confirmation and constructs final reactive state for the frontend.

---

## 2. Security & Trust Model

### @custodial-mvp (Current phase)
Private key is loaded from `process.env.OPENLEDGER_PRIVATE_KEY` and passed to a `viem` instance via `privateKeyToAccount`.

**Risk vector:** Server environment compromise equals full wallet compromise. Funds on this wallet must be strictly limited to minimal test amounts.

### @v2-migration (Planned)
Migrate to user-delegated session keys using NEAR native FunctionCall access keys.

Scoped constraints per session key:
- Max budget (e.g. 5 USD equivalent)
- Expiry window (e.g. 1 hour)
- Restricted to Decision3 AI inference contracts only

Result: Full backend compromise limits damage to the active session budget only.

---

## 3. Open Questions & Blockers (DGrid / OpenLedger)

These are implemented on assumptions and must be confirmed with DGrid before any production testing:

| # | Issue | Current assumption | Needs confirmation |
|---|-------|-------------------|-------------------|
| 1 | BigInt serialisation in `X-PAYMENT` | `amount`, `validAfter`, `validBefore` sent as decimal strings via base64 encoding | Does DGrid verifier accept decimal strings or require hex `0x...`? |
| 2 | `verifyingContract` in EIP-712 domain | Set to `requirement.asset` (ERC-20 token address) | Is verification done by the token contract or a separate payment gateway? |
| 3 | Inference ID generation | `keccak256` hash of resource URL (deterministic) | Does DGrid expect a random per-request Task UUID from the 402 response metadata? |

---

## 4. Concurrency & Nonce Management

Every adapter performing on-chain writes must manage its own transaction state to prevent nonce desync.

`Promise.allSettled` ensures slow RPC on one chain does not block execution on another — keeping UX stable regardless of individual chain congestion.
