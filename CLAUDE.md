# Decision3 / Interouter — Working Rules

## Architecture philosophy (permanent, non-negotiable)
Every service in the Decision3 ecosystem (EvoAgent, Interouter, D3RCP/algorand-resource-server, future modules) must be technically STANDALONE and separable — own repo, own dependencies, no shared monolithic backend. Goal: a third-party developer must be able to take ONE module without needing the whole EvoAgent monorepo. Brand/marketing connects them; code does not depend on them.

## Working style ("cigla po ciglu" — brick by brick)
- No shortcuts or temporary fixes — build correctly the first time.
- Always show the full diff (git diff, not a summary) before committing. Wait for explicit confirmation.
- Never commit or push without being told to.
- Sensitive values (API keys, mnemonics) are transferred file-to-file via pipe (grep | ssh "cat >>"), NEVER pasted in chat or CLI output.
- One step at a time. Do not batch multiple unrelated changes into one commit.

## Current stack context
- algorand-resource-server: standalone x402 seller endpoint (Express, @x402-avm), MAINNET, GoPlausible facilitator. Own DeepSeek API key, not calling EvoAgent backend.
- Interouter-core: published on npm as @decision3/interouter-core, MIT licensed.
- Deployed on VPS at /opt/interouter (separate from /opt/agentevo).
