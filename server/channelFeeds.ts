import type {
  ChannelFeedPollTiming,
  ChannelFeedScheduleState,
} from "./channelFeedStore.js";

/**
 * A small, model-independent scheduler for typed channel feeds.
 *
 * Adapters own fetching and domain validation. The coordinator owns only
 * cadence, room-local human activity, single-flight execution and durable
 * scheduling metadata. It never creates chat messages or calls the social
 * director.
 */

export interface SchedulableChannelFeedCard {
  id: string;
  channelId: string;
  revision: number;
  updatedAt: string;
}

export interface ChannelFeedPollContext<TCard extends SchedulableChannelFeedCard> {
  now: number;
  previous?: TCard;
  signal: AbortSignal;
}

export type ChannelFeedPollResult<TCard extends SchedulableChannelFeedCard> =
  | { kind: "updated"; card: TCard }
  | { kind: "unchanged" }
  | { kind: "unavailable"; card?: TCard };

export interface ChannelFeedAdapter<TCard extends SchedulableChannelFeedCard> {
  /** Stable server-owned identifier; it is also the durable schedule key. */
  id: string;
  channelId: string;
  activeIntervalMs: number;
  idleIntervalMs: number;
  activityWindowMs: number;
  /** Protects the provider when a new human activity event accelerates a poll. */
  minAttemptGapMs: number;
  /** A hung adapter is aborted without blocking every other feed indefinitely. */
  pollTimeoutMs?: number;
  /**
   * Revalidate a structurally stored card against the current clock before it
   * can become public. Without this domain hook, persisted presentation data
   * stays hidden until the first successful poll.
   */
  restorePersistedCard?(card: TCard, now: number): TCard | undefined;
  poll(context: ChannelFeedPollContext<TCard>): Promise<ChannelFeedPollResult<TCard>>;
}

export type ChannelFeedCardDraftFor<TCard extends SchedulableChannelFeedCard> =
  Omit<TCard, "revision">;

/**
 * The narrow structural surface implemented by ChannelFeedStore. Keeping the
 * port generic lets the scheduler be tested with a future football card before
 * that presentation type joins the public transport union.
 */
export interface ChannelFeedStorePort<TCard extends SchedulableChannelFeedCard> {
  load(): Promise<void>;
  cards(): TCard[];
  getCard(feedId: string): TCard | undefined;
  schedule(feedId: string): ChannelFeedScheduleState | undefined;
  publishSuccess(
    feedId: string,
    draft: ChannelFeedCardDraftFor<TCard>,
    timing: ChannelFeedPollTiming,
  ): Promise<TCard>;
  publishFailure(
    feedId: string,
    timing: ChannelFeedPollTiming,
    unavailableDraft?: ChannelFeedCardDraftFor<TCard>,
  ): Promise<{ card?: TCard; cardChanged: boolean; schedule: ChannelFeedScheduleState }>;
  publishUnchanged(feedId: string, timing: ChannelFeedPollTiming): Promise<ChannelFeedScheduleState>;
  reschedule(feedId: string, nextPollAt: number): Promise<ChannelFeedScheduleState>;
  flush(): Promise<void>;
}

export interface ChannelFeedTimerRuntime {
  schedule(callback: () => void | Promise<void>, delayMs: number): unknown;
  cancel(handle: unknown): void;
}

