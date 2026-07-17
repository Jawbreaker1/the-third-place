export type DmThreadId = string;

export type DmTurnCancellationKind = "superseded" | "cancelled" | "disposed";

export class DmTurnCancellationError extends Error {
  readonly kind: DmTurnCancellationKind;
  readonly threadId: DmThreadId;
  readonly epoch: number;

  constructor(kind: DmTurnCancellationKind, threadId: DmThreadId, epoch: number) {
    super(`DM turn ${epoch} for ${threadId} was ${kind}`);
    this.name = "DmTurnCancellationError";
    this.kind = kind;
    this.threadId = threadId;
    this.epoch = epoch;
  }
}

export interface TypingLease {
  readonly released: boolean;
  release(): void;
}

/**
 * Reference-counted typing state with idempotent leases.
 *
 * `onActiveChange` runs only on the 0 -> 1 and 1 -> 0 transitions. This makes
 * overlapping work safe without emitting a false "stopped typing" event when
 * another operation still owns a lease.
 */
export class TypingLeaseCounter<TKey> {
  private readonly leases = new Map<TKey, Set<symbol>>();

  constructor(
    private readonly onActiveChange: (key: TKey, active: boolean) => void = () => undefined,
  ) {}

  acquire(key: TKey): TypingLease {
    const leaseId = Symbol("typing-lease");
    const current = this.leases.get(key) ?? new Set<symbol>();
    const wasInactive = current.size === 0;
    current.add(leaseId);
    this.leases.set(key, current);
    if (wasInactive) this.onActiveChange(key, true);

    let released = false;
    return {
      get released() {
        return released;
      },
      release: () => {
        if (released) return;
        released = true;
        const active = this.leases.get(key);
        if (!active || !active.delete(leaseId)) return;
        if (active.size > 0) return;
        this.leases.delete(key);
        this.onActiveChange(key, false);
      },
    };
  }

  count(key: TKey): number {
    return this.leases.get(key)?.size ?? 0;
  }

  isActive(key: TKey): boolean {
    return this.count(key) > 0;
  }

  clear(key: TKey): void {
    const active = this.leases.get(key);
    if (!active?.size) return;
    this.leases.delete(key);
    this.onActiveChange(key, false);
  }

  clearAll(): void {
    for (const key of [...this.leases.keys()]) this.clear(key);
  }
}

export interface DmGenerationToken {
  readonly threadId: DmThreadId;
  /** Monotonically increasing within one thread for the coordinator lifetime. */
  readonly epoch: number;
  /** Monotonically increasing across all threads for the coordinator lifetime. */
  readonly generationId: number;
}

export interface DmTurn<TMessage> {
  readonly token: DmGenerationToken;
  readonly messages: readonly TMessage[];
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

export interface DmTurnCoordinatorOptions<TMessage, TResult> {
  debounceMs?: number;
  generate(turn: DmTurn<TMessage>): Promise<TResult | undefined>;
  /**
   * Called synchronously only after the coordinator's final token check.
   * Keep the durable store mutation and outward emit in this callback so they
   * share the same publication gate.
   */
  publish(result: TResult, turn: DmTurn<TMessage>): void;
  onTypingChange?: (threadId: DmThreadId, active: boolean) => void;
  onError?: (error: unknown, turn: DmTurn<TMessage>) => void;
  /** Releases caller-owned completion state for messages discarded by cancel/dispose. */
  onCancelled?: (
    messages: readonly TMessage[],
    threadId: DmThreadId,
    kind: Exclude<DmTurnCancellationKind, "superseded">,
  ) => void;
}

export interface DmEnqueueReceipt {
  readonly threadId: DmThreadId;
  readonly epoch: number;
  readonly pendingCount: number;
}

export interface DmTurnSnapshot {
  readonly threadId: DmThreadId;
  readonly epoch: number;
  readonly pendingCount: number;
  /** Ordered human messages retained after the latest unanswered attempt. */
  readonly unansweredCount: number;
  readonly debounceScheduled: boolean;
  readonly activeToken?: DmGenerationToken;
  readonly typing: boolean;
}

interface ActiveGeneration<TMessage> {
  readonly token: DmGenerationToken;
  readonly messages: readonly TMessage[];
  readonly controller: AbortController;
  completion: Promise<void>;
  publicationCommitted: boolean;
}

interface ThreadState<TMessage> {
  readonly threadId: DmThreadId;
  epoch: number;
  pending: TMessage[];
  unanswered: TMessage[];
  debounceTimer?: ReturnType<typeof setTimeout>;
  active?: ActiveGeneration<TMessage>;
  typingLease?: TypingLease;
}

const checkedDebounceMs = (value: number | undefined): number => {
  const debounceMs = value ?? 700;
  if (!Number.isFinite(debounceMs) || debounceMs < 0) {
    throw new RangeError("debounceMs must be a finite non-negative number");
  }
  return debounceMs;
};

/**
 * Coordinates one cancellable DM generation at a time per thread.
 *
 * The coordinator has no knowledge of message language or content. Ordering is
 * exactly enqueue order. A new human message supersedes an unfinished turn,
 * carries its unpublished messages into the next burst, and invalidates its
 * publication token even if the generator ignores AbortSignal.
 */
export class DmTurnCoordinator<TMessage, TResult> {
  readonly debounceMs: number;

