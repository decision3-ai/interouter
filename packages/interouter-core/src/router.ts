/**
 * Core routing types and InterouterRouter class.
 *
 * Architecture:
 *   ChainAdapters expose a five-stage lifecycle:
 *     readState → preparePayment → sign → submit → awaitFinality
 *   resolve() runs in three phases:
 *     Phase 1 — readState() in parallel for all adapters. Read-only adapters
 *               (paymentRequired === null) resolve immediately. Payment-required
 *               adapters are queued in priority order (adapter array order).
 *     Phase 2 — Payment pipeline runs sequentially in priority order.
 *               First success wins; failures fall through to the next adapter.
 *     Phase 3 — Optional AI inference over the full chainState.
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
  /**
   * Actual amount charged by the provider, in the token's smallest unit.
   * Populated by adapters that support the `upto` scheme.
   * Absent for `exact` scheme — charge is always maxAmountRequired.
   */
  actualCharge?: string;
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

/**
 * Thrown when a provider reports an actual charge exceeding the authorized ceiling.
 * Halts the pipeline immediately — no silent overspend, no partial settlement.
 * Only fires when SubmissionResult.actualCharge is populated (upto scheme adapters).
 */
export class BudgetExceededError extends Error {
  constructor(adapterId: string, actual: string, authorized: string) {
    super(
      `${adapterId}: provider charged ${actual} but authorized maximum was ${authorized}`,
    );
    this.name = "BudgetExceededError";
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
  /**
   * Chain adapters. Array order determines payment fallback priority —
   * adapters[0] is tried first; on failure, adapters[1] is tried, and so on.
   */
  adapters: ReadonlyArray<ChainAdapter>;
  /** Optional AI inference provider */
  aiProvider?: InferenceProvider;
  /** Timeout in milliseconds per adapter per phase (default: 5000) */
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
   * Phase 1 — readState() runs in parallel for all adapters, each guarded by
   *   adapterTimeoutMs. Read-only adapters (paymentRequired === null) store
   *   their state immediately. Payment-required adapters queue in priority order.
   *
   * Phase 2 — Payment pipeline runs sequentially in priority order.
   *   First success wins; the remaining payment adapters are skipped.
   *   Failures (throws, timeout, or accepted=false) store an AdapterError and
   *   fall through to the next adapter. resolve() never throws.
   *
   * Phase 3 — AI inference runs over the full chainState. Failure is non-fatal.
   */
  async resolve(context: RouteContext): Promise<RouteResult> {
    const start = Date.now();
    const timeoutMs = this.config.adapterTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;

    // Phase 1: readState() — all adapters in parallel, each guarded by per-adapter timeout.
    const readSettled = await Promise.allSettled(
      this.config.adapters.map((adapter) =>
        withTimeout(
          adapter.readState(context).then((readResult) => ({ adapter, readResult })),
          timeoutMs,
          adapter.id,
        ),
      ),
    );

    // Partition: read-only adapters store state immediately; payment-required adapters
    // queue in priority order for the sequential fallback pipeline.
    const chainState: Record<string, unknown | AdapterError> = {};
    const paymentQueue: Array<{ adapter: ChainAdapter; readResult: ReadResult<unknown> }> = [];

    for (let i = 0; i < this.config.adapters.length; i++) {
      const adapter = this.config.adapters[i];
      const settled = readSettled[i];
      if (adapter === undefined || settled === undefined) continue;

      if (settled.status === "rejected") {
        const reason = settled.reason instanceof Error
          ? settled.reason.message
          : String(settled.reason);
        chainState[adapter.id] = { error: true, reason } satisfies AdapterError;
        continue;
      }

      const { readResult } = settled.value;
      if (readResult.paymentRequired === null) {
        chainState[adapter.id] = readResult.state;
      } else {
        paymentQueue.push({ adapter, readResult });
      }
    }

    // Phase 2: Payment pipeline — sequential in priority order, first success wins.
    // Each attempt is individually bounded by adapterTimeoutMs.
    // accepted=false and thrown errors both trigger fallback to the next adapter.
    for (const { adapter, readResult } of paymentQueue) {
      try {
        const state = await withTimeout(
          this.runPaymentPipeline(adapter, readResult, context),
          timeoutMs,
          adapter.id,
        );
        chainState[adapter.id] = state;
        break; // First success wins — remaining payment adapters are skipped.
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        chainState[adapter.id] = { error: true, reason } satisfies AdapterError;
        // Continue to next adapter in queue.
      }
    }

    // Phase 3: AI inference — optional enrichment; failure is non-fatal.
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
   * Runs the payment stages of a single adapter:
   *   preparePayment → sign → submit → awaitFinality
   *
   * readState() has already completed — readResult is passed in.
   * Throws on any failure so the caller can fall back to the next adapter:
   *   - Any stage throws
   *   - BudgetExceededError (actualCharge > maxAmountRequired)
   *   - submission.accepted === false (payment rejected by provider)
   */
  private async runPaymentPipeline<TState>(
    adapter: ChainAdapter<TState>,
    readResult: ReadResult<TState>,
    context: RouteContext,
  ): Promise<TState> {
    const { paymentRequired } = readResult;
    if (paymentRequired === null) return readResult.state;

    const payload = await adapter.preparePayment(paymentRequired);
    const signed = await adapter.sign(payload);
    const submission = await adapter.submit(signed, context);

    // Circuit breaker: halt on budget overrun (upto scheme).
    if (
      submission.actualCharge !== undefined &&
      BigInt(submission.actualCharge) > BigInt(paymentRequired.maxAmountRequired)
    ) {
      throw new BudgetExceededError(
        adapter.id,
        submission.actualCharge,
        paymentRequired.maxAmountRequired,
      );
    }

    // Non-accepted submission triggers fallback to the next adapter.
    if (!submission.accepted) {
      throw new Error(
        typeof submission.responseData === "string"
          ? submission.responseData
          : "payment submission rejected",
      );
    }

    const finality = await adapter.awaitFinality(submission);
    return finality.state;
  }
}
