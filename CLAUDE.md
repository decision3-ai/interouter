# CLAUDE.md — Interouter Project Engine

> This is the project's source of truth.
> Every Claude CLI session reads this first.
> Every architectural decision answers to it.

---

## 1. What Interouter Is

Open-source middleware for AI-native applications.
Sits between Next.js SSR runtimes, blockchain networks, and AI inference/payment systems.

**Single deterministic developer-facing API that:**
- reads multi-chain state in parallel
- orchestrates `402 Payment Required` (x402 standard) flows
- executes payment retries automatically
- hides blockchain complexity from frontend applications

**Positioning:** AI Resource Payment Router. Not a blockchain SDK, not an RPC wrapper.
**Long-term vision:** "Stripe for AI agent payments" / "Axios for paid AI inference over blockchain."

**Repo:** https://github.com/decision3-ai/interouter
**npm scope:** `@decision3/interouter-core`

---

## 2. Architectural Philosophy

These four principles are NOT optional. Every architectural decision must satisfy them.

### Principle 1 — Hide Complexity Elegantly

Developers using Interouter must NEVER directly deal with:
- chain-specific RPC behavior
- nonce management
- payment retries
- EIP-712 internals
- transaction orchestration
- finality polling

Good:
    await interouter.query(...)

Bad:
    await preparePayment()
    await signPayload()
    await retryRequest()
    await pollFinality()

Complexity belongs INSIDE the infrastructure, not on the developer's screen.

### Principle 2 — Security Model Must Be Explicit

Every signing operation must clearly define:
- who owns the key
- where signing occurs
- what payload is signed
- replay protection assumptions
- nonce assumptions
- transaction boundaries

Never introduce: implicit custody, hidden signing, silent transaction execution, unclear trust boundaries.
**Security clarity is more important than convenience.**

### Principle 3 — Developer Experience Must Be Exceptional

A developer must be able to use Interouter from:
- type signatures
- method names
- JSDoc
- README examples

If reading internal source is required to use the library correctly, **the abstraction has failed.**

### Principle 4 — Preserve Architectural Simplicity

Prefer: explicit code, small interfaces, deterministic control flow, composition over inheritance.

Avoid: abstract factories, service locators, DI frameworks, event buses, unnecessary generics, deep inheritance trees, plugin systems.

**This is infrastructure software. Clarity beats cleverness.**

---

## 3. Stack & Structure

TypeScript monorepo. Minimal dependencies. ESM only.

    interouter/
    ├── packages/
    │   ├── interouter-core/
    │   │   ├── src/
    │   │   │   ├── router.ts
    │   │   │   ├── adapters/
    │   │   │   │   ├── NearAdapter.ts
    │   │   │   │   ├── OpenLedgerAdapter.ts
    │   │   │   │   └── *.test.ts
    │   │   │   ├── router.test.ts
    │   │   │   └── index.ts
    │   │   ├── dist/
    │   │   └── package.json
    │   └── interouter-near/
    ├── ARCHITECTURE.md
    └── CLAUDE.md

**Core stack:**
- Runtime: Node.js / Next.js SSR (target: Edge Runtime, Cloudflare Workers)
- Language: TypeScript strict mode
- Chains: `near-api-js` (NEAR), `viem` (OpenLedger / EVM)
- Testing: Anvil test keys for live EIP-712 signing, mocked HTTP for 402 flows

---

## 4. Dev Commands

    cd packages/interouter-core && npm test
    npm test OpenLedgerAdapter.test.ts
    npm run build
    npm run clean
    npm run typecheck

**Every commit must pass full test suite.** Current baseline: **33/33**.

---

## 5. ChainAdapter Lifecycle Contract

Every blockchain integration MUST implement this interface. Monolithic methods are forbidden.

    interface ChainAdapter {
      readState(): Promise<ChainState>
      preparePayment(requirement: PaymentRequirement): Promise<PaymentPayload>
      sign(payload: PaymentPayload): Promise<SignedPayload>
      submit(signed: SignedPayload): Promise<SubmissionResult>
      awaitFinality(result: SubmissionResult): Promise<FinalityStatus>
    }

### Per-Method Rules (strict)

**readState()**
- MUST: RPC reads only, chain state retrieval, read-only ops
- MUST NOT: mutate chain state, sign transactions, submit transactions

**preparePayment()**
- MUST: construct payment payloads, prepare typed data, validate requirements
- MUST NOT: sign payloads, submit transactions

**sign()**
- MUST: cryptographic signing only, signature generation
- MUST NOT: submit transactions, mutate retry state
- All signing assumptions MUST be documented in code

**submit()**
- MUST: transaction broadcasting, submission handling
- MUST NOT: poll for finality, retry internally unless explicitly documented

