import { describe, expect, it, vi } from "vitest";
import {
  ChannelFeedConfigurationError,
  ChannelFeedCoordinator,
  type ChannelFeedAdapter,
  type ChannelFeedCardDraftFor,
  type ChannelFeedPollContext,
  type ChannelFeedPollResult,
  type ChannelFeedStorePort,
  type ChannelFeedTimerRuntime,
  type SchedulableChannelFeedCard,
} from "./channelFeeds.js";
import type {
  ChannelFeedPollTiming,
  ChannelFeedRuntimeConfiguration,
  ChannelFeedScheduleState,
} from "./channelFeedStore.js";

const MINUTE_MS = 60_000;

type TestCard = {
  id: string;
  channelId: string;
  revision: number;
  updatedAt: string;
  kind: "market" | "football";
  value: string;
  state?: "ready" | "unavailable";
};

class ManualTimers implements ChannelFeedTimerRuntime {
  now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, {
    dueAt: number;
    callback: () => void | Promise<void>;
  }>();

  schedule(callback: () => void | Promise<void>, delayMs: number): unknown {
    const id = this.nextId++;
    this.tasks.set(id, { dueAt: this.now + Math.max(0, delayMs), callback });
    return id;
  }

  cancel(handle: unknown): void {
    if (typeof handle === "number") this.tasks.delete(handle);
  }

  nextDueAt(): number | undefined {
    return [...this.tasks.values()].sort((left, right) => left.dueAt - right.dueAt)[0]?.dueAt;
  }

  jumpTo(at: number): void {
    if (at < this.now) throw new TypeError("Manual time cannot go backwards");
    this.now = at;
  }

  async runNext(): Promise<boolean> {
    const next = [...this.tasks.entries()].sort((left, right) =>
      left[1].dueAt - right[1].dueAt || left[0] - right[0]
    )[0];
    if (!next) return false;
    this.tasks.delete(next[0]);
    this.now = Math.max(this.now, next[1].dueAt);
    await next[1].callback();
    return true;
  }

  async advanceTo(at: number): Promise<void> {
    if (at < this.now) throw new TypeError("Manual time cannot go backwards");
    while ((this.nextDueAt() ?? Infinity) <= at) await this.runNext();
    this.now = at;
  }
}

class TestStore<TCard extends SchedulableChannelFeedCard> implements ChannelFeedStorePort<TCard> {
  readonly cardById = new Map<string, TCard>();
  readonly scheduleById = new Map<string, ChannelFeedScheduleState>();
  readonly configurationById = new Map<string, ChannelFeedRuntimeConfiguration>();
  loadCalls = 0;
  flushCalls = 0;

  async load(): Promise<void> {
    this.loadCalls += 1;
  }

  cards(): TCard[] {
    return structuredClone([...this.cardById.values()]);
  }

  getCard(feedId: string): TCard | undefined {
    const card = this.cardById.get(feedId);
    return card ? structuredClone(card) : undefined;
  }

  schedule(feedId: string): ChannelFeedScheduleState | undefined {
    const schedule = this.scheduleById.get(feedId);
    return schedule ? { ...schedule } : undefined;
  }

  configuration(feedId: string): ChannelFeedRuntimeConfiguration | undefined {
    const configuration = this.configurationById.get(feedId);
    return configuration ? { ...configuration } : undefined;
  }

  async publishSuccess(
    feedId: string,
    draft: ChannelFeedCardDraftFor<TCard>,
    timing: ChannelFeedPollTiming,
  ): Promise<TCard> {
    const revision = (this.cardById.get(feedId)?.revision ?? 0) + 1;
    const card = { ...structuredClone(draft), revision } as TCard;
    this.cardById.set(feedId, card);
    this.scheduleById.set(feedId, {
      feedId,
      lastAttemptAt: timing.attemptedAt,
      lastSuccessAt: timing.attemptedAt,
      nextPollAt: timing.nextPollAt,
      failures: 0,
    });
    const configuration = this.configurationById.get(feedId);
    if (configuration?.enabled && configuration.freshPollRequired) {
      this.configurationById.set(feedId, { ...configuration, freshPollRequired: false });
    }
    return structuredClone(card);
  }