  private readonly states = new Map<DmThreadId, ThreadState<TMessage>>();
  private readonly typing: TypingLeaseCounter<DmThreadId>;
  private nextGenerationId = 1;
  private disposed = false;

  constructor(private readonly options: DmTurnCoordinatorOptions<TMessage, TResult>) {
    this.debounceMs = checkedDebounceMs(options.debounceMs);
    this.typing = new TypingLeaseCounter(options.onTypingChange);
  }

  enqueue(threadId: DmThreadId, message: TMessage): DmEnqueueReceipt {
    this.assertUsableThreadId(threadId);
    const state = this.stateFor(threadId);
    state.epoch += 1;
    this.invalidateActive(state, "superseded", true);
    // An unanswered burst is dormant: it owns no timer or typing lease. Only
    // fresh human input revives it, exactly once, ahead of that new message.
    if (state.unanswered.length > 0) {
      state.pending = [...state.unanswered, ...state.pending];
      state.unanswered = [];
    }
    state.pending.push(message);
    this.ensureTyping(state);
    this.schedule(state);
    return Object.freeze({
      threadId,
      epoch: state.epoch,
      pendingCount: state.pending.length,
    });
  }

  /** Starts the currently pending burst immediately. */
  flush(threadId: DmThreadId): Promise<void> {
    const state = this.states.get(threadId);
    if (!state) return Promise.resolve();
    this.clearTimer(state);
    if (state.pending.length === 0) return state.active?.completion ?? Promise.resolve();
    return this.startGeneration(state);
  }

  /**
   * Invalidates current work but retains its unpublished messages for one new
   * debounced attempt. Use `cancel` when the messages must be discarded.
   */
  supersede(threadId: DmThreadId): boolean {
    const state = this.states.get(threadId);
    if (!state || (!state.active && !state.debounceTimer && state.pending.length === 0)) return false;
    state.epoch += 1;
    this.invalidateActive(state, "superseded", true);
    if (state.pending.length > 0) {
      this.ensureTyping(state);
      this.schedule(state);
    } else {
      this.releaseTypingIfIdle(state);
    }
    return true;
  }

  /** Aborts generation, clears pending input and suppresses every late result. */
  cancel(threadId: DmThreadId): boolean {
    return this.cancelState(threadId, "cancelled");
  }

  cancelAll(): void {
    for (const threadId of [...this.states.keys()]) this.cancelState(threadId, "cancelled");
  }

  dispose(): void {
    if (this.disposed) return;
    for (const threadId of [...this.states.keys()]) this.cancelState(threadId, "disposed");
    this.typing.clearAll();
    this.disposed = true;
  }

  isCurrent(token: DmGenerationToken): boolean {
    if (this.disposed) return false;
    const state = this.states.get(token.threadId);
    return Boolean(
      state &&
      state.epoch === token.epoch &&
      state.active?.token === token &&
      !state.active.controller.signal.aborted,
    );
  }

  snapshot(threadId: DmThreadId): DmTurnSnapshot {
    const state = this.states.get(threadId);
    return Object.freeze({
      threadId,
      epoch: state?.epoch ?? 0,
      pendingCount: state?.pending.length ?? 0,
      unansweredCount: state?.unanswered.length ?? 0,
      debounceScheduled: Boolean(state?.debounceTimer),
      ...(state?.active ? { activeToken: state.active.token } : {}),
      typing: this.typing.isActive(threadId),
    });
  }

  private stateFor(threadId: DmThreadId): ThreadState<TMessage> {
    const current = this.states.get(threadId);
    if (current) return current;
    const created: ThreadState<TMessage> = { threadId, epoch: 0, pending: [], unanswered: [] };
    this.states.set(threadId, created);
    return created;
  }

  private assertUsableThreadId(threadId: DmThreadId): void {
    if (this.disposed) throw new Error("DmTurnCoordinator has been disposed");
    if (!threadId.trim()) throw new TypeError("threadId must not be empty");
  }

