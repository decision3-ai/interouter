import { JsonRpcProvider } from "near-api-js";
import type { NearAdapterConfig, NearBalance, NearViewResult, ViewCallConfig } from "./types.js";

// near-api-js v7 uses JsonRpcProvider directly — no connect() or keyStores.

interface AccountView {
  amount: string;
  locked: string;
  storage_usage: number;
  code_hash: string;
}

interface CodeResult {
  result: number[];
}

function makeProvider(config: NearAdapterConfig): JsonRpcProvider {
  return new JsonRpcProvider({ url: config.nodeUrl });
}

/**
 * Fetches account state from NEAR RPC and normalises it into NearBalance +
 * metadata fields.
 */
export async function fetchAccountData(
  config: NearAdapterConfig,
  accountId: string,
): Promise<{ balance: NearBalance; storageUsage: number; codeHash: string }> {
  const provider = makeProvider(config);

  const view = await provider.query<AccountView>({
    request_type: "view_account",
    finality: "final",
    account_id: accountId,
  });

  const total = view.amount;
  const staked = view.locked;
  // available = total - staked (integer arithmetic on BigInt to avoid precision loss)
  const available = (BigInt(total) - BigInt(staked)).toString();

  return {
    balance: { total, available, staked },
    storageUsage: view.storage_usage,
    codeHash: view.code_hash,
  };
}

/**
 * Fans out all view calls in parallel via the NEAR RPC call_function query.
 * Individual failures are stored as NearViewResult tokens — not thrown.
 */
export async function fetchViewCalls(
  config: NearAdapterConfig,
  viewCalls: ViewCallConfig[],
): Promise<Record<string, unknown | NearViewResult>> {
  const provider = makeProvider(config);

  const settled = await Promise.allSettled(
    viewCalls.map(async ({ contractId, methodName, args = {} }) => {
      const argsBase64 = Buffer.from(JSON.stringify(args)).toString("base64");
      const raw = await provider.query<CodeResult>({
        request_type: "call_function",
        finality: "final",
        account_id: contractId,
        method_name: methodName,
        args_base64: argsBase64,
      });
      const decoded: unknown = JSON.parse(
        Buffer.from(raw.result).toString("utf8"),
      );
      return { key: `${contractId}::${methodName}`, result: decoded };
    }),
  );

  const viewResults: Record<string, unknown | NearViewResult> = {};
  for (let i = 0; i < viewCalls.length; i++) {
    const call = viewCalls[i];
    const outcome = settled[i];
    if (call === undefined || outcome === undefined) continue;

    const key = `${call.contractId}::${call.methodName}`;
    if (outcome.status === "fulfilled") {
      viewResults[key] = outcome.value.result;
    } else {
      const reason = outcome.reason instanceof Error
        ? outcome.reason.message
        : String(outcome.reason);
      viewResults[key] = { error: true, reason } satisfies NearViewResult;
    }
  }

  return viewResults;
}