  async publishFailure(
    feedId: string,
    timing: ChannelFeedPollTiming,
    unavailableDraft?: ChannelFeedCardDraftFor<TCard>,
  ): Promise<{ card?: TCard; cardChanged: boolean; schedule: ChannelFeedScheduleState }> {
    const previous = this.cardById.get(feedId);
    let card = previous;
    let cardChanged = false;
    if (unavailableDraft) {
      card = {
        ...structuredClone(unavailableDraft),
        revision: (previous?.revision ?? 0) + 1,
      } as TCard;
      this.cardById.set(feedId, card);
      cardChanged = true;
    }
    const priorSchedule = this.scheduleById.get(feedId);
    const schedule: ChannelFeedScheduleState = {
      feedId,
      lastAttemptAt: timing.attemptedAt,
      ...(priorSchedule?.lastSuccessAt !== undefined
        ? { lastSuccessAt: priorSchedule.lastSuccessAt }
        : {}),
      nextPollAt: timing.nextPollAt,
      failures: (priorSchedule?.failures ?? 0) + 1,
    };
    this.scheduleById.set(feedId, schedule);
    const configuration = this.configurationById.get(feedId);
    if (unavailableDraft && configuration?.enabled && configuration.freshPollRequired) {
      this.configurationById.set(feedId, { ...configuration, freshPollRequired: false });
    }
    return {
      ...(card ? { card: structuredClone(card) } : {}),
      cardChanged,
      schedule: { ...schedule },
    };
  }

  async publishUnchanged(
    feedId: string,
    timing: ChannelFeedPollTiming,
  ): Promise<ChannelFeedScheduleState> {
    if (!this.cardById.has(feedId)) throw new TypeError("missing card");
    const schedule: ChannelFeedScheduleState = {
      feedId,
      lastAttemptAt: timing.attemptedAt,
      lastSuccessAt: timing.attemptedAt,
      nextPollAt: timing.nextPollAt,
      failures: 0,
    };
    this.scheduleById.set(feedId, schedule);
    const configuration = this.configurationById.get(feedId);
    if (configuration?.enabled && configuration.freshPollRequired) {
      this.configurationById.set(feedId, { ...configuration, freshPollRequired: false });
    }
    return { ...schedule };
  }

  async reschedule(feedId: string, nextPollAt: number): Promise<ChannelFeedScheduleState> {
    const previous = this.scheduleById.get(feedId);
    const schedule = previous
      ? { ...previous, nextPollAt: Math.min(previous.nextPollAt, nextPollAt) }
      : { feedId, nextPollAt, failures: 0 };
    this.scheduleById.set(feedId, schedule);
    return { ...schedule };
  }

  async configure(
    feedId: string,
    configuration: ChannelFeedRuntimeConfiguration,
    nextPollAt?: number,
    interruptedAttemptAt?: number,
  ): Promise<{ configuration: ChannelFeedRuntimeConfiguration; schedule?: ChannelFeedScheduleState }> {
    this.configurationById.set(feedId, { ...configuration });
    const previous = this.scheduleById.get(feedId);
    const schedule = nextPollAt === undefined
      ? previous
      : previous
        ? {
            ...previous,
            ...(interruptedAttemptAt !== undefined ? { lastAttemptAt: interruptedAttemptAt } : {}),
            nextPollAt,
          }
        : {
            feedId,
            ...(interruptedAttemptAt !== undefined ? { lastAttemptAt: interruptedAttemptAt } : {}),
            nextPollAt,
            failures: 0,
          };
    if (schedule) this.scheduleById.set(feedId, schedule);
    return {
      configuration: { ...configuration },
      ...(schedule ? { schedule: { ...schedule } } : {}),
    };
  }

  async flush(): Promise<void> {
    this.flushCalls += 1;
  }
}

class QueuedPublishTestStore extends TestStore<TestCard> {
  private queue: Promise<unknown> = Promise.resolve();
  private releasePublish!: () => void;
  readonly publishEntered: Promise<void>;
  private readonly publishEnteredResolve: () => void;

  constructor() {
    super();
    let entered!: () => void;
    this.publishEntered = new Promise<void>((resolve) => { entered = resolve; });
    this.publishEnteredResolve = entered;
  }

  release(): void {
    this.releasePublish();
  }