const defaultTimers: ChannelFeedTimerRuntime = {
  schedule: (callback, delayMs) => setTimeout(() => void callback(), delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ChannelFeedCoordinatorOptions<TCard extends SchedulableChannelFeedCard> {
  adapters: readonly ChannelFeedAdapter<TCard>[];
  store: ChannelFeedStorePort<TCard>;
  now?: () => number;
  timers?: ChannelFeedTimerRuntime;
  retryBaseMs?: number;
  retryMaximumMs?: number;
  onCard?: (card: TCard) => void;
  onError?: (feedId: string, error: unknown) => void;
}

interface FeedRuntime<TCard extends SchedulableChannelFeedCard> {
  adapter: ChannelFeedAdapter<TCard>;
  nextPollAt: number;
  failures: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  card?: TCard;
  inFlight?: Promise<void>;
  abort?: AbortController;
}

const MINUTE_MS = 60_000;
const DEFAULT_RETRY_BASE_MS = MINUTE_MS;
const DEFAULT_RETRY_MAXIMUM_MS = 30 * MINUTE_MS;
const MAX_INTERVAL_MS = 24 * 60 * MINUTE_MS;
const MAX_CLOCK_SKEW_MS = 5 * MINUTE_MS;

const boundedMilliseconds = (
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number => {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
};

const validIdentifier = (value: string): boolean =>
  /^[a-z0-9][a-z0-9-]{1,63}$/u.test(value);

const copyCard = <TCard extends SchedulableChannelFeedCard>(card: TCard): TCard =>
  structuredClone(card);

/**
 * Generic single-process scheduler for deterministic channel integrations.
 * One coordinator may host heterogeneous cards by using a discriminated card
 * union as TCard.
 */
export class ChannelFeedCoordinator<TCard extends SchedulableChannelFeedCard> {
  private readonly store: ChannelFeedStorePort<TCard>;
  private readonly now: () => number;
  private readonly timers: ChannelFeedTimerRuntime;
  private readonly retryBaseMs: number;
  private readonly retryMaximumMs: number;
  private readonly onCard?: (card: TCard) => void;
  private readonly onError?: (feedId: string, error: unknown) => void;
  private readonly feeds = new Map<string, FeedRuntime<TCard>>();
  private readonly lastHumanActivityAtByChannel = new Map<string, number>();
  private timer?: unknown;
  private started = false;
  private closed = false;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private schedulerPromise?: Promise<void>;

  constructor(options: ChannelFeedCoordinatorOptions<TCard>) {
    if (options.adapters.length === 0) {
      throw new TypeError("ChannelFeedCoordinator requires at least one adapter");
    }
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? defaultTimers;
    this.retryBaseMs = boundedMilliseconds(
      options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
      1_000,
      MAX_INTERVAL_MS,
      "retryBaseMs",
    );
    this.retryMaximumMs = boundedMilliseconds(
      options.retryMaximumMs ?? DEFAULT_RETRY_MAXIMUM_MS,
      this.retryBaseMs,
      MAX_INTERVAL_MS,
      "retryMaximumMs",
    );
    this.onCard = options.onCard;
    this.onError = options.onError;

    for (const adapter of options.adapters) {
      this.validateAdapter(adapter);
      if (this.feeds.has(adapter.id)) throw new TypeError(`Duplicate channel feed adapter: ${adapter.id}`);
      this.feeds.set(adapter.id, {
        adapter,
        nextPollAt: 0,
        failures: 0,
      });
    }
  }

  /** Loads durable state and schedules overdue work. Safe to call repeatedly. */
  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    if (this.closed) return Promise.reject(new Error("A closed ChannelFeedCoordinator cannot be restarted"));
    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  /**
   * Marks trusted human activity in one exact room. Activity elsewhere never
   * changes this room's cadence. A newly active room may poll immediately when
   * the provider's minimum attempt gap has already elapsed.
   */
  noteHumanActivity(channelId: string, at = this.now()): void {
    if (!Number.isFinite(at)) return;
    const now = this.now();
    if (at < 0 || at > now + MAX_CLOCK_SKEW_MS) return;
    const observedAt = Math.min(Math.floor(at), now);
    this.lastHumanActivityAtByChannel.set(
      channelId,
      Math.max(this.lastHumanActivityAtByChannel.get(channelId) ?? 0, observedAt),
    );
    if (!this.started || this.closed) return;

    for (const runtime of this.feeds.values()) {
      if (runtime.adapter.channelId !== channelId || runtime.inFlight) continue;
      const earliestAllowed = runtime.lastAttemptAt === undefined
        ? now
        : runtime.lastAttemptAt + runtime.adapter.minAttemptGapMs;
      const acceleratedAt = Math.max(now, earliestAllowed);
      if (acceleratedAt >= runtime.nextPollAt) continue;
      runtime.nextPollAt = acceleratedAt;
      void this.store.reschedule(runtime.adapter.id, acceleratedAt)
        .catch((error) => this.reportError(runtime.adapter.id, error));
    }
    this.scheduleNext();
  }

  /** Latest successfully stored cards, in stable feed-id order. */
  cards(): TCard[] {
    return [...this.feeds.values()]
      .flatMap((runtime) => runtime.card ? [copyCard(runtime.card)] : [])
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  /** Stops timers, aborts current polls and waits for durable writes. */
  close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.closed = true;
    this.started = false;
    this.clearTimer();
    for (const runtime of this.feeds.values()) runtime.abort?.abort();
    await Promise.allSettled([
      ...(this.startPromise ? [this.startPromise] : []),
      ...(this.schedulerPromise ? [this.schedulerPromise] : []),
      ...[...this.feeds.values()].flatMap((runtime) => runtime.inFlight ? [runtime.inFlight] : []),
    ]);
    await this.store.flush();
  }

  private validateAdapter(adapter: ChannelFeedAdapter<TCard>): void {
    if (!validIdentifier(adapter.id) || !validIdentifier(adapter.channelId)) {
      throw new TypeError("Channel feed IDs must be bounded server-owned identifiers");
    }
    adapter.activeIntervalMs = boundedMilliseconds(
      adapter.activeIntervalMs,
      MINUTE_MS,
      MAX_INTERVAL_MS,
      `${adapter.id}.activeIntervalMs`,
    );
    adapter.idleIntervalMs = boundedMilliseconds(
      adapter.idleIntervalMs,
      adapter.activeIntervalMs,
      MAX_INTERVAL_MS,
      `${adapter.id}.idleIntervalMs`,
    );
    adapter.activityWindowMs = boundedMilliseconds(
      adapter.activityWindowMs,
      adapter.activeIntervalMs,
      MAX_INTERVAL_MS,
      `${adapter.id}.activityWindowMs`,
    );
    adapter.minAttemptGapMs = boundedMilliseconds(
      adapter.minAttemptGapMs,
      1_000,
      adapter.activeIntervalMs,
      `${adapter.id}.minAttemptGapMs`,
    );
    if (adapter.pollTimeoutMs !== undefined) {
      adapter.pollTimeoutMs = boundedMilliseconds(
        adapter.pollTimeoutMs,
        1_000,
        2 * MINUTE_MS,
        `${adapter.id}.pollTimeoutMs`,
      );
    }
  }

  private async startInternal(): Promise<void> {
    await this.store.load();
    if (this.closed) return;
    const now = this.now();
    for (const runtime of this.feeds.values()) {
      const persisted = this.store.schedule(runtime.adapter.id);
      const card = this.store.getCard(runtime.adapter.id);
      runtime.nextPollAt = persisted
        ? Math.min(
            persisted.nextPollAt,
            now + Math.max(runtime.adapter.idleIntervalMs, this.retryMaximumMs),
          )
        : now;
      runtime.failures = Math.max(0, Math.min(32, persisted?.failures ?? 0));
      runtime.lastAttemptAt = this.safePastTimestamp(persisted?.lastAttemptAt, now);
      runtime.lastSuccessAt = this.safePastTimestamp(persisted?.lastSuccessAt, now);
      if (card?.id === runtime.adapter.id && card.channelId === runtime.adapter.channelId) {
        try {
          const restored = runtime.adapter.restorePersistedCard?.(copyCard(card), now);
          if (restored) {
            this.assertAdapterCard(runtime, restored);
            runtime.card = copyCard(restored);
          }
        } catch (error) {
          this.reportError(runtime.adapter.id, error);
        }
        // A persisted domain observation is never assumed current merely
        // because its old schedule has not elapsed. Recheck it promptly while
        // still respecting the provider's minimum gap across restarts.
        const earliestAllowed = runtime.lastAttemptAt === undefined
          ? now
          : runtime.lastAttemptAt + runtime.adapter.minAttemptGapMs;
        runtime.nextPollAt = Math.min(runtime.nextPollAt, Math.max(now, earliestAllowed));
      }
    }
    this.started = true;
    this.scheduleNext();
  }

  private safePastTimestamp(value: number | undefined, now: number): number | undefined {
    return Number.isSafeInteger(value) && value! >= 0 && value! <= now + MAX_CLOCK_SKEW_MS
      ? Math.min(value!, now)
      : undefined;
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    this.timers.cancel(this.timer);
    this.timer = undefined;
  }

  private scheduleNext(): void {
    if (!this.started || this.closed || this.schedulerPromise) return;
    this.clearTimer();
    const next = [...this.feeds.values()]
      .filter((runtime) => !runtime.inFlight)
      .sort((left, right) =>
        left.nextPollAt - right.nextPollAt || left.adapter.id.localeCompare(right.adapter.id)
      )[0];
    if (!next) return;
    this.timer = this.timers.schedule(async () => {
      this.timer = undefined;
      if (!this.started || this.closed) return;
      const running = this.runDueFeeds();
      this.schedulerPromise = running;
      try {
        await running;
      } finally {
        if (this.schedulerPromise === running) this.schedulerPromise = undefined;
        this.scheduleNext();
      }
    }, Math.max(0, next.nextPollAt - this.now()));
  }

  /** Runs all currently overdue feeds sequentially, oldest first. */
  private async runDueFeeds(): Promise<void> {
    while (this.started && !this.closed) {
      const now = this.now();
      const runtime = [...this.feeds.values()]
        .filter((candidate) => !candidate.inFlight && candidate.nextPollAt <= now)
        .sort((left, right) =>
          left.nextPollAt - right.nextPollAt || left.adapter.id.localeCompare(right.adapter.id)
        )[0];
      if (!runtime) return;
      const operation = this.pollOne(runtime);
      runtime.inFlight = operation;
      try {
        await operation;
      } finally {
        if (runtime.inFlight === operation) runtime.inFlight = undefined;
      }
    }
  }

  private async pollOne(runtime: FeedRuntime<TCard>): Promise<void> {
    const attemptedAt = this.now();
    runtime.lastAttemptAt = attemptedAt;
    let failureAttempted = false;
    const controller = new AbortController();
    runtime.abort = controller;
    let timeout: unknown;
    let removeAbortListener: (() => void) | undefined;
    try {
      const adapterPoll = runtime.adapter.poll({
        now: attemptedAt,
        ...(runtime.card ? { previous: copyCard(runtime.card) } : {}),
        signal: controller.signal,
      });
      const aborted = new Promise<ChannelFeedPollResult<TCard>>((_, reject) => {
        const onAbort = () => reject(new Error(`Channel feed ${runtime.adapter.id} was aborted`));
        controller.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
      });
      const contenders: Array<Promise<ChannelFeedPollResult<TCard>>> = [adapterPoll, aborted];
      if (runtime.adapter.pollTimeoutMs !== undefined) {
        contenders.push(new Promise<ChannelFeedPollResult<TCard>>((_, reject) => {
          timeout = this.timers.schedule(() => {
            // Settle the timeout before abort listeners run so diagnostics
            // retain the more useful timeout reason.
            reject(new Error(`Channel feed ${runtime.adapter.id} timed out`));
            controller.abort();
          }, runtime.adapter.pollTimeoutMs!);
        }));
      }
      const result = await Promise.race(contenders);
      if (this.closed) return;
      if (result.kind === "unavailable") {
        if (result.card) this.assertAdapterCard(runtime, result.card);
        failureAttempted = true;
        await this.recordFailure(runtime, attemptedAt, result.card);
        return;
      }
      const timing: ChannelFeedPollTiming = {
        attemptedAt,
        nextPollAt: attemptedAt + this.cadenceFor(runtime, attemptedAt),
      };
      if (result.kind === "updated") {
        this.assertAdapterCard(runtime, result.card);
        const { revision: _storeOwnedRevision, ...draft } = copyCard(result.card);
        runtime.card = await this.store.publishSuccess(runtime.adapter.id, draft, timing);
        this.notifyCard(runtime.adapter.id, runtime.card);
      } else if (runtime.card) {
        await this.store.publishUnchanged(runtime.adapter.id, timing);
      } else {
        throw new TypeError(`Adapter ${runtime.adapter.id} returned unchanged before its first card`);
      }
      runtime.failures = 0;
      runtime.lastSuccessAt = attemptedAt;
      runtime.nextPollAt = timing.nextPollAt;
    } catch (error) {
      if (!this.closed) {
        if (!failureAttempted) {
          failureAttempted = true;
          try {
            await this.recordFailure(runtime, attemptedAt, undefined, this.now());
          } catch (persistenceError) {
            this.reportError(runtime.adapter.id, persistenceError);
          }
        }
        this.reportError(runtime.adapter.id, error);
      }
    } finally {
      if (timeout !== undefined) this.timers.cancel(timeout);
      removeAbortListener?.();
      if (runtime.abort === controller) runtime.abort = undefined;
    }
  }

  private assertAdapterCard(runtime: FeedRuntime<TCard>, card: TCard): void {
    if (card.id !== runtime.adapter.id || card.channelId !== runtime.adapter.channelId) {
      throw new TypeError(`Adapter ${runtime.adapter.id} returned a card for another feed or channel`);
    }
  }

  private cadenceFor(runtime: FeedRuntime<TCard>, now: number): number {
    const lastActivityAt = this.lastHumanActivityAtByChannel.get(runtime.adapter.channelId);
    return lastActivityAt !== undefined &&
      lastActivityAt <= now &&
      now - lastActivityAt <= runtime.adapter.activityWindowMs
      ? runtime.adapter.activeIntervalMs
      : runtime.adapter.idleIntervalMs;
  }

  private async recordFailure(
    runtime: FeedRuntime<TCard>,
    attemptedAt: number,
    unavailableCard?: TCard,
    detectedAt = this.now(),
  ): Promise<void> {
    const failures = Math.min(32, runtime.failures + 1);
    const exponent = Math.min(8, failures - 1);
    const retryDelay = Math.min(this.retryMaximumMs, this.retryBaseMs * 2 ** exponent);
    const timing: ChannelFeedPollTiming = {
      attemptedAt,
      nextPollAt: Math.max(attemptedAt, detectedAt) + Math.max(runtime.adapter.minAttemptGapMs, retryDelay),
    };
    // The process-local backoff is authoritative even when the durable write
    // fails. Otherwise a temporarily unavailable disk could create a hot loop.
    runtime.failures = failures;
    runtime.lastAttemptAt = attemptedAt;
    runtime.nextPollAt = timing.nextPollAt;
    const unavailableDraft = unavailableCard
      ? (({ revision: _storeOwnedRevision, ...draft }) => draft)(copyCard(unavailableCard))
      : undefined;
    const failed = await this.store.publishFailure(runtime.adapter.id, timing, unavailableDraft);
    runtime.failures = Math.max(0, Math.min(32, failed.schedule.failures));
    runtime.lastAttemptAt = failed.schedule.lastAttemptAt;
    runtime.lastSuccessAt = failed.schedule.lastSuccessAt;
    runtime.nextPollAt = failed.schedule.nextPollAt;
    if (failed.card) runtime.card = copyCard(failed.card);
    if (failed.cardChanged && runtime.card) this.notifyCard(runtime.adapter.id, runtime.card);
  }

  private notifyCard(feedId: string, card: TCard): void {
    if (!this.onCard) return;
    try {
      this.onCard(copyCard(card));
    } catch (error) {
      this.reportError(feedId, error);
    }
  }

  private reportError(feedId: string, error: unknown): void {
    if (this.onError) {
      try {
        this.onError(feedId, error);
        return;
      } catch (callbackError) {
        console.warn(
          `Channel feed ${feedId} error callback failed:`,
          callbackError instanceof Error ? callbackError.message : callbackError,
        );
      }
    }
    console.warn(`Channel feed ${feedId} failed:`, error instanceof Error ? error.message : error);
  }
}
