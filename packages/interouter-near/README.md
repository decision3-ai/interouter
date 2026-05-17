# @decision3/interouter-near

NEAR Protocol chain adapter for [@decision3/interouter-core](../interouter-core/README.md).

Implements the `ChainAdapter<NearState>` interface. Fetches account balance, storage usage, contract code hash, and optional view-function results — all in parallel — and returns a single typed `NearState` object.

---

## Usage

```ts
import { InterouterRouter } from "@decision3/interouter-core";
import { NearAdapter } from "@decision3/interouter-near";

const router = new InterouterRouter({
  adapters: [
    new NearAdapter({
      networkId: "mainnet",
      nodeUrl: "https://rpc.mainnet.near.org",
      // accountId can also be omitted and resolved from context.walletAddress
      viewCalls: [
        {
          contractId: "token.near",
          methodName: "ft_balance_of",
          args: { account_id: "alice.near" },
        },
      ],
    }),
  ],
});

const result = await router.resolve({
  path: "/dashboard",
  walletAddress: "alice.near",
  params: {},
});

// result.chainState.near → NearState
```

---

## NearState shape

```ts
{
  accountId: string
  balance: {
    total: string      // yoctoNEAR
    available: string  // yoctoNEAR
    staked: string     // yoctoNEAR
  }
  storageUsage: number
  codeHash: string     // "11111..." = no contract deployed
  viewResults: {
    "token.near::ft_balance_of": "1000000000000000000000000"
    // failed calls: { error: true, reason: "..." }
  }
}
```

---

## Error handling

| Scenario | Behaviour |
|---|---|
| No `accountId` in config or context | Throws `NearAdapterError` — caught by `InterouterRouter` as `AdapterError` |
| RPC unreachable | Rejects — caught by `InterouterRouter` as `AdapterError` |
| Individual view call fails | Stored inline as `{ error: true, reason }` under its key — does not fail the adapter |

---

## License

MIT — Decision3