**awaitFinality()**
- MUST: settlement confirmation, chain inclusion verification, finality polling
- MUST NOT: resubmit transactions automatically

---

## 6. Runtime Flow

    Next.js SSR
        ↓
    Interouter Router
        ↓
    Parallel readState() via Promise.allSettled
        ↓
    Payment Detection (402)
        ↓
    preparePayment()
        ↓
    sign()                ← Signing is EXPLICIT here. Never hidden in readState.
        ↓
    submit()
        ↓
    awaitFinality()
        ↓
    Paid Retry
        ↓
    Single SSR Response

**Early exit:** If `paymentRequired === null` after `readState()`, the pipeline terminates. NearAdapter (read-only) always exits here.

---

## 7. Security Model

### @custodial-mvp (Current — pre-alpha only)

- Private key loaded from `process.env.OPENLEDGER_PRIVATE_KEY`
- Server-side hot wallet
- **Strict rule:** Wallet balance limited to minimal testnet amounts
- **Risk:** Server compromise = full wallet compromise

### @v2-migration (Planned)

NEAR-backed delegated session keys (FunctionCall access keys).

Per-session scoped constraints:
- Max budget (e.g. 5 USD equivalent)
- Time expiry (e.g. 1 hour)
- Contract whitelist (Decision3 AI inference only)

**Result:** Full backend compromise limits damage to the active session's budget — not the master wallet.

---

## 8. Concurrency Rules

Nonce management is critical infrastructure.

**Rules:**
- Concurrent requests must never produce nonce collisions
- Signing operations must remain deterministic
- Retries must preserve transaction ordering assumptions
- Failed submissions must not corrupt nonce state

**Avoid:**
- Global mutable state without synchronization
- Implicit async race assumptions
- Hidden retry loops

`Promise.allSettled` ensures slow RPC on one chain never blocks execution on another.

---

## 9. Open Blockers — DGrid Verification Required

These are implemented on assumptions. **Do NOT ship to production until DGrid confirms each:**

| # | Issue | Current assumption | Needs confirmation |
|---|-------|--------------------|---------------------|
| 1 | BigInt in `X-PAYMENT` header | Decimal strings (`"1000000"`) via base64 encoding | Decimal strings accepted, or hex `0x...` required? |
| 2 | `verifyingContract` in EIP-712 domain | ERC-20 token address (`requirement.asset`) | Token contract, or separate payment gateway? |
| 3 | Inference ID generation | Deterministic `keccak256` of resource URL | Deterministic hash, or random per-request Task UUID? |
| 4 | x402 header version | Code uses v1 `X-PAYMENT` header | Does OpenLedger support v1 (`X-PAYMENT`), v2 (`PAYMENT-SIGNATURE`), or both? Per official spec at github.com/coinbase/x402, v2 is the current standard. |
| 5 | `upto` scheme escrow mechanics | Not yet implemented — current code uses `exact` scheme only | Does OpenLedger's payment contract support temporary fund locking (escrow) based on `upto` limit, with provider drawing actual cost and remainder auto-released? |

---

## 10. Testing Requirements

All refactors MUST:
- preserve external behavior
- preserve public API semantics
- preserve test coverage
- maintain deterministic test execution

Before merging:
- All tests pass (current minimum: **33/33**)
- Existing behavior remains functionally equivalent unless explicitly approved

---

## 11. Refactor Rules

**DO:**
- Minimize diff size
- Preserve folder structure where possible
- Prefer incremental refactors
- Isolate architectural changes
- Maintain backwards compatibility

**DO NOT:**
- Rewrite unrelated files
- Introduce unnecessary abstractions
- Change external API semantics
- Restructure modules without justification

---

## 12. Code Style

**Prefer:** explicit naming, short deterministic methods, strong typing, predictable async flows, small composable utilities.

**Avoid:** magic behavior, hidden side effects, deeply nested abstractions, ambiguous naming.

Good naming: `preparePayment()`, `awaitFinality()`, `submit()`
Bad naming: `process()`, `handle()`, `doTransactionStuff()`

---

## 13. Agent Protocol — Working With Claude

### Model selection

