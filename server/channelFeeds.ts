import type {
  ChannelFeedPollTiming,
  ChannelFeedRuntimeConfiguration,
  ChannelFeedScheduleState,
  ChannelFeedStoredConfiguration,
} from "./channelFeedStore.js";
import type {
  AdminChannelFeedControl,
  AdminChannelFeedStatus,
} from "../shared/adminTypes.js";

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
  /** Server-owned presentation metadata used by the generic admin surface. */
  metadata: {
    kind: string;
    label: string;
    description: string;
    publisher: ChannelFeedAdminPublisher;
    defaultEnabled?: boolean;
    /** Default autonomous discussion intensity, independent of provider polling. */
    defaultDiscussionFrequency?: number;
  };
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
  configuration(feedId: string): ChannelFeedStoredConfiguration | undefined;
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
  configure(
    feedId: string,
    configuration: ChannelFeedRuntimeConfiguration,
    nextPollAt?: number,
    interruptedAttemptAt?: number,
  ): Promise<{ configuration: ChannelFeedRuntimeConfiguration; schedule?: ChannelFeedScheduleState }>;
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
  /** Full visible-card snapshot. Required for disable/remove transport events. */
  onCardsChanged?: (cards: TCard[]) => void;
  onError?: (feedId: string, error: unknown) => void;
}

export type ChannelFeedAdminStatus = AdminChannelFeedStatus;
export type ChannelFeedAdminPublisher = AdminChannelFeedControl["publisher"];
export type ChannelFeedAdminControl = AdminChannelFeedControl;

export interface ChannelFeedConfigureInput {
  enabled?: boolean;
  discussionFrequency?: number;
  activeIntervalMinutes?: number;
  idleIntervalMinutes?: number;
}

export type ChannelFeedConfigurationErrorCode =
  | "unknown_feed"
  | "invalid_configuration"
  | "not_started"
  | "closed";

export class ChannelFeedConfigurationError extends Error {
  constructor(
    readonly code: ChannelFeedConfigurationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChannelFeedConfigurationError";
  }
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
  configuration: ChannelFeedRuntimeConfiguration;
  epoch: number;
  configuring: boolean;
}

const MINUTE_MS = 60_000;
const DEFAULT_RETRY_BASE_MS = MINUTE_MS;
const DEFAULT_RETRY_MAXIMUM_MS = 30 * MINUTE_MS;
const MAX_INTERVAL_MS = 24 * 60 * MINUTE_MS;
const MAX_CLOCK_SKEW_MS = 5 * MINUTE_MS;
export const CHANNEL_FEED_MAX_INTERVAL_MINUTES = MAX_INTERVAL_MS / MINUTE_MS;

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

