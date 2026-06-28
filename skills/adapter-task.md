# Adapter Task Skill

## Before you start
- Read CLAUDE.md fully — especially sections 5, 6, 7, 8
- Identify which adapter is affected: NearAdapter.ts or OpenLedgerAdapter.ts
- Read the full source of the affected adapter before touching anything
- State which methods you will change and why
- Ask ONE question if anything is unclear

## Rules
- Every adapter MUST implement the full ChainAdapter lifecycle: readState → preparePayment → sign → submit → awaitFinality
- readState() MUST NOT sign or submit — read-only only
- preparePayment() MUST NOT sign — preparation only
- sign() MUST NOT submit — signing only
- submit() MUST NOT poll finality — submission only
- All signing assumptions MUST be documented in code comments
- No implicit custody, no hidden signing, no silent transaction execution
- No new dependencies without Victor's approval
- Max 8 files per task

## After every change
- Run full test suite: cd packages/interouter-core && npm test
- 45/45 must pass — if any test fails, fix before continuing
- Never leave the suite below 45/45

## When done
- List every file changed
- State if any open blockers in CLAUDE.md section 9 are affected
- State if ARCHITECTURE.md needs updating
- Do NOT publish to npm — Victor decides
