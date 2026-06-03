# D3-ACP Protocol
## Decision3 Agent Coordination Protocol

## What Is D3-ACP

D3-ACP is the coordination protocol that ties the three
Decision3 pillars together into a coherent operating system
for autonomous AI agents.

It defines how agents:
1. **Pay** — via validated x402 facilitators (Interouter)
2. **Remember** — via bounded, markdown-anchored context windows
3. **Identify** — via decentralized identifiers owned by humans

## The Problem D3-ACP Solves

Autonomous AI agents today operate without discipline.
They hallucinate because context has no boundaries.
They fail payments because facilitators are incompatible.
They act anonymously because identity is undefined.

D3-ACP is the architectural contract that prevents all three.

## Protocol Stages

### Stage 1 — Payment Validation (LIVE)
- Agent requests a service
- Interouter selects the correct facilitator
- Payment lifecycle: readState → preparePayment → sign → submit → awaitFinality
- Fallback routing if facilitator fails
- Circuit breaker if budget exceeded

### Stage 2 — Context Isolation (Q3 2026)
- Agent operates inside a bounded context box
- Memory anchored to markdown structure
- No token bloat, no hallucination drift
- Context resets are explicit, not accidental

### Stage 3 — Identity / DID (Q4 2026)
- Agent carries a decentralized identifier
- Identifier is owned by a named human, not a corporation
- All agent actions are attributable and auditable

## Implementation Status

| Pillar | Module | Status |
|--------|--------|--------|
| Payment Validation | Interouter v0.1.6 | ✅ LIVE |
| Context Isolation | D3-ACP Context Module | 🔄 Drafted |
| Identity / DID | D3-ACP Identity Module | 📐 Architecture defined |

## Reference Implementation

EvoAgent is the reference implementation of D3-ACP.
Every protocol decision is validated against a real
production use case before it is finalized.

## License

MIT — open protocol, open infrastructure.