const boundedDisplayText = (value: string, maximum: number): boolean =>
  typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= maximum &&
  !/[\u0000-\u001f\u007f]/u.test(value);

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
  private readonly onCardsChanged?: (cards: TCard[]) => void;
  private readonly onError?: (feedId: string, error: unknown) => void;
  private readonly feeds = new Map<string, FeedRuntime<TCard>>();
  private readonly lastHumanActivityAtByChannel = new Map<string, number>();
  private timer?: unknown;
  private started = false;
  private closed = false;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private schedulerPromise?: Promise<void>;
  private configurationQueue: Promise<unknown> = Promise.resolve();

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
    this.onCardsChanged = options.onCardsChanged;
    this.onError = options.onError;

    for (const adapter of options.adapters) {
      this.validateAdapter(adapter);
      if (this.feeds.has(adapter.id)) throw new TypeError(`Duplicate channel feed adapter: ${adapter.id}`);
      this.feeds.set(adapter.id, {
        adapter,
        nextPollAt: 0,
        failures: 0,
        configuration: this.defaultConfiguration(adapter),
        epoch: 0,
        configuring: false,
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
   * changes this room's cadence. A newly active room may move from its quiet
   * schedule to the configured active schedule, but never beyond it or an
   * existing provider retry backoff.
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
      if (!runtime.configuration.enabled || runtime.configuring ||
          runtime.adapter.channelId !== channelId || runtime.inFlight) continue;
      // Activity may switch a room from its quiet cadence to its configured
      // active cadence, but it is not a retry signal. Preserve an existing
      // provider backoff and never let repeated focus/typing events turn the
      // adapter's lower-level safety gap into the effective polling cadence.
      if (runtime.failures > 0) continue;
      const activeIntervalMs = Math.max(
        runtime.configuration.activeIntervalMs,
        runtime.adapter.minAttemptGapMs,
      );
      const activeDueAt = runtime.lastAttemptAt === undefined
        ? now
        : runtime.lastAttemptAt + activeIntervalMs;
      const acceleratedAt = Math.max(now, activeDueAt);
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
      .flatMap((runtime) => runtime.configuration.enabled &&
          !runtime.configuration.freshPollRequired && runtime.card
        ? [copyCard(runtime.card)]
        : [])
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  /** Stable server-owned integration catalog plus current durable controls. */
  controls(): ChannelFeedAdminControl[] {
    return [...this.feeds.values()]
      .sort((left, right) =>
        left.adapter.channelId.localeCompare(right.adapter.channelId) ||
        left.adapter.id.localeCompare(right.adapter.id)
      )
      .map((runtime) => this.controlFor(runtime));
  }

  /**
   * Applies a partial operator override without replacing the adapter. The
   * call is serialized and persisted before its new settings become visible.
   */
  configure(
    feedId: string,
    input: ChannelFeedConfigureInput,
  ): Promise<ChannelFeedAdminControl> {
    const operation = this.configurationQueue.then(() => this.configureInternal(feedId, input));
    this.configurationQueue = operation.catch(() => undefined);
    return operation;
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
      this.configurationQueue,
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
    const metadata = adapter.metadata;
    if (!metadata ||
        !/^[a-z][a-z0-9_]{1,63}$/u.test(metadata.kind) ||
        !boundedDisplayText(metadata.label, 80) ||
        !boundedDisplayText(metadata.description, 240) ||
        !validIdentifier(metadata.publisher?.id ?? "") ||
        !boundedDisplayText(metadata.publisher?.name ?? "", 80) ||
        metadata.publisher?.badge !== "BOT" ||
        (metadata.defaultEnabled !== undefined && typeof metadata.defaultEnabled !== "boolean") ||
        (metadata.defaultDiscussionFrequency !== undefined &&
          (!Number.isSafeInteger(metadata.defaultDiscussionFrequency) ||
            metadata.defaultDiscussionFrequency < 0 || metadata.defaultDiscussionFrequency > 100))) {
      throw new TypeError(`Invalid admin metadata for channel feed ${adapter.id}`);
    }
  }

  private defaultConfiguration(
    adapter: ChannelFeedAdapter<TCard>,
  ): ChannelFeedRuntimeConfiguration {
    const enabled = adapter.metadata.defaultEnabled ?? true;
    return {
      feedId: adapter.id,
      enabled,
      discussionFrequency: adapter.metadata.defaultDiscussionFrequency ?? 0,
      activeIntervalMs: adapter.activeIntervalMs,
      idleIntervalMs: adapter.idleIntervalMs,
      freshPollRequired: !enabled,
    };
  }

  private normalizedPersistedConfiguration(
    runtime: FeedRuntime<TCard>,
    persisted: ChannelFeedStoredConfiguration | undefined,
  ): ChannelFeedRuntimeConfiguration {
    if (!persisted) return this.defaultConfiguration(runtime.adapter);
    const defaults = this.defaultConfiguration(runtime.adapter);
    const minimum = this.minimumIntervalMs(runtime);
    const activeIntervalMs = Math.max(minimum, Math.min(MAX_INTERVAL_MS, persisted.activeIntervalMs));
    return {
      feedId: runtime.adapter.id,
      enabled: persisted.enabled,
      discussionFrequency: Math.max(
        0,
        Math.min(100, persisted.discussionFrequency ?? defaults.discussionFrequency),
      ),
      activeIntervalMs,
      idleIntervalMs: Math.max(activeIntervalMs, Math.min(MAX_INTERVAL_MS, persisted.idleIntervalMs)),
      freshPollRequired: persisted.enabled ? persisted.freshPollRequired : true,
    };
  }

  private minimumIntervalMs(runtime: FeedRuntime<TCard>): number {
    return Math.max(MINUTE_MS, Math.ceil(runtime.adapter.minAttemptGapMs / MINUTE_MS) * MINUTE_MS);
  }

  private controlFor(runtime: FeedRuntime<TCard>): ChannelFeedAdminControl {
    const cardAvailable = runtime.configuration.enabled &&
      !runtime.configuration.freshPollRequired && Boolean(runtime.card);
    const state = runtime.card && "state" in runtime.card
      ? (runtime.card as TCard & { state?: unknown }).state
      : undefined;
    const status: ChannelFeedAdminStatus = !runtime.configuration.enabled
      ? "disabled"
      : runtime.inFlight
        ? "polling"
        : !cardAvailable
          ? "waiting"
          : state === "unavailable"
            ? "unavailable"
            : "ready";
    const defaults = this.defaultConfiguration(runtime.adapter);
    return {
      id: runtime.adapter.id,
      channelId: runtime.adapter.channelId,
      kind: runtime.adapter.metadata.kind,
      label: runtime.adapter.metadata.label,
      description: runtime.adapter.metadata.description,
      publisher: { ...runtime.adapter.metadata.publisher },
      available: true,
      enabled: runtime.configuration.enabled,
      discussionFrequency: runtime.configuration.discussionFrequency,
      activeIntervalMinutes: runtime.configuration.activeIntervalMs / MINUTE_MS,
      idleIntervalMinutes: runtime.configuration.idleIntervalMs / MINUTE_MS,
      defaultEnabled: defaults.enabled,
      defaultDiscussionFrequency: defaults.discussionFrequency,
      defaultActiveIntervalMinutes: defaults.activeIntervalMs / MINUTE_MS,
      defaultIdleIntervalMinutes: defaults.idleIntervalMs / MINUTE_MS,
      minimumIntervalMinutes: this.minimumIntervalMs(runtime) / MINUTE_MS,
      maximumIntervalMinutes: CHANNEL_FEED_MAX_INTERVAL_MINUTES,
      status,
      cardAvailable,
      failures: runtime.failures,
      ...(runtime.lastAttemptAt !== undefined ? { lastAttemptAt: runtime.lastAttemptAt } : {}),
      ...(runtime.lastSuccessAt !== undefined ? { lastSuccessAt: runtime.lastSuccessAt } : {}),
      ...(runtime.configuration.enabled && this.started
        ? { nextPollAt: runtime.nextPollAt }
        : {}),
    };
  }

  private parseConfigurationInput(
    runtime: FeedRuntime<TCard>,
    input: ChannelFeedConfigureInput,
  ): ChannelFeedRuntimeConfiguration {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some((key) =>
          !["enabled", "discussionFrequency", "activeIntervalMinutes", "idleIntervalMinutes"].includes(key)
        )) {
      throw new ChannelFeedConfigurationError("invalid_configuration", "Invalid channel feed configuration payload.");
    }
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      throw new ChannelFeedConfigurationError("invalid_configuration", "enabled must be a boolean.");
    }
    if (input.discussionFrequency !== undefined &&
        (!Number.isSafeInteger(input.discussionFrequency) ||
          input.discussionFrequency < 0 || input.discussionFrequency > 100)) {
      throw new ChannelFeedConfigurationError(
        "invalid_configuration",
        "discussionFrequency must be an integer from 0 to 100.",
      );
    }
    const minimumMinutes = this.minimumIntervalMs(runtime) / MINUTE_MS;
    const validateMinutes = (value: number | undefined, label: string): void => {
      if (value !== undefined && (!Number.isSafeInteger(value) ||
          value < minimumMinutes || value > CHANNEL_FEED_MAX_INTERVAL_MINUTES)) {
        throw new ChannelFeedConfigurationError(
          "invalid_configuration",
          `${label} must be an integer from ${minimumMinutes} to ${CHANNEL_FEED_MAX_INTERVAL_MINUTES}.`,
        );
      }
    };
    validateMinutes(input.activeIntervalMinutes, "activeIntervalMinutes");
    validateMinutes(input.idleIntervalMinutes, "idleIntervalMinutes");
    const enabled = input.enabled ?? runtime.configuration.enabled;
    const activeIntervalMs = (input.activeIntervalMinutes ??
      runtime.configuration.activeIntervalMs / MINUTE_MS) * MINUTE_MS;
    const idleIntervalMs = (input.idleIntervalMinutes ??
      runtime.configuration.idleIntervalMs / MINUTE_MS) * MINUTE_MS;
    if (idleIntervalMs < activeIntervalMs) {
      throw new ChannelFeedConfigurationError(
        "invalid_configuration",
        "idleIntervalMinutes must be greater than or equal to activeIntervalMinutes.",
      );
    }
    const newlyEnabled = enabled && !runtime.configuration.enabled;
    return {
      feedId: runtime.adapter.id,
      enabled,
      discussionFrequency: input.discussionFrequency ?? runtime.configuration.discussionFrequency,
      activeIntervalMs,
      idleIntervalMs,
      freshPollRequired: !enabled || newlyEnabled || runtime.configuration.freshPollRequired,
    };
  }

  private async configureInternal(
    feedId: string,
    input: ChannelFeedConfigureInput,
  ): Promise<ChannelFeedAdminControl> {
    const runtime = this.feeds.get(feedId);
    if (!runtime) {
      throw new ChannelFeedConfigurationError("unknown_feed", `Unknown channel feed: ${feedId}`);
    }
    if (this.closed) {
      throw new ChannelFeedConfigurationError("closed", "Channel feeds are shutting down.");
    }
    if (!this.started) {
      throw new ChannelFeedConfigurationError("not_started", "Channel feeds have not started.");
    }
    const nextConfiguration = this.parseConfigurationInput(runtime, input);
    if (
      nextConfiguration.feedId === runtime.configuration.feedId
      && nextConfiguration.enabled === runtime.configuration.enabled
      && nextConfiguration.discussionFrequency === runtime.configuration.discussionFrequency
      && nextConfiguration.activeIntervalMs === runtime.configuration.activeIntervalMs
      && nextConfiguration.idleIntervalMs === runtime.configuration.idleIntervalMs
      && nextConfiguration.freshPollRequired === runtime.configuration.freshPollRequired
    ) {
      return this.controlFor(runtime);
    }

    const discussionOnly =
      nextConfiguration.enabled === runtime.configuration.enabled
      && nextConfiguration.discussionFrequency !== runtime.configuration.discussionFrequency
      && nextConfiguration.activeIntervalMs === runtime.configuration.activeIntervalMs
      && nextConfiguration.idleIntervalMs === runtime.configuration.idleIntervalMs
      && nextConfiguration.freshPollRequired === runtime.configuration.freshPollRequired;
    if (discussionOnly) {
      // Discussion admission is independent from provider scheduling. Let an
      // already-started poll finish so its durable schedule and fresh-poll
      // transition stay authoritative, then patch only the newly requested
      // discussion value without supplying or rewriting a due time.
      const activePoll = runtime.inFlight;
      if (activePoll) await activePoll;
      if (this.closed) {
        throw new ChannelFeedConfigurationError("closed", "Channel feeds are shutting down.");
      }
      const refreshedConfiguration = this.parseConfigurationInput(runtime, {
        discussionFrequency: input.discussionFrequency,
      });
      const persisted = await this.store.configure(runtime.adapter.id, refreshedConfiguration);
      runtime.configuration = { ...persisted.configuration };
      if (persisted.schedule) {
        runtime.nextPollAt = persisted.schedule.nextPollAt;
        runtime.failures = Math.max(0, Math.min(32, persisted.schedule.failures));
        runtime.lastAttemptAt = persisted.schedule.lastAttemptAt;
        runtime.lastSuccessAt = persisted.schedule.lastSuccessAt;
      }
      return this.controlFor(runtime);
    }

    const previousEpoch = runtime.epoch;
    const previousNextPollAt = runtime.nextPollAt;
    const interruptedAttemptAt = runtime.inFlight ? runtime.lastAttemptAt : undefined;
    const runtimeCardRevisionBefore = runtime.card?.revision ?? 0;
    const durableCardBefore = interruptedAttemptAt !== undefined
      ? this.store.getCard(runtime.adapter.id)
      : undefined;
    runtime.configuring = true;
    runtime.epoch += 1;
    runtime.abort?.abort();
    this.clearTimer();
    const now = this.now();
    const newlyEnabled = nextConfiguration.enabled && !runtime.configuration.enabled;
    const cadenceChanged = nextConfiguration.activeIntervalMs !== runtime.configuration.activeIntervalMs ||
      nextConfiguration.idleIntervalMs !== runtime.configuration.idleIntervalMs;
    let nextPollAt: number | undefined;
    if (nextConfiguration.enabled) {
      if (newlyEnabled || nextConfiguration.freshPollRequired) {
        nextPollAt = Math.max(
          now,
          runtime.lastAttemptAt === undefined
            ? now
            : runtime.lastAttemptAt + runtime.adapter.minAttemptGapMs,
        );
      } else if (cadenceChanged) {
        nextPollAt = runtime.lastAttemptAt === undefined
          ? now
          : Math.max(
              now,
              runtime.lastAttemptAt + this.cadenceFor(runtime, now, nextConfiguration),
            );
      } else {
        nextPollAt = runtime.nextPollAt;
      }
    } else if (interruptedAttemptAt !== undefined) {
      nextPollAt = interruptedAttemptAt + runtime.adapter.minAttemptGapMs;
    }

    try {
      const persisted = await this.store.configure(
        runtime.adapter.id,
        nextConfiguration,
        nextPollAt,
        interruptedAttemptAt,
      );
      runtime.configuration = { ...persisted.configuration };
      if (persisted.schedule) {
        runtime.nextPollAt = persisted.schedule.nextPollAt;
        runtime.failures = Math.max(0, Math.min(32, persisted.schedule.failures));
        runtime.lastAttemptAt = persisted.schedule.lastAttemptAt;
        runtime.lastSuccessAt = persisted.schedule.lastSuccessAt;
      }
      if (interruptedAttemptAt !== undefined) {
        const durableCardAfter = this.store.getCard(runtime.adapter.id);
        const durableAdvancedDuringConfiguration = durableCardAfter &&
          durableCardAfter.revision > (durableCardBefore?.revision ?? 0);
        const runtimeWasBehindCommittedCard = durableCardBefore &&
          durableCardBefore.revision > runtimeCardRevisionBefore;
        if (durableCardAfter && (durableAdvancedDuringConfiguration || runtimeWasBehindCommittedCard)) {
          this.assertAdapterCard(runtime, durableCardAfter);
          runtime.card = copyCard(durableCardAfter);
        }
      }
      runtime.configuring = false;
      this.notifyCardsChanged(runtime.adapter.id);
      this.scheduleNext();
      return this.controlFor(runtime);
    } catch (error) {
      // The durable write is authoritative. A failed override gets a new
      // generation so the aborted pre-change poll cannot publish afterwards.
      runtime.epoch = Math.max(runtime.epoch + 1, previousEpoch + 2);
      runtime.nextPollAt = interruptedAttemptAt === undefined
        ? previousNextPollAt
        : Math.max(previousNextPollAt, interruptedAttemptAt + runtime.adapter.minAttemptGapMs);
      const durableCardAfter = interruptedAttemptAt === undefined
        ? undefined
        : this.store.getCard(runtime.adapter.id);
      if (durableCardAfter && durableCardAfter.revision > runtimeCardRevisionBefore) {
        this.assertAdapterCard(runtime, durableCardAfter);
        runtime.card = copyCard(durableCardAfter);
      }
      runtime.configuring = false;
      if (durableCardAfter) this.notifyCardsChanged(runtime.adapter.id);
      this.scheduleNext();
      throw error;
    }
  }

  private async startInternal(): Promise<void> {
    await this.store.load();
    if (this.closed) return;
    const now = this.now();
    for (const runtime of this.feeds.values()) {
      const persisted = this.store.schedule(runtime.adapter.id);
      const card = this.store.getCard(runtime.adapter.id);
      const persistedConfiguration = this.store.configuration(runtime.adapter.id);
      runtime.configuration = this.normalizedPersistedConfiguration(
        runtime,
        persistedConfiguration,
      );
      // Version-two state predates autonomous discussion controls. Its
      // missing value is deliberately resolved through the adapter default,
      // then durably upgraded before any provider work can begin.
      if (persistedConfiguration && persistedConfiguration.discussionFrequency === undefined) {
        const migrated = await this.store.configure(runtime.adapter.id, runtime.configuration);
        runtime.configuration = { ...migrated.configuration };
      }
      runtime.nextPollAt = persisted
        ? Math.min(
            persisted.nextPollAt,
            now + Math.max(runtime.configuration.idleIntervalMs, this.retryMaximumMs),
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
        if (runtime.configuration.enabled) {
          // A persisted domain observation is never assumed current merely
          // because its old schedule has not elapsed. Recheck it promptly while
          // still respecting the provider's minimum gap across restarts.
          const earliestAllowed = runtime.lastAttemptAt === undefined
            ? now
            : runtime.lastAttemptAt + runtime.adapter.minAttemptGapMs;
          runtime.nextPollAt = Math.min(runtime.nextPollAt, Math.max(now, earliestAllowed));
        }
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
      .filter((runtime) => runtime.configuration.enabled && !runtime.configuring && !runtime.inFlight)
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
        .filter((candidate) =>
          candidate.configuration.enabled && !candidate.configuring &&
          !candidate.inFlight && candidate.nextPollAt <= now
        )
        .sort((left, right) =>
          left.nextPollAt - right.nextPollAt || left.adapter.id.localeCompare(right.adapter.id)
        )[0];
      if (!runtime) return;
      const operation = this.pollOne(runtime, runtime.epoch);
      runtime.inFlight = operation;
      try {
        await operation;
      } finally {
        if (runtime.inFlight === operation) runtime.inFlight = undefined;
      }
    }
  }

  private async pollOne(runtime: FeedRuntime<TCard>, epoch: number): Promise<void> {
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
      if (!this.pollIsCurrent(runtime, epoch)) return;
      if (result.kind === "unavailable") {
        if (result.card) this.assertAdapterCard(runtime, result.card);
        failureAttempted = true;
        await this.recordFailure(runtime, epoch, attemptedAt, result.card);
        return;
      }
      const timing: ChannelFeedPollTiming = {
        attemptedAt,
        nextPollAt: attemptedAt + this.cadenceFor(runtime, attemptedAt),
      };
      if (result.kind === "updated") {
        this.assertAdapterCard(runtime, result.card);
        const { revision: _storeOwnedRevision, ...draft } = copyCard(result.card);
        const published = await this.store.publishSuccess(runtime.adapter.id, draft, timing);
        if (!this.pollIsCurrent(runtime, epoch)) return;
        runtime.card = published;
        runtime.configuration = { ...runtime.configuration, freshPollRequired: false };
        this.notifyCard(runtime.adapter.id, runtime.card);
      } else if (runtime.card) {
        await this.store.publishUnchanged(runtime.adapter.id, timing);
        if (!this.pollIsCurrent(runtime, epoch)) return;
        const wasHidden = runtime.configuration.freshPollRequired;
        runtime.configuration = { ...runtime.configuration, freshPollRequired: false };
        if (wasHidden) this.notifyCardsChanged(runtime.adapter.id);
      } else {
        throw new TypeError(`Adapter ${runtime.adapter.id} returned unchanged before its first card`);
      }
      runtime.failures = 0;
      runtime.lastSuccessAt = attemptedAt;
      runtime.nextPollAt = timing.nextPollAt;
    } catch (error) {
      if (this.pollIsCurrent(runtime, epoch)) {
        if (!failureAttempted) {
          failureAttempted = true;
          try {
            await this.recordFailure(runtime, epoch, attemptedAt, undefined, this.now());
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

  private pollIsCurrent(runtime: FeedRuntime<TCard>, epoch: number): boolean {
    return !this.closed && runtime.configuration.enabled && runtime.epoch === epoch;
  }

  private cadenceFor(
    runtime: FeedRuntime<TCard>,
    now: number,
    configuration = runtime.configuration,
  ): number {
    const lastActivityAt = this.lastHumanActivityAtByChannel.get(runtime.adapter.channelId);
    return lastActivityAt !== undefined &&
      lastActivityAt <= now &&
      now - lastActivityAt <= runtime.adapter.activityWindowMs
      ? configuration.activeIntervalMs
      : configuration.idleIntervalMs;
  }

  private async recordFailure(
    runtime: FeedRuntime<TCard>,
    epoch: number,
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
    if (!this.pollIsCurrent(runtime, epoch)) return;
    const wasHidden = runtime.configuration.freshPollRequired;
    runtime.failures = Math.max(0, Math.min(32, failed.schedule.failures));
    runtime.lastAttemptAt = failed.schedule.lastAttemptAt;
    runtime.lastSuccessAt = failed.schedule.lastSuccessAt;
    runtime.nextPollAt = failed.schedule.nextPollAt;
    if (failed.card && (!wasHidden || unavailableCard)) runtime.card = copyCard(failed.card);
    if (unavailableCard) {
      runtime.configuration = { ...runtime.configuration, freshPollRequired: false };
    }
    if (failed.cardChanged && runtime.card && (!wasHidden || unavailableCard)) {
      this.notifyCard(runtime.adapter.id, runtime.card);
    } else if (wasHidden && unavailableCard && runtime.card) {
      this.notifyCardsChanged(runtime.adapter.id);
    }
  }

  private notifyCard(feedId: string, card: TCard): void {
    if (this.onCard) {
      try {
        this.onCard(copyCard(card));
      } catch (error) {
        this.reportError(feedId, error);
      }
    }
    this.notifyCardsChanged(feedId);
  }

  private notifyCardsChanged(feedId: string): void {
    if (!this.onCardsChanged) return;
    try {
      this.onCardsChanged(this.cards());
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