| Task | Model |
|------|-------|
| Implementation, tests, bug fixes, refactor | **Sonnet** |
| Interface design, architectural decisions, breaking changes, security model | **Opus** |
| Strategic positioning, multi-source review, conflict arbitration | **Web Claude (Victor's chat)** |

### Mandatory pre-implementation protocol

Before modifying ANY file, Claude CLI MUST:
1. Read all relevant source files in full
2. Analyze current architecture
3. Identify coupling risks
4. Identify breaking type assumptions
5. Propose a concise refactor plan
6. **Wait for explicit user confirmation before implementing**

### Workflow rules

- One step at a time. Report back after each step.
- Run tests after every code change.
- Open assumptions go into ARCHITECTURE.md, never into code as silent decisions.
- Linux/Ubuntu commands only.
- For Next.js frontend tasks: provide ready-to-paste prompts for separate Gemini CLI workflow.

---

## 14. Decision Filter

Before introducing ANY architectural change, answer these 6 questions:

1. Does this reduce or increase developer-visible complexity?
2. Is the security boundary explicit?
3. Does this preserve deterministic behavior?
4. Is this abstraction actually necessary?
5. Would a new contributor understand this quickly?
6. Does this improve operational reliability?

**If the answer to any is unclear, prefer the simpler architecture.**

---

## 15. Current Status

- [x] ChainAdapter 5-stage lifecycle implemented
- [x] OpenLedgerAdapter monolith dismantled
- [x] NearAdapter read-only + NotSupportedError
- [x] Test suite at 33/33
- [x] ARCHITECTURE.md committed
- [x] CLAUDE.md committed
- [x] Repo pushed to GitHub
- [x] tsconfig.json excludes test files from dist/
- [x] npm publish @decision3/interouter-core
- [ ] DGrid confirmation on 5 open blockers
- [ ] Frontend integration (Next.js)
- [ ] Latency benchmark with numbers
- [ ] V2 Session Keys migration
- [ ] Implement circuit breaker for `upto` budget enforcement in router.ts
- [ ] Draft `upto` scheme specification for x402 Foundation
- [ ] Reference implementation of `upto` in OpenLedgerAdapter

---

## 16. Long-Term Vision

Interouter is NOT just an RPC wrapper, blockchain SDK, or retry helper.

The long-term goal is **AI-native orchestration infrastructure**:
- multi-chain state orchestration
- programmable AI payments
- deterministic SSR data hydration
- low-latency chain-aware inference execution
- invisible payment negotiation

The architecture evolves toward: session-key authorization, distributed execution, edge runtime compatibility, deterministic caching, RPC quorum support, chain-agnostic orchestration.

---

### Strategic Priority — `upto` Scheme Facilitator-Agnostic Middleware

The official x402 specification defines two payment schemes:
- `exact` — pay a fixed amount (currently the only widely deployed scheme)
- `upto` — pay based on actual consumption up to a budget limit (e.g., per LLM token)

The `upto` scheme is specified in the x402 foundation reference (`specs/schemes/upto/scheme_upto_evm.md`). However, **the ecosystem is fragmented**: divergences exist between the foundation reference implementation, the Coinbase CDP hosted facilitator, and self-hosted facilitators (dexter.cash, Faremeter). The CDP ↔ foundation divergence is a documented production-impacting bug (x402-foundation/x402#2437).

**Why this fragmentation matters:**
Sellers integrating `upto` today must choose a facilitator and hardcode assumptions about its wire shape. A facilitator incompatibility silently costs sellers money — payments rejected or mis-settled with no clear error.

**Interouter's opportunity: be the first production middleware that abstracts across facilitator implementations**, normalizing wire-shape divergences automatically so sellers remain compatible with all facilitators without code changes.

**Why AI inference makes this urgent:**
AI compute is fundamentally unpredictable. Unlike buying a file or sending tokens (fixed price), LLM output cannot be priced until streaming completes. A user or AI agent must authorize a budget ceiling ("up to $0.05"), and the system must settle in milliseconds without re-prompting — across whichever facilitator the seller happens to use.

### Two-Phase Implementation

**Phase 1 — `@custodial-mvp`:**
- `OpenLedgerAdapter.preparePayment()` signs payload with `upto` maximum amount per Inference Task ID
- Provider draws actual cost post-inference; remainder auto-released by smart contract
- Depends on: DGrid escrow contract support (Open Blocker #5)

**Phase 2 — `@v2-migration`:**
- User delegates NEAR session key with strict per-query AND per-session limits
- Example scope: "max $0.01 per query, max $2.00 per session"
- Result: AI agents can execute hundreds of inferences autonomously within a pre-authorized economic boundary, with zero risk of wallet drainage

### Mandatory Safety Mechanism

`router.ts` MUST implement a circuit breaker:
- If provider attempts to charge more than the `upto` value defined in `preparePayment()`, the pipeline halts immediately
- Throws an explicit `BudgetExceededError`
- No silent fallback, no partial settlement

### Contribution Path

1. Validate `exact` scheme with OpenLedger (resolve Open Blockers #1–4)
2. Map facilitator wire-shape divergences (CDP vs. foundation vs. self-hosted)
3. Build facilitator-agnostic normalization layer in `OpenLedgerAdapter`
4. Contribute findings upstream to x402-foundation/x402

This is the difference between "consuming a fragmented standard" and "being the layer that makes it work."

---

*Engine document. Updated as the project evolves. Last revision: reposition upto strategy — facilitator-agnostic middleware, not scheme author.*
