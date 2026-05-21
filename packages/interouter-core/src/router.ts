/**
 * Core routing types and InterouterRouter class.
 *
 * Architecture:
 *   ChainAdapters expose a five-stage lifecycle:
 *     readState → preparePayment → sign → submit → awaitFinality
 *   The router orchestrates these stages — read-only adapters complete at
 *   readState; adapters that surface a PaymentRequirement proceed through
 *   the full payment pipeline.
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
// Payment lifecycle types
// ---------------------------------------------------------------------------

/**
 * Minimal payment requirement — surfaced by readState() when a chain
 * interaction requires payment before it can proceed.
 * Adapter-specific types (e.g. X402PaymentRequirement) extend this base.
 */
export interface PaymentRequirement {
  scheme: string;
  network: string;
  maxAmountRequired: string;
}

/** Wrapper returned by readState() — chain data + optional payment signal. */
export interface ReadResult<TState = unknown> {
  state: TState;
  paymentRequired: PaymentRequirement | null;
}

/** Unsigned payment data prepared from a requirement. */
export interface PaymentPayload {
  requirement: PaymentRequirement;
}

/** Signed payment, ready for chain submission. */
export interface SignedPayload {
  payload: PaymentPayload;
  signature: string;
}

/** Outcome of submitting a signed payment. */
export interface SubmissionResult {
  accepted: boolean;
  txHash: string | null;
  /** The requirement that was fulfilled — threaded for awaitFinality. */
  requirement: PaymentRequirement;
  /** Response body from the submission endpoint (e.g. inference result). */
  responseData: unknown;
}

/** Finality confirmation + final adapter state after payment lifecycle. */
export interface FinalityStatus<TState = unknown> {
  finalized: boolean;
  txHash: string | null;
  state: TState;
}

// ---------------------------------------------------------------------------
// NotSupportedError — thrown by read-only adapters
// ---------------------------------------------------------------------------

/** Thrown when a read-only adapter's payment method is called. */
export class NotSupportedError extends Error {
  constructor(adapterId: string, method: string) {
    super(`${adapterId}: ${method}() is not supported — adapter is read-only`);
    this.name = "NotSupportedError";
  }
}

// ---------------------------------------------------------------------------
// Chain adapter interface
// ---------------------------------------------------------------------------

export interface ChainAdapter<TState = unknown> {
  /** Human-readable identifier, e.g. "near", "sui", "openledger" */
  readonly id: string;

  /** Read current on-chain state. Returns a PaymentRequirement when payment is needed before the operation can complete. */
  readState(context: RouteContext): Promise<ReadResult<TState>>;

  /** Build an unsigned payment from the requirement surfaced by readState(). */
  preparePayment(requirement: PaymentRequirement): Promise<PaymentPayload>;

  /** Sign the prepared payment payload. */
  sign(payload: PaymentPayload): Promise<SignedPayload>;

  /** Submit the signed payment to the network. */
  submit(signed: SignedPayload, context: RouteContext): Promise<SubmissionResult>;

  /** Wait for on-chain finality and return the final adapter state. */
  awaitFinality(result: SubmissionResult): Promise<FinalityStatus<TState>>;
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
  /** Timeout in milliseconds for each adapter's full lifecycle (default: 5000) */
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
   * - Each adapter's full lifecycle runs in parallel via Promise.allSettled.
   * - Within a single adapter, stages execute sequentially:
   *     readState → preparePayment → sign → submit → awaitFinality
   * - readState-only adapters (paymentRequired === null) skip the payment stages.
   * - Each adapter is individually bounded by adapterTimeoutMs.
   * - Failed or timed-out adapters are recorded as AdapterError; resolve() never throws.
   * - AI inference runs after all adapters complete, receiving the full chainState as input.
   */
  async resolve(context: RouteContext): Promise<RouteResult> {
    const start = Date.now();
    const timeoutMs = this.config.adapterTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;

    // Fan out — all adapter lifecycles run in parallel, each guarded by a per-adapter timeout.
    const settled = await Promise.allSettled(
      this.config.adapters.map((adapter) =>
        withTimeout(this.runAdapterLifecycle(adapter, context), timeoutMs, adapter.id),
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

  /**
   * Runs a single adapter through its full lifecycle.
   *
   * If readState() signals paymentRequired, the payment pipeline is executed
   * sequentially. Otherwise, the state from readState() is returned directly.
   */
  private async runAdapterLifecycle<TState>(
    adapter: ChainAdapter<TState>,
    context: RouteContext,
  ): Promise<TState> {
    const { state, paymentRequired } = await adapter.readState(context);

    if (paymentRequired === null) {
      return state;
    }

    const payload = await adapter.preparePayment(paymentRequired);
    const signed = await adapter.sign(payload);
    const submission = await adapter.submit(signed, context);
    const finality = await adapter.awaitFinality(submission);
    return finality.state;
  }
}
