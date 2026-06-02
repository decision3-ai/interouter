# Interouter Architecture & Lifecycle Specification

**Document Status:** Internal Alpha / Active Refactor Validation
**Target Audience:** Decision3 Core Engineers & Integration Partners

**Strategic Positioning:** Facilitator-agnostic middleware for x402 — handling runtime compatibility across diverging implementations (CDP, foundation reference, self-hosted) and preventing fund loss caused by wire-shape divergences. See STRATEGIC_FAQ.md for the full defensibility reasoning.

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

These open blockers exist within a broader context: the x402 ecosystem is fragmenting across multiple facilitator implementations. The Linux Foundation reference implementation, Coinbase's CDP-hosted facilitator, and various self-hosted facilitators (dexter.cash, Faremeter) handle the same wire shapes differently. Issue x402-foundation/x402#2437 documents one concrete divergence: CDP rejects `setSettlementOverrides` payloads that the foundation reference accepts cleanly. Interouter's role is to abstract these divergences so sellers do not lose money on facilitator-specific edge cases.

These are implemented on assumptions and must be confirmed with DGrid before any production testing:

| # | Issue | Current assumption | Status |
|---|-------|-------------------|--------|
| 1 | BigInt serialisation in `PAYMENT-SIGNATURE` header | `amount`, `nonce`, `deadline` sent as decimal strings via base64 encoding | **Spec reviewed — decimal strings confirmed correct. Pending vendor confirmation.** |
| 2 | `verifyingContract` + EIP-712 type in Permit2 domain | `verifyingContract = PERMIT2_ADDRESS`, type = `PermitTransferFrom`, spender = `payTo` | **Spec reviewed — foundation uses proxy contract + witness pattern. Pending vendor confirmation.** |
| 3 | Inference ID generation | `keccak256` hash of resource URL (deterministic) | Pending DGrid confirmation |

---

### Blocker #1 — BigInt serialisation (spec reviewed 2026-06-02)

**Source:** `typescript/packages/mechanisms/evm/src/utils.ts` and `shared/permit2.ts` in x402-foundation/x402.

The reference implementation serialises **all numeric fields as decimal strings** — no `0x` hex prefix anywhere in the wire payload:

```typescript
// utils.ts — nonce generation
export function createPermit2Nonce(): string {
  const randomBytes = getCrypto().getRandomValues(new Uint8Array(32));
  return BigInt(toHex(randomBytes)).toString(); // → "115792089..." decimal string
}

// shared/permit2.ts — payload construction
const deadline = (now + paymentRequirements.maxTimeoutSeconds).toString(); // decimal
const validAfter = (now - 600).toString();                                  // decimal
// amount: paymentRequirements.amount — already a decimal string from the 402 body
```

The facilitator-side (`buildExactPermit2SettleArgs`) re-parses these strings back to BigInt:
```typescript
amount: BigInt(permit2Payload.permit2Authorization.permitted.amount),
nonce:  BigInt(permit2Payload.permit2Authorization.nonce),
deadline: BigInt(permit2Payload.permit2Authorization.deadline),
```

**Conclusion:** Our current `JSON.stringify(payment, (_, v) => (typeof v === "bigint" ? v.toString() : v))` replacer produces the correct format. No change needed for this aspect.

**Still needs vendor confirmation from DGrid/OpenGradient:** that their facilitator verifier also accepts decimal strings (not hex). The spec is clear; vendor deviation is possible.

---

### Blocker #2 — EIP-712 domain + wire shape (spec reviewed 2026-06-02)

**Source:** `typescript/packages/mechanisms/evm/src/shared/permit2.ts` and `exact/client/permit2.ts` in x402-foundation/x402.

The foundation reference uses a **witness pattern** that differs structurally from our current `OpenGradientAdapter` and `OpenLedgerAdapter` implementations. Key differences:

| Field | Our implementation | x402 foundation reference |
|---|---|---|
| Wire key | `permit` | `permit2Authorization` |
| EIP-712 primary type | `PermitTransferFrom` | `PermitWitnessTransferFrom` |
| `verifyingContract` | `PERMIT2_ADDRESS` ✓ | `PERMIT2_ADDRESS` ✓ |
| `spender` in EIP-712 | `requirement.payTo` | `x402ExactPermit2ProxyAddress` (a proxy contract) |
| `payTo` location | `permit.spender` | `permit2Authorization.witness.to` |
| `validAfter` | not present | `permit2Authorization.witness.validAfter` (clock skew −600s) |
| `from` (payer address) | not present | `permit2Authorization.from` |

**Foundation wire payload structure:**
```typescript
{
  x402Version: number,
  payload: {
    signature: "0x...",
    permit2Authorization: {
      from: "0x...",           // payer address
      permitted: {
        token: "0x...",        // ERC-20 token
        amount: "1000000",     // decimal string
      },
      spender: "0x...",        // x402Permit2Proxy contract, NOT payTo
      nonce: "115792089...",   // decimal string (random uint256)
      deadline: "1748123456",  // decimal string (unix timestamp)
      witness: {
        to: "0x...",           // payTo recipient
        validAfter: "1748119256", // decimal string (now - 600s)
      },
    },
  },
}
```

**`verifyingContract` is correct in both:** both use the Permit2 singleton `0x000000000022D473030F116dDEE9F6B43aC78BA3`. Our assumption that it was `requirement.asset` (the token address) was **wrong** — it was already fixed to `PERMIT2_ADDRESS` in `OpenGradientAdapter`.

**Critical open question:** OpenGradient's facilitator may or may not use the foundation's proxy+witness pattern. If it uses a simpler direct `PermitTransferFrom` (spender = payTo, no witness), our current implementation is correct. If it uses the foundation's `PermitWitnessTransferFrom` pattern, the wire shape, EIP-712 types, and signing domain are all wrong.

**No code change until OpenGradient confirms which pattern their facilitator verifier expects.**

---

## 4. Concurrency & Nonce Management

Every adapter performing on-chain writes must manage its own transaction state to prevent nonce desync.

`Promise.allSettled` ensures slow RPC on one chain does not block execution on another — keeping UX stable regardless of individual chain congestion.
