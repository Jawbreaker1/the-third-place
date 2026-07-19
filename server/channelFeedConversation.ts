import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { ChannelFeedCard, MarketTickerFeedCard } from "../shared/types.js";
import { residentChannelFeedFact, type ResidentChannelFeedFact } from "./channelFeedFacts.js";

const MAX_STATE_BYTES = 64 * 1024;
const MAX_FEEDS = 64;
const MAX_INSTANT = 8_640_000_000_000_000;
const MINUTE_MS = 60_000;
const FEED_ID = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const REVISION_KEY = /^[a-z0-9][a-z0-9:._-]{2,191}$/u;

export type ChannelFeedConversationRelevance = "low" | "normal" | "high";

/**
 * A trusted, typed opportunity to discuss one exact feed revision. It is not
 * chat history and does not itself schedule or publish a resident message.
 */
export interface ChannelFeedConversationCue {
  feedId: string;
  channelId: string;
  feedKind: ChannelFeedCard["kind"];
  revision: number;
  /** Stable idempotency key persisted independently from the poll schedule. */
  revisionKey: string;
  semanticKey: string;
  publisherName: string;
  relevance: ChannelFeedConversationRelevance;
  fact: ResidentChannelFeedFact;
  /** Server-authored framing; the fact payload remains the only world evidence. */
  discussionPremise: string;
}

export interface ChannelFeedConversationPolicy {
  /** Independent from polling cadence. Zero disables autonomous discussion. */
  frequency: number;
  /** Absolute lower bound between successful feed-led publications in a room. */
  hardCooldownMs: number;
  /** Backoff after a reserved cue failed to produce a published resident turn. */
  failedAttemptCooldownMs: number;
}

export interface ChannelFeedConversationDecision {
  eligible: boolean;
  reason:
    | "eligible"
    | "disabled"
    | "already_published"
    | "superseded"
    | "hard_cooldown"
    | "chance"
    | "retry_backoff";
  chance: number;
}

/**
 * Maps the admin's independent discussion dial to a bounded publication
 * policy. Polling remains owned by ChannelFeedCoordinator: even at 100 a feed
 * can open at most one resident episode per 30 minutes, while lower settings
 * spread eligible episodes further apart.
 */
export const channelFeedConversationPolicy = (
  frequency: number,
): ChannelFeedConversationPolicy => {
  const boundedFrequency = Math.max(0, Math.min(100, Math.round(frequency)));
  const minimumCooldownMs = 30 * MINUTE_MS;
  const maximumCooldownMs = 3 * 60 * MINUTE_MS;
  return {
    frequency: boundedFrequency,
    hardCooldownMs: Math.round(
      maximumCooldownMs - (maximumCooldownMs - minimumCooldownMs) * (boundedFrequency / 100),
    ),
    failedAttemptCooldownMs: 3 * MINUTE_MS,
  };
};

export interface ChannelFeedConversationFeedState {
  feedId: string;
  channelId?: string;
  consideredRevisionKey?: string;
  consideredRevision?: number;
  /** Frequency at which this exact revision was last sampled. */
  consideredFrequency?: number;
  /** One stable bucket per revision; frequency changes never compound probability. */
  consideredRoll?: number;
  admitted?: boolean;
  lastAttemptAt?: number;
  lastPublishedRevisionKey?: string;
  lastPublishedRevision?: number;
  lastPublishedAt?: number;
}

export interface ChannelFeedConversationPersistedState {
  version: 1;
  feeds: ChannelFeedConversationFeedState[];
}

/**
 * Durable proof emitted by RoomStore only after the corresponding chat row
 * crossed its own persistence barrier. It lets a restart repair the narrow
 * crash window between the room commit and this ledger's acknowledgement.
 */
export interface ChannelFeedConversationPublishedReceipt {
  feedId: string;
  channelId: string;
  revisionKey: string;
  revision: number;
  publishedAt: number;
}

