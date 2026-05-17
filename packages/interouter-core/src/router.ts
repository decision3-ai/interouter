/**
 * Core routing types and InterouterRouter class.
 *
 * Architecture:
 *   ChainAdapters fetch on-chain state in parallel.
 *   InferenceProvider optionally enriches the aggregated payload with AI results.
 *   resolve() merges everything into a single RouteResult delivered to the frontend.
 */

const DEFAULT_ADAPTER_TIMEOUT_MS = 5_000;

/**
 * Races a promise against a timeout. Rejects with a labelled error on expiry.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Adapter "${label}" timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Chain adapter interface
// ---------------------------------------------------------------------------

export interface ChainAdapter<TState = unknown> {
  /** Human-readable identifier, e.g. "near", "sui", "walrus" */
  readonly id: string;
  /** Fetch current on-chain state relevant to the given route context. */
  fetchState(context: RouteContext): Promise<TState>;
}

// ---------------------------------------------------------------------------
// AI inference interface
// ---------------------------------------------------------------------------

export interface InferenceProvider<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  infer(input: TInput): Promise<TOutput>;
}

// ---------------------------------------------------------------------------
// Route context — passed to every adapter on each request
// ---------------------------------------------------------------------------

export interface RouteContext {
  /** URL path being resolved, e.g. "/dashboard" */
  path: string;
  /** Optional wallet address of the authenticated user */
  walletAddress?: string;
  /** Arbitrary key/value bag for adapter-specific hints */
  params: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Result shape returned to the Next.js frontend
// ---------------------------------------------------------------------------

/** Structured error token stored in chainState when an adapter fails or times out. */
export interface AdapterError {
  error: true;
  reason: string;
}

export interface RouteResult {
  /** Aggregated on-chain state keyed by adapter id. Failed adapters surface as AdapterError. */
  chainState: Record<string, unknown | AdapterError>;
  /** AI inference output, if an InferenceProvider was configured. Null on failure. */
  inference: unknown | null;
  /** Wall-clock milliseconds taken to resolve */
  resolvedInMs: number;
  /** ISO timestamp of resolution */
  resolvedAt: string;
}

// ---------------------------------------------------------------------------
// Router configuration
// ---------------------------------------------------------------------------

export interface RouterConfig {
  /** Chain adapters to run in parallel on every resolve() call */
  adapters: ReadonlyArray<ChainAdapter>;
  /** Optional AI inference provider */
  aiProvider?: InferenceProvider;
  /** Timeout in milliseconds for each adapter's fetchState (default: 5000) */
  adapterTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// InterouterRouter
// ---------------------------------------------------------------------------

export class InterouterRouter {
  private readonly config: RouterConfig;

  constructor(config: RouterConfig) {
    this.config = config;
  }

  /**
   * Resolve a route context into a single aggregated RouteResult.
   *
   * - All chain adapters are fetched in parallel via Promise.allSettled.
   * - Each adapter is individually bounded by adapterTimeoutMs.
   * - Failed or timed-out adapters are recorded as AdapterError; resolve() never throws.
   * - AI inference runs after fan-out completes, receiving the full chainState as input.
   */
  async resolve(context: RouteContext): Promise<RouteResult> {
    const start = Date.now();
    const timeoutMs = this.config.adapterTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;

    // Fan out — all adapters run in parallel, each guarded by a per-adapter timeout.
    const settled = await Promise.allSettled(
      this.config.adapters.map((adapter) =>
        withTimeout(adapter.fetchState(context), timeoutMs, adapter.id),
      ),
    );

    // Collect results — fulfilled values stored directly, rejections as AdapterError tokens.
    const chainState: Record<string, unknown | AdapterError> = {};
    for (let i = 0; i < this.config.adapters.length; i++) {
      const adapter = this.config.adapters[i];
      const result = settled[i];
      if (adapter === undefined || result === undefined) continue;

      if (result.status === "fulfilled") {
        chainState[adapter.id] = result.value;
      } else {
        const reason = result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);
        chainState[adapter.id] = { error: true, reason } satisfies AdapterError;
      }
    }

    // AI inference — optional enrichment step; failure is non-fatal.
    let inference: unknown = null;
    if (this.config.aiProvider !== undefined) {
      try {
        inference = await this.config.aiProvider.infer(chainState);
      } catch {
        inference = null;
      }
    }

    return {
      chainState,
      inference,
      resolvedInMs: Date.now() - start,
      resolvedAt: new Date().toISOString(),
    };
  }
}