  private ensureTyping(state: ThreadState<TMessage>): void {
    if (!state.typingLease || state.typingLease.released) {
      state.typingLease = this.typing.acquire(state.threadId);
    }
  }

  private releaseTypingIfIdle(state: ThreadState<TMessage>): void {
    if (state.active || state.debounceTimer || state.pending.length > 0) return;
    state.typingLease?.release();
    state.typingLease = undefined;
  }

  private clearTimer(state: ThreadState<TMessage>): void {
    if (!state.debounceTimer) return;
    clearTimeout(state.debounceTimer);
    state.debounceTimer = undefined;
  }

  private schedule(state: ThreadState<TMessage>): void {
    this.clearTimer(state);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = undefined;
      void this.startGeneration(state);
    }, this.debounceMs);
  }

  private invalidateActive(
    state: ThreadState<TMessage>,
    kind: DmTurnCancellationKind,
    requeue: boolean,
  ): void {
    const active = state.active;
    if (!active) return;
    state.active = undefined;
    if (requeue && !active.publicationCommitted) {
      state.pending = [...active.messages, ...state.pending];
    }
    if (!active.publicationCommitted && !active.controller.signal.aborted) {
      active.controller.abort(new DmTurnCancellationError(kind, state.threadId, active.token.epoch));
    }
  }

  private startGeneration(state: ThreadState<TMessage>): Promise<void> {
    if (this.disposed || state.pending.length === 0) {
      this.releaseTypingIfIdle(state);
      return Promise.resolve();
    }
    this.ensureTyping(state);
    const messages = Object.freeze([...state.pending]);
    state.pending = [];
    const token = Object.freeze({
      threadId: state.threadId,
      epoch: state.epoch,
      generationId: this.nextGenerationId++,
    });
    const controller = new AbortController();
    const active: ActiveGeneration<TMessage> = {
      token,
      messages,
      controller,
      completion: Promise.resolve(),
      publicationCommitted: false,
    };
    state.active = active;
    const turn: DmTurn<TMessage> = Object.freeze({
      token,
      messages,
      signal: controller.signal,
      isCurrent: () => this.isCurrent(token),
    });
    active.completion = this.runGeneration(state, active, turn);
    return active.completion;
  }

  private async runGeneration(
    state: ThreadState<TMessage>,
    active: ActiveGeneration<TMessage>,
    turn: DmTurn<TMessage>,
  ): Promise<void> {
    try {
      const result = await this.options.generate(turn);
      if (!this.isCurrent(active.token)) return;
      if (result === undefined) {
        state.unanswered = [...active.messages];
        return;
      }
      // Publication is synchronous and begins only after this final gate. Mark
      // the batch committed first so a re-entrant enqueue never requeues input
      // that is already being published.
      active.publicationCommitted = true;
      this.options.publish(result, turn);
    } catch (error) {
      if (this.isCurrent(active.token) && !active.controller.signal.aborted) {
        // Once publication has begun, its callback may already have committed
        // externally; never retain that batch and risk a duplicate. Generation
        // failures happen before this flag and remain available to the next
        // human turn without spinning an automatic retry loop.
        const shouldRetain = !active.publicationCommitted;
        this.reportError(error, turn);
        // onError is allowed to synchronously enqueue/cancel. In that case the
        // active batch was already requeued or discarded, so retaining it here
        // as well would duplicate it on the following turn.
        if (shouldRetain && this.isCurrent(active.token)) {
          state.unanswered = [...active.messages];
        }
      }
    } finally {
      if (state.active === active) state.active = undefined;
      this.releaseTypingIfIdle(state);
    }
  }

  private reportError(error: unknown, turn: DmTurn<TMessage>): void {
    try {
      this.options.onError?.(error, turn);
    } catch {
      // Error reporting cannot reopen publication or leave typing stuck.
    }
  }

  private cancelState(threadId: DmThreadId, kind: DmTurnCancellationKind): boolean {
    const state = this.states.get(threadId);
    if (!state) return false;
    const hadWork = Boolean(
      state.active || state.debounceTimer || state.pending.length > 0 || state.unanswered.length > 0,
    );
    if (!hadWork) return false;
    const discarded = [
      ...(state.active && !state.active.publicationCommitted ? state.active.messages : []),
      ...state.pending,
      ...state.unanswered,
    ];
    state.epoch += 1;
    this.clearTimer(state);
    state.pending = [];
    state.unanswered = [];
    this.invalidateActive(state, kind, false);
    state.typingLease?.release();
    state.typingLease = undefined;
    if (kind !== "superseded" && discarded.length > 0) {
      try {
        this.options.onCancelled?.(discarded, threadId, kind);
      } catch {
        // Cancellation cleanup cannot reopen publication or leave typing live.
      }
    }
    return true;
  }
}