export interface ChannelFeedConversationPersistence {
  load(): Promise<unknown | undefined>;
  save(state: ChannelFeedConversationPersistedState): Promise<void>;
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryChannelFeedConversationPersistence implements ChannelFeedConversationPersistence {
  private state?: ChannelFeedConversationPersistedState;

  async load(): Promise<unknown | undefined> {
    return this.state ? clone(this.state) : undefined;
  }

  async save(state: ChannelFeedConversationPersistedState): Promise<void> {
    this.state = clone(state);
  }
}

/** Atomic, permission-restricted persistence for feed discussion decisions. */
export class JsonFileChannelFeedConversationPersistence implements ChannelFeedConversationPersistence {
  private readonly path: string;

  constructor(path = "./data/channel-feed-conversations.json") {
    this.path = resolve(path);
  }

  async load(): Promise<unknown | undefined> {
    try {
      const metadata = await stat(this.path);
      if (!metadata.isFile()) throw new TypeError("Channel feed conversation state path is not a file.");
      if (metadata.size > MAX_STATE_BYTES) throw new RangeError("Channel feed conversation state exceeded its size bound.");
      const payload = await readFile(this.path);
      if (payload.byteLength > MAX_STATE_BYTES) throw new RangeError("Channel feed conversation state exceeded its size bound.");
      const parsed = JSON.parse(payload.toString("utf8")) as unknown;
      await chmod(this.path, 0o600).catch(() => undefined);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(state: ChannelFeedConversationPersistedState): Promise<void> {
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(payload) > MAX_STATE_BYTES) {
      throw new RangeError("Channel feed conversation state exceeded its size bound.");
    }
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = join(dirname(this.path), `.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, payload, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

const marketRelevance = (card: MarketTickerFeedCard): ChannelFeedConversationRelevance => {
  if (card.observations.some((observation) => observation.freshness === "recent")) return "high";
  if (card.observations.some((observation) => observation.freshness === "previous_session")) return "normal";
  return "low";
};

const marketDiscussionPremise = (card: MarketTickerFeedCard): string => {
  const coverage = `${card.coverage.available}/${card.coverage.requested}`;
  return `Open one chat-shaped discussion from the exact ${card.publisher.name} revision supplied in trusted channel-feed facts. ` +
    `Use one or two reported index moves from its ${coverage} coverage and add a concrete interpretation, comparison or disagreement that another resident can answer. ` +
    "Describe values only as latest reported observations versus previous close. Do not infer a cause, headline, forecast, trade recommendation, shared session, closing value or whether any exchange is open.";
};

/**
 * Deterministic, exhaustive card projection. Future feed kinds add a typed
 * branch here (or delegate to a kind-specific projector) without changing the
 * scheduler or ledger contract.
 */
export const channelFeedConversationCue = (
  card: ChannelFeedCard,
): ChannelFeedConversationCue | undefined => {
  const fact = residentChannelFeedFact(card);
  if (!fact || card.revision < 1) return undefined;
  switch (card.kind) {
    case "market_ticker": {
      if (card.state === "unavailable" || card.observations.length === 0) return undefined;
      const revisionKey = `${card.kind}:${card.id}:${card.revision}`;
      return {
        feedId: card.id,
        channelId: card.channelId,
        feedKind: card.kind,
        revision: card.revision,
        revisionKey,
        semanticKey: `channel-feed:${card.channelId}:${card.id}`,
        publisherName: card.publisher.name,
        relevance: marketRelevance(card),
        fact,
        discussionPremise: marketDiscussionPremise(card),
      };
    }
  }
};

const chanceFor = (frequency: number, relevance: ChannelFeedConversationRelevance): number => {
  const base = Math.max(0, Math.min(100, frequency)) / 100;
  const relevanceMultiplier = relevance === "high" ? 1 : relevance === "normal" ? 0.7 : 0.35;
  return Math.max(0, Math.min(1, base * relevanceMultiplier));
};

const safeInstant = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_INSTANT;

const validOptionalRevisionKey = (value: unknown): value is string | undefined =>
  value === undefined || (typeof value === "string" && REVISION_KEY.test(value));

const parseState = (value: unknown): ChannelFeedConversationPersistedState => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid channel feed conversation persistence payload.");
  }
  const root = value as Record<string, unknown>;
  if (root.version !== 1 || Object.keys(root).some((key) => !["version", "feeds"].includes(key)) ||
      !Array.isArray(root.feeds) || root.feeds.length > MAX_FEEDS) {
    throw new TypeError("Invalid channel feed conversation persistence payload.");
  }
  const feeds = root.feeds.map((raw): ChannelFeedConversationFeedState => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Invalid feed discussion state.");
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some((key) => ![
      "feedId", "channelId", "consideredRevisionKey", "admitted", "lastAttemptAt",
      "consideredRevision", "consideredFrequency", "consideredRoll", "lastPublishedRevisionKey",
      "lastPublishedRevision", "lastPublishedAt",
    ].includes(key)) ||
      typeof item.feedId !== "string" || !FEED_ID.test(item.feedId) ||
      (item.channelId !== undefined &&
        (typeof item.channelId !== "string" || !FEED_ID.test(item.channelId))) ||
      !validOptionalRevisionKey(item.consideredRevisionKey) ||
      (item.consideredRevision !== undefined &&
        (!Number.isSafeInteger(item.consideredRevision) || (item.consideredRevision as number) < 1)) ||
      (item.consideredFrequency !== undefined &&
        (!Number.isSafeInteger(item.consideredFrequency) ||
          (item.consideredFrequency as number) < 0 || (item.consideredFrequency as number) > 100)) ||
      (item.consideredRoll !== undefined &&
        (typeof item.consideredRoll !== "number" || !Number.isFinite(item.consideredRoll) ||
          (item.consideredRoll as number) < 0 || (item.consideredRoll as number) >= 1)) ||
      (item.admitted !== undefined && typeof item.admitted !== "boolean") ||
      (item.lastAttemptAt !== undefined && !safeInstant(item.lastAttemptAt)) ||
      !validOptionalRevisionKey(item.lastPublishedRevisionKey) ||
      (item.lastPublishedRevision !== undefined &&
        (!Number.isSafeInteger(item.lastPublishedRevision) || (item.lastPublishedRevision as number) < 1)) ||
      (item.lastPublishedAt !== undefined && !safeInstant(item.lastPublishedAt)) ||
      (item.consideredRevisionKey === undefined) !== (item.consideredRevision === undefined) ||
      (item.consideredRevisionKey === undefined) !== (item.admitted === undefined) ||
      (item.consideredRevisionKey === undefined && item.consideredFrequency !== undefined) ||
      (item.consideredRevisionKey === undefined && item.consideredRoll !== undefined) ||
      (item.lastPublishedRevisionKey === undefined) !== (item.lastPublishedRevision === undefined) ||
      (item.lastPublishedRevisionKey === undefined) !== (item.lastPublishedAt === undefined)) {
      throw new TypeError("Invalid feed discussion state.");
    }
    return item as unknown as ChannelFeedConversationFeedState;
  });
  if (new Set(feeds.map((feed) => feed.feedId)).size !== feeds.length) {
    throw new TypeError("Duplicate channel feed conversation state.");
  }
  return { version: 1, feeds };
};

const validatePolicy = (policy: ChannelFeedConversationPolicy): void => {
  if (!Number.isFinite(policy.frequency) || policy.frequency < 0 || policy.frequency > 100 ||
      !Number.isSafeInteger(policy.hardCooldownMs) || policy.hardCooldownMs < 60_000 ||
      !Number.isSafeInteger(policy.failedAttemptCooldownMs) || policy.failedAttemptCooldownMs < 10_000) {
    throw new TypeError("Invalid channel feed conversation policy.");
  }
};

const validateCue = (cue: ChannelFeedConversationCue): void => {
  if (!FEED_ID.test(cue.feedId) || !REVISION_KEY.test(cue.revisionKey) || cue.revision < 1 ||
      !Number.isSafeInteger(cue.revision) ||
      cue.revisionKey !== `${cue.feedKind}:${cue.feedId}:${cue.revision}` ||
      !FEED_ID.test(cue.channelId) || !cue.fact.content.trim()) {
    throw new TypeError("Invalid channel feed conversation cue.");
  }
};

/**
 * Persistent single-decision ledger. Chance is sampled once per revision;
 * admitted-but-failed work retries after backoff without rerolling, while a
 * published or chance-skipped revision can never be emitted again.
 */
export class ChannelFeedConversationLedger {
  private state: ChannelFeedConversationPersistedState = { version: 1, feeds: [] };
  private started = false;
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private readonly persistence: ChannelFeedConversationPersistence =
      new JsonFileChannelFeedConversationPersistence(),
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    const loaded = await this.persistence.load();
    this.state = loaded === undefined ? { version: 1, feeds: [] } : parseState(loaded);
    this.started = true;
  }

  snapshot(): ChannelFeedConversationPersistedState {
    if (!this.started) throw new Error("Channel feed conversation ledger has not started.");
    return clone(this.state);
  }

  async reserve(
    cue: ChannelFeedConversationCue,
    policy: ChannelFeedConversationPolicy,
    now: number,
    rng: () => number = Math.random,
  ): Promise<ChannelFeedConversationDecision> {
    validateCue(cue);
    validatePolicy(policy);
    if (!safeInstant(now)) throw new TypeError("Invalid channel feed conversation timestamp.");
    return this.serialized(async () => {
      const chance = chanceFor(policy.frequency, cue.relevance);
      if (chance === 0) return { eligible: false, reason: "disabled", chance };
      const draft = clone(this.state);
      const entry = this.entry(draft, cue.feedId);
      if (entry.channelId !== undefined && entry.channelId !== cue.channelId) {
        throw new TypeError("A channel feed cannot move its conversation state to another room.");
      }
      entry.channelId = cue.channelId;
      if (entry.lastPublishedRevisionKey === cue.revisionKey) {
        return { eligible: false, reason: "already_published", chance };
      }
      if (entry.consideredRevision !== undefined && cue.revision < entry.consideredRevision) {
        return { eligible: false, reason: "superseded", chance };
      }
      const roomLastPublishedAt = draft.feeds.reduce<number | undefined>((latest, candidate) => {
        if (candidate.channelId !== cue.channelId || candidate.lastPublishedAt === undefined) return latest;
        return latest === undefined ? candidate.lastPublishedAt : Math.max(latest, candidate.lastPublishedAt);
      }, undefined);
      if (roomLastPublishedAt !== undefined && now - roomLastPublishedAt < policy.hardCooldownMs) {
        return { eligible: false, reason: "hard_cooldown", chance };
      }

      if (entry.consideredRevisionKey === cue.revisionKey) {
        if (!entry.admitted) {
          const sampledFrequency = entry.consideredFrequency ?? 0;
          if (policy.frequency <= sampledFrequency) {
            return { eligible: false, reason: "chance", chance };
          }
          // New rows persist one bucket forever, so raising the dial reveals
          // exactly the newly covered probability interval instead of adding
          // a second independent chance. A legacy row without a bucket gets
          // one bounded migration sample and persists it immediately.
          const roll = entry.consideredRoll ?? rng();
          if (!Number.isFinite(roll) || roll < 0 || roll >= 1) {
            throw new TypeError("Channel feed conversation rng must return a number in [0, 1).");
          }
          entry.consideredFrequency = policy.frequency;
          entry.consideredRoll = roll;
          entry.admitted = roll < chance;
          entry.lastAttemptAt = entry.admitted ? now : undefined;
          await this.commit(draft);
          return entry.admitted
            ? { eligible: true, reason: "eligible", chance }
            : { eligible: false, reason: "chance", chance };
        }
        if (entry.lastAttemptAt !== undefined && now - entry.lastAttemptAt < policy.failedAttemptCooldownMs) {
          return { eligible: false, reason: "retry_backoff", chance };
        }
        entry.lastAttemptAt = now;
        await this.commit(draft);
        return { eligible: true, reason: "eligible", chance };
      }

      const roll = rng();
      if (!Number.isFinite(roll) || roll < 0 || roll >= 1) {
        throw new TypeError("Channel feed conversation rng must return a number in [0, 1).");
      }
      entry.consideredRevisionKey = cue.revisionKey;
      entry.consideredRevision = cue.revision;
      entry.consideredFrequency = policy.frequency;
      entry.consideredRoll = roll;
      entry.admitted = roll < chance;
      entry.lastAttemptAt = entry.admitted ? now : undefined;
      await this.commit(draft);
      return entry.admitted
        ? { eligible: true, reason: "eligible", chance }
        : { eligible: false, reason: "chance", chance };
    });
  }

  async acknowledgePublished(cue: ChannelFeedConversationCue, publishedAt: number): Promise<void> {
    validateCue(cue);
    if (!safeInstant(publishedAt)) throw new TypeError("Invalid channel feed publication timestamp.");
    await this.serialized(async () => {
      const draft = clone(this.state);
      const entry = this.entry(draft, cue.feedId);
      if (entry.consideredRevisionKey !== cue.revisionKey || entry.admitted !== true) {
        throw new Error("Cannot publish an unreserved channel feed conversation cue.");
      }
      entry.lastPublishedRevisionKey = cue.revisionKey;
      entry.lastPublishedRevision = cue.revision;
      entry.lastPublishedAt = publishedAt;
      entry.lastAttemptAt = publishedAt;
      await this.commit(draft);
    });
  }

  /**
   * Reconciles room-first commits after restart. Older receipts already below
   * the ledger high-water mark are harmless; a receipt ahead of, or different
   * from, the durably reserved revision is corruption and fails closed.
   */
  async reconcilePublished(
    rawReceipts: readonly ChannelFeedConversationPublishedReceipt[],
  ): Promise<number> {
    const receipts = rawReceipts.map((receipt) => {
      if (!FEED_ID.test(receipt.feedId) || !FEED_ID.test(receipt.channelId) ||
          !REVISION_KEY.test(receipt.revisionKey) ||
          !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 ||
          receipt.revisionKey.endsWith(`:${receipt.feedId}:${receipt.revision}`) === false ||
          !safeInstant(receipt.publishedAt)) {
        throw new TypeError("Invalid durable channel feed publication receipt.");
      }
      return { ...receipt };
    }).sort((left, right) =>
      left.publishedAt - right.publishedAt ||
      left.revision - right.revision ||
      left.feedId.localeCompare(right.feedId)
    );
    return this.serialized(async () => {
      if (receipts.length === 0) return 0;
      const draft = clone(this.state);
      let reconciled = 0;
      for (const receipt of receipts) {
        const entry = this.entry(draft, receipt.feedId);
        if (entry.channelId !== undefined && entry.channelId !== receipt.channelId) {
          throw new TypeError("A durable feed publication belongs to a different room.");
        }
        entry.channelId = receipt.channelId;
        if ((entry.lastPublishedRevision ?? 0) > receipt.revision) continue;
        if (entry.lastPublishedRevision === receipt.revision) {
          if (entry.lastPublishedRevisionKey !== receipt.revisionKey) {
            throw new TypeError("A feed revision has conflicting durable publication receipts.");
          }
          continue;
        }
        if ((entry.consideredRevision ?? 0) > receipt.revision) {
          throw new TypeError("A durable feed publication is missing below the admission high-water mark.");
        }
        if (
          entry.consideredRevision !== receipt.revision ||
          entry.consideredRevisionKey !== receipt.revisionKey ||
          entry.admitted !== true
        ) {
          throw new TypeError("A durable feed publication has no matching admitted revision.");
        }
        entry.lastPublishedRevisionKey = receipt.revisionKey;
        entry.lastPublishedRevision = receipt.revision;
        entry.lastPublishedAt = receipt.publishedAt;
        entry.lastAttemptAt = Math.max(entry.lastAttemptAt ?? 0, receipt.publishedAt);
        reconciled += 1;
      }
      if (reconciled > 0) await this.commit(draft);
      return reconciled;
    });
  }

  private entry(
    state: ChannelFeedConversationPersistedState,
    feedId: string,
  ): ChannelFeedConversationFeedState {
    const existing = state.feeds.find((candidate) => candidate.feedId === feedId);
    if (existing) return existing;
    if (state.feeds.length >= MAX_FEEDS) throw new RangeError("Too many channel feed conversation states.");
    const created = { feedId };
    state.feeds.push(created);
    state.feeds.sort((left, right) => left.feedId.localeCompare(right.feedId));
    return created;
  }

  /** Persist first, then expose the draft in memory. Failed writes are atomic. */
  private async commit(draft: ChannelFeedConversationPersistedState): Promise<void> {
    await this.persistence.save(clone(draft));
    this.state = draft;
  }

  private async serialized<T>(task: () => Promise<T>): Promise<T> {
    if (!this.started) throw new Error("Channel feed conversation ledger has not started.");
    const result = this.operation.then(task, task);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }
}

export const channelFeedConversationChance = chanceFor;
