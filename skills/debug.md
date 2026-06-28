# Debug Skill — Interouter

## Before debugging
- Ask Victor: what is the exact error message or unexpected behavior?
- Ask Victor: which test is failing, or which adapter is misbehaving?
- Never guess — read the actual source and test output first

## Debug order
1. Run full test suite first: cd packages/interouter-core && npm test
2. Read the exact failing test and the exact error output
3. Read the full source of the affected adapter
4. Check if it's a type assumption breaking (TypeScript strict mode)
5. Check if it's a mock/fixture issue in the test itself
6. Check if it's a nonce or concurrency assumption (section 8 in CLAUDE.md)
7. Only then touch code

## Rules
- Fix the root cause, not the symptom
- One fix at a time — run npm test after every change
- Never drop or modify a test to make it pass — fix the implementation
- Never introduce magic behavior or hidden side effects as a fix
- If the fix touches security model (section 7) — stop and confirm with Victor first
- 45/45 must pass before task is considered done

## When done
- State what the root cause was
- List every file changed
- State if ARCHITECTURE.md needs updating
- Do NOT publish to npm — Victor decides