  override publishSuccess(
    feedId: string,
    draft: ChannelFeedCardDraftFor<TestCard>,
    timing: ChannelFeedPollTiming,
  ): Promise<TestCard> {
    const operation = this.queue.then(async () => {
      this.publishEnteredResolve();
      await new Promise<void>((resolve) => { this.releasePublish = resolve; });
      return super.publishSuccess(feedId, draft, timing);
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  override configure(
    feedId: string,
    configuration: ChannelFeedRuntimeConfiguration,
    nextPollAt?: number,
    interruptedAttemptAt?: number,
  ): Promise<{ configuration: ChannelFeedRuntimeConfiguration; schedule?: ChannelFeedScheduleState }> {
    const operation = this.queue.then(() =>
      super.configure(feedId, configuration, nextPollAt, interruptedAttemptAt)
    );
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}

const card = (
  id: string,
  channelId: string,
  kind: TestCard["kind"],
  now: number,
  value = `${kind}-${now}`,
): TestCard => ({
  id,
  channelId,
  revision: 0,
  updatedAt: new Date(now).toISOString(),
  kind,
  value,
  state: "ready",
});

const adapter = (input: {
  id: string;
  channelId: string;
  kind?: TestCard["kind"];
  activeIntervalMs?: number;
  idleIntervalMs?: number;
  activityWindowMs?: number;
  minAttemptGapMs?: number;
  restorePersistedCard?: (card: TestCard, now: number) => TestCard | undefined;
  poll?: (context: ChannelFeedPollContext<TestCard>) => Promise<ChannelFeedPollResult<TestCard>>;
}): ChannelFeedAdapter<TestCard> => ({
  id: input.id,
  channelId: input.channelId,
  metadata: {
    kind: input.kind ?? "market",
    label: input.kind === "football" ? "FixtureWire" : "MarketWire",
    description: `Test integration for ${input.channelId}.`,
    publisher: {
      id: input.id,
      name: input.kind === "football" ? "FixtureWire" : "MarketWire",
      badge: "BOT",
    },
  },
  activeIntervalMs: input.activeIntervalMs ?? 5 * MINUTE_MS,
  idleIntervalMs: input.idleIntervalMs ?? 30 * MINUTE_MS,
  activityWindowMs: input.activityWindowMs ?? 15 * MINUTE_MS,
  minAttemptGapMs: input.minAttemptGapMs ?? MINUTE_MS,
  pollTimeoutMs: 10 * MINUTE_MS,
  ...(input.restorePersistedCard ? { restorePersistedCard: input.restorePersistedCard } : {}),
  poll: input.poll ?? (async ({ now }) => ({
    kind: "updated",
    card: card(input.id, input.channelId, input.kind ?? "market", now),
  })),
});

const coordinator = (
  timers: ManualTimers,
  adapters: readonly ChannelFeedAdapter<TestCard>[],
  store = new TestStore<TestCard>(),
  options: {
    retryBaseMs?: number;
    retryMaximumMs?: number;
    onCard?: (card: TestCard) => void;
    onCardsChanged?: (cards: TestCard[]) => void;
    onError?: (id: string, error: unknown) => void;
  } = {},
) => ({
  store,
  coordinator: new ChannelFeedCoordinator<TestCard>({
    adapters,
    store,
    now: () => timers.now,
    timers,
    ...options,
  }),
});

describe("ChannelFeedCoordinator", () => {
  it("uses a 30-minute idle cadence and a five-minute active cadence", async () => {
    const idleTimers = new ManualTimers();
    const idlePoll = vi.fn(async ({ now }: ChannelFeedPollContext<TestCard>) => ({
      kind: "updated" as const,
      card: card("market-wire", "stock-market", "market", now),
    }));
    const idle = coordinator(idleTimers, [adapter({
      id: "market-wire",
      channelId: "stock-market",
      poll: idlePoll,
    })]);
    await idle.coordinator.start();
    await idleTimers.runNext();
    expect(idlePoll).toHaveBeenCalledTimes(1);
    expect(idleTimers.nextDueAt()).toBe(30 * MINUTE_MS);
    await idleTimers.advanceTo(30 * MINUTE_MS);
    expect(idlePoll).toHaveBeenCalledTimes(2);
    await idle.coordinator.close();

    const activeTimers = new ManualTimers();
    const activePoll = vi.fn(async ({ now }: ChannelFeedPollContext<TestCard>) => ({
      kind: "updated" as const,
      card: card("market-wire", "stock-market", "market", now),
    }));
    const active = coordinator(activeTimers, [adapter({
      id: "market-wire",
      channelId: "stock-market",
      poll: activePoll,
    })]);
    active.coordinator.noteHumanActivity("stock-market", 0);
    await active.coordinator.start();
    await activeTimers.runNext();
    expect(activeTimers.nextDueAt()).toBe(5 * MINUTE_MS);
    await activeTimers.advanceTo(5 * MINUTE_MS);
    expect(activePoll).toHaveBeenCalledTimes(2);
    await active.coordinator.close();
  });

  it("accelerates an idle feed on arrival without bypassing its configured active cadence", async () => {
    const timers = new ManualTimers();
    const poll = vi.fn(async ({ now }: ChannelFeedPollContext<TestCard>) => ({
      kind: "updated" as const,
      card: card("market-wire", "stock-market", "market", now),
    }));
    const runtime = coordinator(timers, [adapter({
      id: "market-wire",
      channelId: "stock-market",
      minAttemptGapMs: 2 * MINUTE_MS,
      poll,
    })]);
    await runtime.coordinator.start();
    await timers.runNext();
    timers.jumpTo(MINUTE_MS);
    runtime.coordinator.noteHumanActivity("stock-market", MINUTE_MS);
    expect(timers.nextDueAt()).toBe(5 * MINUTE_MS);
    await timers.advanceTo(5 * MINUTE_MS);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(runtime.store.scheduleById.get("market-wire")?.nextPollAt).toBe(10 * MINUTE_MS);
    await runtime.coordinator.close();
  });

  it("does not let repeated human activity override an admin-selected active interval", async () => {
    const timers = new ManualTimers();
    const poll = vi.fn(async ({ now }: ChannelFeedPollContext<TestCard>) => ({
      kind: "updated" as const,
      card: card("market-wire", "stock-market", "market", now),
    }));
    const runtime = coordinator(timers, [adapter({
      id: "market-wire",
      channelId: "stock-market",
      minAttemptGapMs: MINUTE_MS,
      poll,
    })]);
    await runtime.coordinator.start();
    await timers.runNext();
    await runtime.coordinator.configure("market-wire", {
      activeIntervalMinutes: 20,
      idleIntervalMinutes: 60,
    });
    expect(timers.nextDueAt()).toBe(60 * MINUTE_MS);

    for (const minute of [1, 5, 10, 15]) {
      timers.jumpTo(minute * MINUTE_MS);
      runtime.coordinator.noteHumanActivity("stock-market", timers.now);
      expect(timers.nextDueAt()).toBe(20 * MINUTE_MS);
    }
    await timers.advanceTo(20 * MINUTE_MS);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(runtime.store.scheduleById.get("market-wire")?.nextPollAt).toBe(40 * MINUTE_MS);
    await runtime.coordinator.close();
  });

  it("does not let human activity shorten provider failure backoff", async () => {
    const timers = new ManualTimers();
    const poll = vi.fn(async () => {
      throw new Error("provider down");
    });
    const runtime = coordinator(
      timers,
      [adapter({
        id: "market-wire",
        channelId: "stock-market",
        activeIntervalMs: 5 * MINUTE_MS,
        idleIntervalMs: 30 * MINUTE_MS,
        minAttemptGapMs: MINUTE_MS,
        poll,
      })],
      new TestStore<TestCard>(),
      { retryBaseMs: 10 * MINUTE_MS, retryMaximumMs: 10 * MINUTE_MS, onError: vi.fn() },
    );
    await runtime.coordinator.start();
    await timers.runNext();
    expect(timers.nextDueAt()).toBe(10 * MINUTE_MS);

    for (const minute of [1, 5, 9]) {
      timers.jumpTo(minute * MINUTE_MS);
      runtime.coordinator.noteHumanActivity("stock-market", timers.now);
      expect(timers.nextDueAt()).toBe(10 * MINUTE_MS);
    }
    expect(poll).toHaveBeenCalledOnce();
    await runtime.coordinator.close();
  });

  it("keeps activity room-local and supports a different football adapter through the same engine", async () => {
    const timers = new ManualTimers();
    const marketPoll = vi.fn(async ({ now }: ChannelFeedPollContext<TestCard>) => ({
      kind: "updated" as const,
      card: card("market-wire", "stock-market", "market", now),
    }));
    const footballPoll = vi.fn(async ({ now }: ChannelFeedPollContext<TestCard>) => ({
      kind: "updated" as const,
      card: card("fixture-wire", "football-talk", "football", now),
    }));
    const runtime = coordinator(timers, [
      adapter({ id: "market-wire", channelId: "stock-market", poll: marketPoll }),
      adapter({ id: "fixture-wire", channelId: "football-talk", kind: "football", poll: footballPoll }),
    ]);
    runtime.coordinator.noteHumanActivity("stock-market", 0);
    await runtime.coordinator.start();
    await timers.runNext();
    expect(marketPoll).toHaveBeenCalledOnce();
    expect(footballPoll).toHaveBeenCalledOnce();
    expect(runtime.coordinator.cards().map((item) => item.kind).sort()).toEqual(["football", "market"]);
    await timers.advanceTo(5 * MINUTE_MS);
    expect(marketPoll).toHaveBeenCalledTimes(2);
    expect(footballPoll).toHaveBeenCalledOnce();
    expect(runtime.store.scheduleById.get("fixture-wire")?.nextPollAt).toBe(30 * MINUTE_MS);
    await runtime.coordinator.close();
  });

  it("never overlaps two polls for the same feed", async () => {
    const timers = new ManualTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maximumActive = 0;
    const poll = vi.fn(async ({ now }: ChannelFeedPollContext<TestCard>) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await blocked;
      active -= 1;
      return { kind: "updated" as const, card: card("market-wire", "stock-market", "market", now) };
    });
    const runtime = coordinator(timers, [adapter({ id: "market-wire", channelId: "stock-market", poll })]);
    await runtime.coordinator.start();
    const firstRun = timers.runNext();
    await Promise.resolve();
    runtime.coordinator.noteHumanActivity("stock-market", timers.now);
    await runtime.coordinator.start();
    expect(poll).toHaveBeenCalledOnce();
    release();
    await firstRun;
    expect(maximumActive).toBe(1);
    await runtime.coordinator.close();
  });

  it("applies bounded exponential failure backoff and resets it after success", async () => {
    const timers = new ManualTimers();
    let attempts = 0;
    const poll = vi.fn(async ({ now }: ChannelFeedPollContext<TestCard>) => {
      attempts += 1;
      if (attempts <= 3) throw new Error("provider down");
      return { kind: "updated" as const, card: card("market-wire", "stock-market", "market", now) };
    });
    const runtime = coordinator(
      timers,
      [adapter({ id: "market-wire", channelId: "stock-market", poll })],
      new TestStore<TestCard>(),
      { retryBaseMs: MINUTE_MS, retryMaximumMs: 4 * MINUTE_MS, onError: vi.fn() },
    );
    await runtime.coordinator.start();
    await timers.runNext();
    expect(timers.nextDueAt()).toBe(MINUTE_MS);
    await timers.advanceTo(MINUTE_MS);
    expect(timers.nextDueAt()).toBe(3 * MINUTE_MS);
    await timers.advanceTo(3 * MINUTE_MS);
    expect(timers.nextDueAt()).toBe(7 * MINUTE_MS);
    await timers.advanceTo(7 * MINUTE_MS);
    expect(poll).toHaveBeenCalledTimes(4);
    expect(runtime.store.scheduleById.get("market-wire")).toMatchObject({
      failures: 0,
      lastSuccessAt: 7 * MINUTE_MS,
      nextPollAt: 37 * MINUTE_MS,
    });
    await runtime.coordinator.close();
  });

  it("sanitizes a stored card against the new clock and rechecks it promptly after restart", async () => {
    const timers = new ManualTimers();
    const store = new TestStore<TestCard>();
    const first = coordinator(timers, [adapter({ id: "market-wire", channelId: "stock-market" })], store);
    await first.coordinator.start();
    await timers.runNext();
    expect(first.coordinator.cards()[0]?.revision).toBe(1);
    await first.coordinator.close();

    timers.jumpTo(10 * MINUTE_MS);
    const restorePersistedCard = vi.fn((persisted: TestCard, now: number): TestCard => ({
      ...persisted,
      state: "unavailable",
      updatedAt: new Date(now).toISOString(),
    }));
    const second = coordinator(timers, [adapter({
      id: "market-wire",
      channelId: "stock-market",
      restorePersistedCard,
    })], store);
    await second.coordinator.start();
    expect(restorePersistedCard).toHaveBeenCalledOnce();
    expect(second.coordinator.cards()[0]).toMatchObject({
      revision: 1,
      state: "unavailable",
      updatedAt: new Date(10 * MINUTE_MS).toISOString(),
    });
    expect(timers.nextDueAt()).toBe(10 * MINUTE_MS);
    await timers.runNext();
    expect(second.coordinator.cards()[0]).toMatchObject({ revision: 2, state: "ready" });
    expect(timers.nextDueAt()).toBe(40 * MINUTE_MS);
    await second.coordinator.start();
    expect(store.loadCalls).toBe(2);
    await second.coordinator.close();
    await second.coordinator.close();
    expect(await timers.runNext()).toBe(false);
  });

  it("hides persisted presentation data when an adapter has no current-clock restore hook", async () => {
    const timers = new ManualTimers();
    timers.jumpTo(10 * MINUTE_MS);
    const store = new TestStore<TestCard>();
    store.cardById.set("fixture-wire", {
      ...card("fixture-wire", "football-talk", "football", 0),
      revision: 3,
    });
    store.scheduleById.set("fixture-wire", {
      feedId: "fixture-wire",
      lastAttemptAt: 0,
      lastSuccessAt: 0,
      nextPollAt: 30 * MINUTE_MS,
      failures: 0,
    });
    const runtime = coordinator(timers, [adapter({
      id: "fixture-wire",
      channelId: "football-talk",
      kind: "football",
    })], store);

    await runtime.coordinator.start();
    expect(runtime.coordinator.cards()).toEqual([]);
    expect(timers.nextDueAt()).toBe(10 * MINUTE_MS);
    await runtime.coordinator.close();
  });

  it("persists a sanitized unavailable card supplied by the domain adapter", async () => {
    const timers = new ManualTimers();
    let attempt = 0;
    const poll = vi.fn(async ({ now }: ChannelFeedPollContext<TestCard>): Promise<ChannelFeedPollResult<TestCard>> => {
      attempt += 1;
      if (attempt === 1) {
        return { kind: "updated", card: card("market-wire", "stock-market", "market", now, "fresh rows") };
      }
      return {
        kind: "unavailable",
        card: {
          ...card("market-wire", "stock-market", "market", now, "no stale rows"),
          state: "unavailable",
        },
      };
    });
    const runtime = coordinator(
      timers,
      [adapter({
        id: "market-wire",
        channelId: "stock-market",
        activeIntervalMs: MINUTE_MS,
        idleIntervalMs: MINUTE_MS,
        poll,
      })],
      new TestStore<TestCard>(),
      { retryBaseMs: MINUTE_MS, onError: vi.fn() },
    );
    await runtime.coordinator.start();
    await timers.runNext();
    await timers.advanceTo(MINUTE_MS);
    expect(runtime.coordinator.cards()[0]).toMatchObject({
      revision: 2,
      state: "unavailable",
      value: "no stale rows",
    });
    await runtime.coordinator.close();
  });

  it("keeps a process-local backoff when failure persistence also fails", async () => {
    const timers = new ManualTimers();
    const store = new TestStore<TestCard>();
    const publishFailure = vi.spyOn(store, "publishFailure").mockRejectedValue(new Error("disk unavailable"));
    const poll = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const onError = vi.fn();
    const runtime = coordinator(
      timers,
      [adapter({ id: "market-wire", channelId: "stock-market", poll })],
      store,
      { retryBaseMs: MINUTE_MS, onError },
    );
    await runtime.coordinator.start();
    await timers.runNext();
    expect(publishFailure).toHaveBeenCalledOnce();
    expect(poll).toHaveBeenCalledOnce();
    expect(timers.nextDueAt()).toBe(MINUTE_MS);
    expect(onError).toHaveBeenCalledTimes(2);
    await runtime.coordinator.close();
  });

  it("does not turn a throwing transport callback into a provider failure", async () => {
    const timers = new ManualTimers();
    const store = new TestStore<TestCard>();
    const onError = vi.fn();
    const runtime = coordinator(
      timers,
      [adapter({ id: "market-wire", channelId: "stock-market" })],
      store,
      {
        onCard: () => { throw new Error("socket unavailable"); },
        onError,
      },
    );
    const publishFailure = vi.spyOn(store, "publishFailure");
    await runtime.coordinator.start();
    await timers.runNext();
    expect(publishFailure).not.toHaveBeenCalled();
    expect(store.scheduleById.get("market-wire")).toMatchObject({
      failures: 0,
      nextPollAt: 30 * MINUTE_MS,
    });
    expect(onError).toHaveBeenCalledOnce();
    await runtime.coordinator.close();
  });

  it("hard-times out an adapter that ignores its abort signal", async () => {
    const timers = new ManualTimers();
    const never = new Promise<ChannelFeedPollResult<TestCard>>(() => undefined);
    const poll = vi.fn(() => never);
    const runtime = coordinator(
      timers,
      [{
        ...adapter({ id: "market-wire", channelId: "stock-market", poll }),
        pollTimeoutMs: 2 * MINUTE_MS,
      }],
      new TestStore<TestCard>(),
      { retryBaseMs: MINUTE_MS, onError: vi.fn() },
    );
    await runtime.coordinator.start();
    const running = timers.runNext();
    await Promise.resolve();
    expect(poll).toHaveBeenCalledOnce();
    await timers.runNext();
    await running;
    expect(timers.nextDueAt()).toBe(3 * MINUTE_MS);
    await runtime.coordinator.close();
  });

  it("closes immediately even when an adapter ignores abort", async () => {
    const timers = new ManualTimers();
    const poll = vi.fn(() => new Promise<ChannelFeedPollResult<TestCard>>(() => undefined));
    const runtime = coordinator(timers, [{
      ...adapter({ id: "market-wire", channelId: "stock-market", poll }),
      pollTimeoutMs: 10 * MINUTE_MS,
    }]);
    await runtime.coordinator.start();
    const running = timers.runNext();
    await Promise.resolve();
    const firstClose = runtime.coordinator.close();
    const secondClose = runtime.coordinator.close();
    expect(secondClose).toBe(firstClose);
    await firstClose;
    await running;
    expect(await timers.runNext()).toBe(false);
  });

  it("persists controls per feed and exposes generic room-owned descriptors", async () => {
    const timers = new ManualTimers();
    const runtime = coordinator(timers, [
      adapter({ id: "market-wire", channelId: "stock-market" }),
      adapter({ id: "fixture-wire", channelId: "football-talk", kind: "football" }),
    ]);
    await runtime.coordinator.start();

    expect(runtime.coordinator.controls()).toEqual([
      expect.objectContaining({
        id: "fixture-wire",
        channelId: "football-talk",
        kind: "football",
        label: "FixtureWire",
        publisher: { id: "fixture-wire", name: "FixtureWire", badge: "BOT" },
        enabled: true,
        activeIntervalMinutes: 5,
        idleIntervalMinutes: 30,
        status: "waiting",
      }),
      expect.objectContaining({
        id: "market-wire",
        channelId: "stock-market",
        kind: "market",
        minimumIntervalMinutes: 1,
        maximumIntervalMinutes: 1_440,
      }),
    ]);

    const configured = await runtime.coordinator.configure("market-wire", {
      activeIntervalMinutes: 10,
      idleIntervalMinutes: 60,
    });
    expect(configured).toMatchObject({
      enabled: true,
      activeIntervalMinutes: 10,
      idleIntervalMinutes: 60,
    });
    expect(runtime.store.configurationById.get("market-wire")).toMatchObject({
      activeIntervalMs: 10 * MINUTE_MS,
      idleIntervalMs: 60 * MINUTE_MS,
    });
    await runtime.coordinator.close();
  });

  it("hides a disabled feed immediately and rejects a late result from its old generation", async () => {
    const timers = new ManualTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const poll = vi.fn(async ({ now }: ChannelFeedPollContext<TestCard>) => {
      await blocked;
      return { kind: "updated" as const, card: card("market-wire", "stock-market", "market", now) };
    });
    const fullSnapshots: TestCard[][] = [];
    const runtime = coordinator(
      timers,
      [adapter({ id: "market-wire", channelId: "stock-market", poll })],
      new TestStore<TestCard>(),
      { onCardsChanged: (cards) => fullSnapshots.push(cards) },
    );
    await runtime.coordinator.start();
    const running = timers.runNext();
    await Promise.resolve();
    expect(runtime.coordinator.controls()[0]?.status).toBe("polling");

    const disabled = await runtime.coordinator.configure("market-wire", { enabled: false });
    expect(disabled).toMatchObject({ enabled: false, status: "disabled", cardAvailable: false });
    expect(runtime.coordinator.cards()).toEqual([]);
    release();
    await running;
    expect(runtime.store.cardById.has("market-wire")).toBe(false);
    expect(runtime.store.configurationById.get("market-wire")).toMatchObject({
      enabled: false,
      freshPollRequired: true,
    });
    expect(fullSnapshots.at(-1)).toEqual([]);
    await runtime.coordinator.close();
  });

  it("keeps a re-enabled card hidden until a fresh unchanged poll validates it", async () => {
    const timers = new ManualTimers();
    let attempt = 0;
    const poll = vi.fn(async ({ now }: ChannelFeedPollContext<TestCard>) => {
      attempt += 1;
      return attempt === 1
        ? { kind: "updated" as const, card: card("market-wire", "stock-market", "market", now) }
        : { kind: "unchanged" as const };
    });
    const store = new TestStore<TestCard>();
    const runtime = coordinator(
      timers,
      [adapter({ id: "market-wire", channelId: "stock-market", poll })],
      store,
    );
    await runtime.coordinator.start();
    await timers.runNext();
    expect(runtime.coordinator.cards()).toHaveLength(1);

    await runtime.coordinator.configure("market-wire", { enabled: false });
    expect(runtime.coordinator.cards()).toEqual([]);
    await runtime.coordinator.configure("market-wire", { enabled: true });
    expect(runtime.coordinator.controls()[0]).toMatchObject({ status: "waiting", cardAvailable: false });
    expect(runtime.coordinator.cards()).toEqual([]);
    expect(timers.nextDueAt()).toBe(MINUTE_MS);

    await timers.advanceTo(MINUTE_MS);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(runtime.coordinator.cards()).toHaveLength(1);
    expect(runtime.coordinator.controls()[0]).toMatchObject({ status: "ready", cardAvailable: true });
    expect(store.configurationById.get("market-wire")?.freshPollRequired).toBe(false);
    await runtime.coordinator.close();
  });

  it("validates unknown feeds, bounds and idle-versus-active cadence without heuristics", async () => {
    const timers = new ManualTimers();
    const runtime = coordinator(timers, [adapter({ id: "market-wire", channelId: "stock-market" })]);
    await runtime.coordinator.start();
    await expect(runtime.coordinator.configure("missing-feed", { enabled: false }))
      .rejects.toMatchObject<Partial<ChannelFeedConfigurationError>>({ code: "unknown_feed" });
    await expect(runtime.coordinator.configure("market-wire", { activeIntervalMinutes: 0 }))
      .rejects.toMatchObject<Partial<ChannelFeedConfigurationError>>({ code: "invalid_configuration" });
    await expect(runtime.coordinator.configure("market-wire", {
      activeIntervalMinutes: 20,
      idleIntervalMinutes: 10,
    })).rejects.toMatchObject<Partial<ChannelFeedConfigurationError>>({ code: "invalid_configuration" });
    await runtime.coordinator.close();
  });

  it("persists an interrupted attempt so activity and restart cannot bypass the provider gap", async () => {
    const timers = new ManualTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const store = new TestStore<TestCard>();
    const first = coordinator(timers, [adapter({
      id: "market-wire",
      channelId: "stock-market",
      minAttemptGapMs: 5 * MINUTE_MS,
      poll: async ({ now }) => {
        await blocked;
        return { kind: "updated", card: card("market-wire", "stock-market", "market", now) };
      },
    })], store);
    await first.coordinator.start();
    const running = timers.runNext();
    await Promise.resolve();
    await first.coordinator.configure("market-wire", { enabled: false });
    release();
    await running;
    expect(store.scheduleById.get("market-wire")).toMatchObject({
      lastAttemptAt: 0,
      nextPollAt: 5 * MINUTE_MS,
    });
    await first.coordinator.close();

    timers.jumpTo(MINUTE_MS);
    const second = coordinator(timers, [adapter({
      id: "market-wire",
      channelId: "stock-market",
      minAttemptGapMs: 5 * MINUTE_MS,
    })], store);
    await second.coordinator.start();
    expect(timers.nextDueAt()).toBeUndefined();
    await second.coordinator.configure("market-wire", { enabled: true });
    second.coordinator.noteHumanActivity("stock-market", MINUTE_MS);
    expect(timers.nextDueAt()).toBe(5 * MINUTE_MS);
    await second.coordinator.close();
  });

  it("chooses changed cadence from current room activity, not the prior attempt time", async () => {
    const timers = new ManualTimers();
    const runtime = coordinator(timers, [adapter({
      id: "market-wire",
      channelId: "stock-market",
      minAttemptGapMs: MINUTE_MS,
    })]);
    await runtime.coordinator.start();
    await timers.runNext();
    timers.jumpTo(MINUTE_MS);
    runtime.coordinator.noteHumanActivity("stock-market", MINUTE_MS);
    expect(timers.nextDueAt()).toBe(5 * MINUTE_MS);

    await runtime.coordinator.configure("market-wire", {
      activeIntervalMinutes: 10,
      idleIntervalMinutes: 60,
    });
    expect(timers.nextDueAt()).toBe(10 * MINUTE_MS);
    await runtime.coordinator.close();
  });

  it("adopts a card committed ahead of an interval-only configuration", async () => {
    const timers = new ManualTimers();
    const store = new QueuedPublishTestStore();
    store.cardById.set("market-wire", {
      ...card("market-wire", "stock-market", "market", 0, "old"),
      revision: 1,
    });
    store.scheduleById.set("market-wire", {
      feedId: "market-wire",
      nextPollAt: 0,
      failures: 0,
    });
    const snapshots: TestCard[][] = [];
    const runtime = coordinator(timers, [adapter({
      id: "market-wire",
      channelId: "stock-market",
      restorePersistedCard: (persisted) => persisted,
      poll: async ({ now }) => ({
        kind: "updated",
        card: card("market-wire", "stock-market", "market", now, "new"),
      }),
    })], store, { onCardsChanged: (cards) => snapshots.push(cards) });
    await runtime.coordinator.start();
    const running = timers.runNext();
    await store.publishEntered;
    const configuring = runtime.coordinator.configure("market-wire", {
      activeIntervalMinutes: 10,
      idleIntervalMinutes: 60,
    });
    await Promise.resolve();
    store.release();
    await configuring;
    await running;

    expect(store.getCard("market-wire")).toMatchObject({ revision: 2, value: "new" });
    expect(runtime.coordinator.cards()[0]).toMatchObject({ revision: 2, value: "new" });
    expect(snapshots.at(-1)?.[0]).toMatchObject({ revision: 2, value: "new" });
    await runtime.coordinator.close();
  });
});
