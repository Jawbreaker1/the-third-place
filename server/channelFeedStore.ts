import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  ChannelFeedCard,
  ChannelFeedPublisher,
  ChannelFeedSource,
  MarketTickerFeedCard,
  MarketTickerFeedCoverage,
  MarketTickerFeedObservation,
} from "../shared/types.js";
import {
  classifyMarketFreshness,
  isStructurallyAcceptableMarketInstant,
} from "./marketData/freshness.js";
import { validatePublicHttpsUrl } from "./safeHttpsFetch.js";

const MAX_STATE_BYTES = 512 * 1024;
const MAX_CARDS = 32;
const MAX_ROWS_PER_CARD = 8;
const MAX_FAILURES = 1_000;
const MAX_REVISION = Number.MAX_SAFE_INTEGER;
const MAX_SCHEDULE_INSTANT = 8_640_000_000_000_000;
const MIN_RUNTIME_INTERVAL_MS = 60_000;
const MAX_RUNTIME_INTERVAL_MS = 24 * 60 * 60_000;
const CATALOG_ID = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const TRADING_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const HEX_COLOR = /^#[0-9a-f]{3,8}$/iu;

export type ChannelFeedCardDraft = ChannelFeedCard extends infer Card
  ? Card extends ChannelFeedCard
    ? Omit<Card, "revision">
    : never
  : never;

export interface ChannelFeedScheduleState {
  feedId: string;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  nextPollAt: number;
  failures: number;
}

export interface ChannelFeedPollTiming {
  attemptedAt: number;
  nextPollAt: number;
}

export interface ChannelFeedStoredConfiguration {
  feedId: string;
  enabled: boolean;
  /** Missing only while a strict version-two payload awaits adapter-aware migration. */
  discussionFrequency?: number;
  activeIntervalMs: number;
  idleIntervalMs: number;
  /**
   * Set when a disabled feed is enabled. A pre-disable card remains durable,
   * but cannot become public again until a new provider poll has completed.
   */
  freshPollRequired: boolean;
}

export interface ChannelFeedRuntimeConfiguration extends ChannelFeedStoredConfiguration {
  /** Independent from provider polling: 0 never opens autonomous discussion, 100 is the bounded ceiling. */
  discussionFrequency: number;
}

interface ChannelFeedPersistedStateV2 {
  version: 2;
  cards: ChannelFeedCard[];
  schedules: ChannelFeedScheduleState[];
  configurations: Omit<ChannelFeedRuntimeConfiguration, "discussionFrequency">[];
}

interface ChannelFeedPersistedStateV3 {
  version: 3;
  cards: ChannelFeedCard[];
  schedules: ChannelFeedScheduleState[];
  /**
   * Mixed rows are intentional during adapter-aware migration: registered
   * feeds gain a discussion frequency immediately, while an unavailable
   * adapter's legacy row remains lossless until that adapter returns.
   */
  configurations: ChannelFeedStoredConfiguration[];
}

export type ChannelFeedPersistedState = ChannelFeedPersistedStateV2 | ChannelFeedPersistedStateV3;

export interface ChannelFeedPersistence {
  load(): Promise<unknown | undefined>;
  save(state: ChannelFeedPersistedState): Promise<void>;
}

export interface ChannelFeedStoreOptions {
  persistence?: ChannelFeedPersistence;
  filePath?: string;
}

export class ChannelFeedStateLoadError extends Error {
  constructor(cause: unknown) {
    super("Channel feed state is invalid or unreadable.", { cause });
    this.name = "ChannelFeedStateLoadError";
  }
}

const clone = <T>(value: T): T => structuredClone(value);

export class MemoryChannelFeedPersistence implements ChannelFeedPersistence {
  private state?: ChannelFeedPersistedState;

  async load(): Promise<unknown | undefined> {
    return this.state ? clone(this.state) : undefined;
  }

  async save(state: ChannelFeedPersistedState): Promise<void> {
    this.state = clone(state);
  }
}

/** Atomic, permission-restricted JSON persistence for mutable channel cards. */
export class JsonFileChannelFeedPersistence implements ChannelFeedPersistence {
  constructor(private readonly path: string) {}

  async load(): Promise<unknown | undefined> {
    try {
      const metadata = await stat(this.path);
      if (!metadata.isFile()) throw new TypeError("Channel feed state path is not a file.");
      if (metadata.size > MAX_STATE_BYTES) throw new RangeError("Channel feed state exceeded its size bound.");
      const payload = await readFile(this.path);
      if (payload.byteLength > MAX_STATE_BYTES) throw new RangeError("Channel feed state exceeded its size bound.");
      const parsed = JSON.parse(payload.toString("utf8")) as unknown;
      await chmod(this.path, 0o600).catch(() => undefined);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async save(state: ChannelFeedPersistedState): Promise<void> {
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(payload) > MAX_STATE_BYTES) {
      throw new RangeError("Channel feed state exceeded its size bound.");
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

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasOnlyKeys = (value: JsonRecord, allowed: ReadonlySet<string>): boolean =>
  Object.keys(value).every((key) => allowed.has(key));

const boundedText = (value: unknown, maximum: number, minimum = 1): value is string =>
  typeof value === "string" &&
  value.length >= minimum &&
  value.length <= maximum &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/u.test(value);

const safeInteger = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;

const canonicalTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

const safeInstant = (value: unknown): value is number =>
  safeInteger(value, 0, MAX_SCHEDULE_INSTANT);

const validTradingDate = (value: unknown): value is string => {
  if (typeof value !== "string" || !TRADING_DATE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
};

const publicCredentialFreeHttpsUrl = (value: unknown): value is string =>
  typeof value === "string" && Boolean(validatePublicHttpsUrl(value));

const finiteNumber = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;

const PUBLISHER_KEYS = new Set(["id", "name", "badge", "avatar"]);
const AVATAR_KEYS = new Set(["color", "accent", "glyph", "imageUrl"]);
const SOURCE_KEYS = new Set(["id", "label", "url", "retrievedAt", "experimental"]);
const OBSERVATION_KEYS = new Set([
  "indexId",
  "displayName",
  "shortName",
  "currency",
  "level",
  "previousClose",
  "change",
  "changePercent",
  "changeBasis",
  "tradingDate",
  "observedAt",
  "freshness",
  "source",
]);
const COVERAGE_KEYS = new Set(["requested", "available", "ratio", "complete"]);
const CARD_KEYS = new Set([
  "id",
  "kind",
  "channelId",
  "publisher",
  "revision",
  "state",
  "title",
  "targetId",
  "updatedAt",
  "retrievedAt",
  "requestedIndexIds",
  "missingIndexIds",
  "coverage",
  "observations",
]);
const SCHEDULE_KEYS = new Set([
  "feedId",
  "lastAttemptAt",
  "lastSuccessAt",
  "nextPollAt",
  "failures",
]);
const CONFIGURATION_KEYS = new Set([
  "feedId",
  "enabled",
  "discussionFrequency",
  "activeIntervalMs",
  "idleIntervalMs",
  "freshPollRequired",
]);
const CONFIGURATION_V2_KEYS = new Set([
  "feedId",
  "enabled",
  "activeIntervalMs",
  "idleIntervalMs",
  "freshPollRequired",
]);
const STATE_V1_KEYS = new Set(["version", "cards", "schedules"]);
const STATE_V2_KEYS = new Set(["version", "cards", "schedules", "configurations"]);
const STATE_V3_KEYS = new Set(["version", "cards", "schedules", "configurations"]);

const validAvatarImageUrl = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length >= 2 &&
  value.length <= 300 &&
  value.startsWith("/") &&
  !value.startsWith("//") &&
  !value.includes("\\") &&
  !/[\u0000-\u001f\u007f]/u.test(value);

const isPublisher = (value: unknown): value is ChannelFeedPublisher => {
  if (!isRecord(value) || !hasOnlyKeys(value, PUBLISHER_KEYS) ||
      !boundedText(value.id, 64, 2) || !CATALOG_ID.test(value.id) ||
      !boundedText(value.name, 80) || value.badge !== "BOT" ||
      !isRecord(value.avatar) || !hasOnlyKeys(value.avatar, AVATAR_KEYS)) return false;
  const avatar = value.avatar;
  return boundedText(avatar.color, 9, 4) && HEX_COLOR.test(avatar.color) &&
    boundedText(avatar.accent, 9, 4) && HEX_COLOR.test(avatar.accent) &&
    boundedText(avatar.glyph, 8) &&
    (avatar.imageUrl === undefined || validAvatarImageUrl(avatar.imageUrl));
};

const isSource = (value: unknown): value is ChannelFeedSource =>
  isRecord(value) && hasOnlyKeys(value, SOURCE_KEYS) &&
  boundedText(value.id, 96) && MACHINE_ID.test(value.id) &&
  boundedText(value.label, 160) &&
  publicCredentialFreeHttpsUrl(value.url) &&
  canonicalTimestamp(value.retrievedAt) &&
  typeof value.experimental === "boolean";

const isObservation = (value: unknown): value is MarketTickerFeedObservation => {
  if (!isRecord(value) || !hasOnlyKeys(value, OBSERVATION_KEYS) ||
      !boundedText(value.indexId, 96) || !MACHINE_ID.test(value.indexId) ||
      !boundedText(value.displayName, 160) || !boundedText(value.shortName, 80) ||
      typeof value.currency !== "string" || !CURRENCY.test(value.currency) ||
      !finiteNumber(value.level, Number.MIN_VALUE, 1_000_000_000) ||
      !finiteNumber(value.previousClose, Number.MIN_VALUE, 1_000_000_000) ||
      !finiteNumber(value.change, -1_000_000_000, 1_000_000_000) ||
      !finiteNumber(value.changePercent, -100, 100) || value.changeBasis !== "previous_close" ||
      !validTradingDate(value.tradingDate) || !canonicalTimestamp(value.observedAt) ||
      !["recent", "previous_session", "stale"].includes(String(value.freshness)) ||
      !isSource(value.source)) return false;
  const expectedChange = value.level - value.previousClose;
  const expectedPercent = expectedChange / value.previousClose * 100;
  const changeTolerance = Math.max(1e-8, Math.abs(expectedChange) * 1e-8);
  const percentTolerance = Math.max(1e-8, Math.abs(expectedPercent) * 1e-8);
  return Math.abs(value.change - expectedChange) <= changeTolerance &&
    Math.abs(value.changePercent - expectedPercent) <= percentTolerance &&
    Date.parse(value.observedAt) <= Date.parse(value.source.retrievedAt) + 5 * 60_000;
};

const isCoverage = (value: unknown): value is MarketTickerFeedCoverage =>
  isRecord(value) && hasOnlyKeys(value, COVERAGE_KEYS) &&
  safeInteger(value.requested, 1, MAX_ROWS_PER_CARD) &&
  safeInteger(value.available, 0, value.requested) &&
  finiteNumber(value.ratio, 0, 1) &&
  Math.abs(value.ratio - value.available / value.requested) <= Number.EPSILON * 8 &&
  typeof value.complete === "boolean" && value.complete === (value.available === value.requested);

const isMarketTickerCard = (value: unknown): value is MarketTickerFeedCard => {
  if (!isRecord(value) || !hasOnlyKeys(value, CARD_KEYS) ||
      !boundedText(value.id, 64, 2) || !CATALOG_ID.test(value.id) || value.kind !== "market_ticker" ||
      !boundedText(value.channelId, 64, 2) || !CATALOG_ID.test(value.channelId) ||
      !isPublisher(value.publisher) || !safeInteger(value.revision, 1, MAX_REVISION) ||
      !["ready", "partial", "unavailable"].includes(String(value.state)) ||
      !boundedText(value.title, 160) || !boundedText(value.targetId, 96) || !MACHINE_ID.test(value.targetId) ||
      !canonicalTimestamp(value.updatedAt) ||
      (value.retrievedAt !== undefined && !canonicalTimestamp(value.retrievedAt)) ||
      !Array.isArray(value.requestedIndexIds) || value.requestedIndexIds.length < 1 ||
      value.requestedIndexIds.length > MAX_ROWS_PER_CARD ||
      !value.requestedIndexIds.every((id) => boundedText(id, 96) && MACHINE_ID.test(id)) ||
      new Set(value.requestedIndexIds).size !== value.requestedIndexIds.length ||
      !Array.isArray(value.missingIndexIds) || value.missingIndexIds.length > MAX_ROWS_PER_CARD ||
      !value.missingIndexIds.every((id) => boundedText(id, 96) && MACHINE_ID.test(id)) ||
      new Set(value.missingIndexIds).size !== value.missingIndexIds.length ||
      !isCoverage(value.coverage) ||
      !Array.isArray(value.observations) || value.observations.length > MAX_ROWS_PER_CARD ||
      !value.observations.every(isObservation)) return false;

  const requested = new Set(value.requestedIndexIds);
  const observedIds = value.observations.map((observation) => observation.indexId);
  const observed = new Set(observedIds);
  const missing = new Set(value.missingIndexIds);
  const updatedAt = value.updatedAt;
  const updatedAtMs = Date.parse(updatedAt);
  const retrievedAtMs = value.retrievedAt === undefined ? undefined : Date.parse(value.retrievedAt);
  if (observed.size !== observedIds.length ||
      observedIds.some((id) => !requested.has(id)) ||
      value.missingIndexIds.some((id) => !requested.has(id) || observed.has(id)) ||
      observed.size + missing.size !== requested.size ||
      [...requested].some((id) => !observed.has(id) && !missing.has(id)) ||
      value.coverage.requested !== requested.size ||
      value.coverage.available !== observed.size ||
      (observed.size > 0) !== (value.retrievedAt !== undefined) ||
      (retrievedAtMs !== undefined && retrievedAtMs > updatedAtMs) ||
      value.observations.some((observation) => {
        const observedAtMs = Date.parse(observation.observedAt);
        const sourceRetrievedAtMs = Date.parse(observation.source.retrievedAt);
        return !isStructurallyAcceptableMarketInstant(observedAtMs, updatedAtMs) ||
          classifyMarketFreshness(observedAtMs, updatedAtMs) !== observation.freshness ||
          sourceRetrievedAtMs > updatedAtMs + 5 * 60_000 ||
          (retrievedAtMs !== undefined && sourceRetrievedAtMs > retrievedAtMs + 5 * 60_000);
      })) return false;
  if (value.state === "ready" && !value.coverage.complete) return false;
  if (value.state === "partial" && (value.coverage.complete || value.coverage.available === 0)) return false;
  return true;
};

const isCard = (value: unknown): value is ChannelFeedCard =>
  isRecord(value) && value.kind === "market_ticker" && isMarketTickerCard(value);

const isSchedule = (value: unknown): value is ChannelFeedScheduleState => {
  if (!isRecord(value) || !hasOnlyKeys(value, SCHEDULE_KEYS) ||
      !boundedText(value.feedId, 64, 2) || !CATALOG_ID.test(value.feedId) ||
      (value.lastAttemptAt !== undefined && !safeInstant(value.lastAttemptAt)) ||
      (value.lastSuccessAt !== undefined && !safeInstant(value.lastSuccessAt)) ||
      !safeInstant(value.nextPollAt) || !safeInteger(value.failures, 0, MAX_FAILURES)) return false;
  if (value.lastSuccessAt !== undefined && (
    value.lastAttemptAt === undefined || value.lastSuccessAt > value.lastAttemptAt
  )) return false;
  return value.lastAttemptAt === undefined || value.nextPollAt >= value.lastAttemptAt;
};

const isConfiguration = (value: unknown): value is ChannelFeedRuntimeConfiguration =>
  isRecord(value) && hasOnlyKeys(value, CONFIGURATION_KEYS) &&
  boundedText(value.feedId, 64, 2) && CATALOG_ID.test(value.feedId) &&
  typeof value.enabled === "boolean" &&
  safeInteger(value.discussionFrequency, 0, 100) &&
  safeInteger(value.activeIntervalMs, MIN_RUNTIME_INTERVAL_MS, MAX_RUNTIME_INTERVAL_MS) &&
  safeInteger(value.idleIntervalMs, value.activeIntervalMs, MAX_RUNTIME_INTERVAL_MS) &&
  typeof value.freshPollRequired === "boolean" &&
  (value.enabled || value.freshPollRequired);

type LegacyChannelFeedRuntimeConfiguration = Omit<
  ChannelFeedRuntimeConfiguration,
  "discussionFrequency"
>;

const isLegacyConfiguration = (value: unknown): value is LegacyChannelFeedRuntimeConfiguration =>
  isRecord(value) && hasOnlyKeys(value, CONFIGURATION_V2_KEYS) &&
  boundedText(value.feedId, 64, 2) && CATALOG_ID.test(value.feedId) &&
  typeof value.enabled === "boolean" &&
  safeInteger(value.activeIntervalMs, MIN_RUNTIME_INTERVAL_MS, MAX_RUNTIME_INTERVAL_MS) &&
  safeInteger(value.idleIntervalMs, value.activeIntervalMs, MAX_RUNTIME_INTERVAL_MS) &&
  typeof value.freshPollRequired === "boolean" &&
  (value.enabled || value.freshPollRequired);

const isStoredConfiguration = (value: unknown): value is ChannelFeedStoredConfiguration =>
  isConfiguration(value) || isLegacyConfiguration(value);

interface ParsedChannelFeedState {
  cards: ChannelFeedCard[];
  schedules: ChannelFeedScheduleState[];
  configurations: ChannelFeedStoredConfiguration[];
}

const parseState = (value: unknown): ParsedChannelFeedState => {
  if (!isRecord(value)) {
    throw new TypeError("Invalid channel feed persistence payload.");
  }
  const versionOne = value.version === 1 && hasOnlyKeys(value, STATE_V1_KEYS);
  const versionTwo = value.version === 2 && hasOnlyKeys(value, STATE_V2_KEYS);
  const versionThree = value.version === 3 && hasOnlyKeys(value, STATE_V3_KEYS);
  if ((!versionOne && !versionTwo && !versionThree) ||
      !Array.isArray(value.cards) || value.cards.length > MAX_CARDS || !value.cards.every(isCard) ||
      !Array.isArray(value.schedules) || value.schedules.length > MAX_CARDS || !value.schedules.every(isSchedule) ||
      (versionTwo && (!Array.isArray(value.configurations) ||
        value.configurations.length > MAX_CARDS || !value.configurations.every(isLegacyConfiguration))) ||
      (versionThree && (!Array.isArray(value.configurations) ||
        value.configurations.length > MAX_CARDS || !value.configurations.every(isStoredConfiguration)))) {
    throw new TypeError("Invalid channel feed persistence payload.");
  }
  const cards = value.cards as ChannelFeedCard[];
  const schedules = value.schedules as ChannelFeedScheduleState[];
  const configurations: ChannelFeedStoredConfiguration[] = versionThree
    ? value.configurations as ChannelFeedStoredConfiguration[]
    : versionTwo
      ? value.configurations as LegacyChannelFeedRuntimeConfiguration[]
      : [];
  if (new Set(cards.map((card) => card.id)).size !== cards.length ||
      new Set(schedules.map((schedule) => schedule.feedId)).size !== schedules.length ||
      new Set(configurations.map((configuration) => configuration.feedId)).size !== configurations.length) {
    throw new TypeError("Channel feed persistence contains duplicate IDs.");
  }
  return clone({ cards, schedules, configurations });
};

const validateDraft = (draft: ChannelFeedCardDraft): ChannelFeedCardDraft => {
  const candidate = { ...clone(draft), revision: 1 } as ChannelFeedCard;
  if (!isCard(candidate)) throw new TypeError("Invalid channel feed card draft.");
  return clone(draft);
};

const validatePollTiming = (timing: ChannelFeedPollTiming): ChannelFeedPollTiming => {
  if (!safeInstant(timing.attemptedAt) || !safeInstant(timing.nextPollAt) ||
      timing.nextPollAt < timing.attemptedAt) {
    throw new TypeError("Invalid channel feed poll timing.");
  }
  return { ...timing };
};

const validateConfiguration = (
  configuration: ChannelFeedRuntimeConfiguration,
): ChannelFeedRuntimeConfiguration => {
  if (!isConfiguration(configuration)) {
    throw new TypeError("Invalid channel feed runtime configuration.");
  }
  return clone(configuration);
};

const stableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, stableJsonValue(value[key])]),
  );
};

/**
 * `updatedAt` describes when a presentation state was first published. It is
 * deliberately excluded here so repeated provider failures cannot manufacture
 * revisions merely because another attempt happened later.
 */
const semanticCardKey = (card: ChannelFeedCard | ChannelFeedCardDraft): string => {
  const record = clone(card) as unknown as JsonRecord;
  delete record.revision;
  delete record.updatedAt;
  return JSON.stringify(stableJsonValue(record));
};

const assertNewerAttempt = (
  schedule: ChannelFeedScheduleState | undefined,
  timing: ChannelFeedPollTiming,
): void => {
  if (schedule?.lastAttemptAt !== undefined && timing.attemptedAt <= schedule.lastAttemptAt) {
    throw new TypeError("Channel feed attempts must advance monotonically.");
  }
};

const stateFrom = (
  cards: ReadonlyMap<string, ChannelFeedCard>,
  schedules: ReadonlyMap<string, ChannelFeedScheduleState>,
  configurations: ReadonlyMap<string, ChannelFeedStoredConfiguration>,
): ChannelFeedPersistedState => {
  const cardRows = [...cards.values()].map(clone).sort((left, right) => left.id.localeCompare(right.id));
  const scheduleRows = [...schedules.values()].map(clone).sort((left, right) => left.feedId.localeCompare(right.feedId));
  const configurationRows = [...configurations.values()]
    .map(clone)
    .sort((left, right) => left.feedId.localeCompare(right.feedId));
  return { version: 3, cards: cardRows, schedules: scheduleRows, configurations: configurationRows };
};

/**
 * Durable mutable feed cards, intentionally isolated from RoomStore history.
 * Every mutation is persisted before it becomes visible through this object.
 */
export class ChannelFeedStore {
  private readonly persistence: ChannelFeedPersistence;
  private cardById = new Map<string, ChannelFeedCard>();
  private scheduleByFeedId = new Map<string, ChannelFeedScheduleState>();
  private configurationByFeedId = new Map<string, ChannelFeedStoredConfiguration>();
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: ChannelFeedStoreOptions = {}) {
    this.persistence = options.persistence ?? new JsonFileChannelFeedPersistence(
      resolve(options.filePath ?? process.env.CHANNEL_FEED_STATE_PATH ?? "./data/channel-feed-state.json"),
    );
  }

  async load(): Promise<void> {
    try {
      const raw = await this.persistence.load();
      if (raw === undefined) {
        this.cardById.clear();
        this.scheduleByFeedId.clear();
        this.configurationByFeedId.clear();
        return;
      }
      const restored = parseState(raw);
      this.cardById = new Map(restored.cards.map((card) => [card.id, clone(card)]));
      this.scheduleByFeedId = new Map(restored.schedules.map((schedule) => [schedule.feedId, clone(schedule)]));
      this.configurationByFeedId = new Map(
        restored.configurations.map((configuration) => [configuration.feedId, clone(configuration)]),
      );
    } catch (error) {
      this.cardById.clear();
      this.scheduleByFeedId.clear();
      this.configurationByFeedId.clear();
      throw error instanceof ChannelFeedStateLoadError ? error : new ChannelFeedStateLoadError(error);
    }
  }

  cards(): ChannelFeedCard[] {
    return [...this.cardById.values()].map(clone).sort((left, right) => left.id.localeCompare(right.id));
  }

  getCard(feedId: string): ChannelFeedCard | undefined {
    const card = this.cardById.get(feedId);
    return card ? clone(card) : undefined;
  }

  schedule(feedId: string): ChannelFeedScheduleState | undefined {
    const schedule = this.scheduleByFeedId.get(feedId);
    return schedule ? clone(schedule) : undefined;
  }

  schedules(): ChannelFeedScheduleState[] {
    return [...this.scheduleByFeedId.values()].map(clone).sort((left, right) => left.feedId.localeCompare(right.feedId));
  }

  configuration(feedId: string): ChannelFeedStoredConfiguration | undefined {
    const configuration = this.configurationByFeedId.get(feedId);
    return configuration ? clone(configuration) : undefined;
  }

  configurations(): ChannelFeedStoredConfiguration[] {
    return [...this.configurationByFeedId.values()]
      .map(clone)
      .sort((left, right) => left.feedId.localeCompare(right.feedId));
  }

  async publishSuccess(
    feedId: string,
    rawDraft: ChannelFeedCardDraft,
    rawTiming: ChannelFeedPollTiming,
  ): Promise<ChannelFeedCard> {
    return this.mutate(async () => {
      const draft = validateDraft(rawDraft);
      const timing = validatePollTiming(rawTiming);
      if (feedId !== draft.id || !CATALOG_ID.test(feedId)) {
        throw new TypeError("A feed result must use its registered feed ID.");
      }
      if (draft.state === "unavailable") {
        throw new TypeError("A successful feed result cannot be unavailable.");
      }
      if (this.cardById.size >= MAX_CARDS && !this.cardById.has(feedId)) {
        throw new RangeError("Channel feed card retention is full.");
      }
      assertNewerAttempt(this.scheduleByFeedId.get(feedId), timing);
      const previous = this.cardById.get(feedId);
      if ((previous?.revision ?? 0) >= MAX_REVISION) throw new RangeError("Channel feed revision exhausted.");
      const card = { ...draft, revision: (previous?.revision ?? 0) + 1 } as ChannelFeedCard;
      if (!isCard(card)) throw new TypeError("Invalid channel feed card.");
      const schedule: ChannelFeedScheduleState = {
        feedId,
        lastAttemptAt: timing.attemptedAt,
        lastSuccessAt: timing.attemptedAt,
        nextPollAt: timing.nextPollAt,
        failures: 0,
      };
      const cards = new Map(this.cardById);
      const schedules = new Map(this.scheduleByFeedId);
      const configurations = new Map(this.configurationByFeedId);
      cards.set(feedId, clone(card));
      schedules.set(feedId, schedule);
      const configuration = configurations.get(feedId);
      if (configuration?.enabled && configuration.freshPollRequired) {
        configurations.set(feedId, { ...configuration, freshPollRequired: false });
      }
      await this.persistence.save(stateFrom(cards, schedules, configurations));
      this.cardById = cards;
      this.scheduleByFeedId = schedules;
      this.configurationByFeedId = configurations;
      return clone(card);
    });
  }

  async publishFailure(
    feedId: string,
    rawTiming: ChannelFeedPollTiming,
    rawUnavailableDraft?: ChannelFeedCardDraft,
  ): Promise<{ card?: ChannelFeedCard; cardChanged: boolean; schedule: ChannelFeedScheduleState }> {
    return this.mutate(async () => {
      const timing = validatePollTiming(rawTiming);
      if (!boundedText(feedId, 64, 2) || !CATALOG_ID.test(feedId)) {
        throw new TypeError("Invalid channel feed ID.");
      }
      const previousSchedule = this.scheduleByFeedId.get(feedId);
      const previousCard = this.cardById.get(feedId);
      assertNewerAttempt(previousSchedule, timing);
      const unavailableDraft = rawUnavailableDraft === undefined
        ? undefined
        : validateDraft(rawUnavailableDraft);
      if (unavailableDraft && (unavailableDraft.id !== feedId || unavailableDraft.state !== "unavailable")) {
        throw new TypeError("A failed feed result must use an unavailable draft for its registered feed ID.");
      }
      if (!previousSchedule && this.scheduleByFeedId.size >= MAX_CARDS) {
        throw new RangeError("Channel feed schedule retention is full.");
      }
      if (unavailableDraft && !previousCard && this.cardById.size >= MAX_CARDS) {
        throw new RangeError("Channel feed card retention is full.");
      }
      const schedule: ChannelFeedScheduleState = {
        feedId,
        lastAttemptAt: timing.attemptedAt,
        ...(previousSchedule?.lastSuccessAt !== undefined
          ? { lastSuccessAt: previousSchedule.lastSuccessAt }
          : {}),
        nextPollAt: timing.nextPollAt,
        failures: Math.min(MAX_FAILURES, (previousSchedule?.failures ?? 0) + 1),
      };
      let card: ChannelFeedCard | undefined;
      let cardChanged = false;
      if (unavailableDraft) {
        cardChanged = !previousCard || semanticCardKey(previousCard) !== semanticCardKey(unavailableDraft);
        if (cardChanged) {
          if ((previousCard?.revision ?? 0) >= MAX_REVISION) {
            throw new RangeError("Channel feed revision exhausted.");
          }
          card = {
            ...unavailableDraft,
            revision: (previousCard?.revision ?? 0) + 1,
          } as ChannelFeedCard;
          if (!isCard(card)) throw new TypeError("Invalid unavailable channel feed card.");
        } else {
          card = clone(previousCard);
        }
      } else if (previousCard && previousCard.state !== "unavailable") {
        if (previousCard.revision >= MAX_REVISION) throw new RangeError("Channel feed revision exhausted.");
        cardChanged = true;
        // Domain adapters should normally provide a sanitized unavailable
        // draft. The generic fallback keeps the prior content timestamp so it
        // cannot relabel retained observations without revalidating them.
        card = {
          ...clone(previousCard),
          revision: previousCard.revision + 1,
          state: "unavailable",
        };
        if (!isCard(card)) throw new TypeError("Invalid unavailable channel feed card.");
      } else if (previousCard) {
        card = clone(previousCard);
      }
      const cards = new Map(this.cardById);
      const schedules = new Map(this.scheduleByFeedId);
      const configurations = new Map(this.configurationByFeedId);
      if (card) cards.set(feedId, clone(card));
      schedules.set(feedId, schedule);
      const configuration = configurations.get(feedId);
      if (unavailableDraft && configuration?.enabled && configuration.freshPollRequired) {
        configurations.set(feedId, { ...configuration, freshPollRequired: false });
      }
      await this.persistence.save(stateFrom(cards, schedules, configurations));
      this.cardById = cards;
      this.scheduleByFeedId = schedules;
      this.configurationByFeedId = configurations;
      return { ...(card ? { card: clone(card) } : {}), cardChanged, schedule: clone(schedule) };
    });
  }

  /** Records a healthy no-change poll without creating a fake UI revision. */
  async publishUnchanged(
    feedId: string,
    rawTiming: ChannelFeedPollTiming,
  ): Promise<ChannelFeedScheduleState> {
    return this.mutate(async () => {
      const timing = validatePollTiming(rawTiming);
      if (!this.cardById.has(feedId)) {
        throw new TypeError("An unchanged feed result requires an existing card.");
      }
      assertNewerAttempt(this.scheduleByFeedId.get(feedId), timing);
      const schedule: ChannelFeedScheduleState = {
        feedId,
        lastAttemptAt: timing.attemptedAt,
        lastSuccessAt: timing.attemptedAt,
        nextPollAt: timing.nextPollAt,
        failures: 0,
      };
      const schedules = new Map(this.scheduleByFeedId);
      const configurations = new Map(this.configurationByFeedId);
      schedules.set(feedId, schedule);
      const configuration = configurations.get(feedId);
      if (configuration?.enabled && configuration.freshPollRequired) {
        configurations.set(feedId, { ...configuration, freshPollRequired: false });
      }
      await this.persistence.save(stateFrom(this.cardById, schedules, configurations));
      this.scheduleByFeedId = schedules;
      this.configurationByFeedId = configurations;
      return clone(schedule);
    });
  }

  /**
   * Atomically persists operator configuration and, when supplied, an exact
   * replacement due time. Unlike activity acceleration this path may move a
   * poll later as well as earlier because the operator changed its cadence.
   */
  async configure(
    feedId: string,
    rawConfiguration: ChannelFeedRuntimeConfiguration,
    nextPollAt?: number,
    interruptedAttemptAt?: number,
  ): Promise<{
    configuration: ChannelFeedRuntimeConfiguration;
    schedule?: ChannelFeedScheduleState;
  }> {
    return this.mutate(async () => {
      const configuration = validateConfiguration(rawConfiguration);
      if (feedId !== configuration.feedId || !CATALOG_ID.test(feedId)) {
        throw new TypeError("A feed configuration must use its registered feed ID.");
      }
      if (nextPollAt !== undefined && !safeInstant(nextPollAt)) {
        throw new TypeError("Invalid channel feed configuration due time.");
      }
      if (interruptedAttemptAt !== undefined && !safeInstant(interruptedAttemptAt)) {
        throw new TypeError("Invalid interrupted channel feed attempt time.");
      }
      const previousSchedule = this.scheduleByFeedId.get(feedId);
      const effectiveAttemptAt = interruptedAttemptAt === undefined
        ? previousSchedule?.lastAttemptAt
        : Math.max(previousSchedule?.lastAttemptAt ?? 0, interruptedAttemptAt);
      if (nextPollAt !== undefined && effectiveAttemptAt !== undefined && nextPollAt < effectiveAttemptAt) {
        throw new TypeError("A channel feed cannot be configured before its last attempt.");
      }
      if (!this.configurationByFeedId.has(feedId) && this.configurationByFeedId.size >= MAX_CARDS) {
        throw new RangeError("Channel feed configuration retention is full.");
      }
      if (nextPollAt !== undefined && !previousSchedule && this.scheduleByFeedId.size >= MAX_CARDS) {
        throw new RangeError("Channel feed schedule retention is full.");
      }
      const configurations = new Map(this.configurationByFeedId);
      configurations.set(feedId, configuration);
      const schedules = new Map(this.scheduleByFeedId);
      const schedule = nextPollAt === undefined
        ? previousSchedule
        : previousSchedule
          ? {
              ...clone(previousSchedule),
              ...(effectiveAttemptAt !== undefined ? { lastAttemptAt: effectiveAttemptAt } : {}),
              nextPollAt,
            }
          : {
              feedId,
              ...(effectiveAttemptAt !== undefined ? { lastAttemptAt: effectiveAttemptAt } : {}),
              nextPollAt,
              failures: 0,
            };
      if (schedule && !isSchedule(schedule)) {
        throw new TypeError("Invalid channel feed configuration schedule.");
      }
      if (schedule) schedules.set(feedId, schedule);
      await this.persistence.save(stateFrom(this.cardById, schedules, configurations));
      this.configurationByFeedId = configurations;
      this.scheduleByFeedId = schedules;
      return {
        configuration: clone(configuration),
        ...(schedule ? { schedule: clone(schedule) } : {}),
      };
    });
  }

  /**
   * Pulls a feed's due time forward after channel activity without pretending
   * a provider was contacted. A later due time can never postpone existing
   * work through this path.
   */
  async reschedule(feedId: string, nextPollAt: number): Promise<ChannelFeedScheduleState> {
    return this.mutate(async () => {
      if (!boundedText(feedId, 64, 2) || !CATALOG_ID.test(feedId) || !safeInstant(nextPollAt)) {
        throw new TypeError("Invalid channel feed reschedule request.");
      }
      const previous = this.scheduleByFeedId.get(feedId);
      if (!previous && this.scheduleByFeedId.size >= MAX_CARDS) {
        throw new RangeError("Channel feed schedule retention is full.");
      }
      const schedule: ChannelFeedScheduleState = previous
        ? { ...clone(previous), nextPollAt: Math.min(previous.nextPollAt, nextPollAt) }
        : { feedId, nextPollAt, failures: 0 };
      if (!isSchedule(schedule)) {
        throw new TypeError("A channel feed cannot be rescheduled before its last attempt.");
      }
      if (previous && schedule.nextPollAt === previous.nextPollAt) return clone(previous);
      const schedules = new Map(this.scheduleByFeedId);
      schedules.set(feedId, schedule);
      await this.persistence.save(stateFrom(this.cardById, schedules, this.configurationByFeedId));
      this.scheduleByFeedId = schedules;
      return clone(schedule);
    });
  }

  async remove(feedId: string): Promise<boolean> {
    return this.mutate(async () => {
      if (!this.cardById.has(feedId) && !this.scheduleByFeedId.has(feedId) &&
          !this.configurationByFeedId.has(feedId)) return false;
      const cards = new Map(this.cardById);
      const schedules = new Map(this.scheduleByFeedId);
      const configurations = new Map(this.configurationByFeedId);
      cards.delete(feedId);
      schedules.delete(feedId);
      configurations.delete(feedId);
      await this.persistence.save(stateFrom(cards, schedules, configurations));
      this.cardById = cards;
      this.scheduleByFeedId = schedules;
      this.configurationByFeedId = configurations;
      return true;
    });
  }

  async flush(): Promise<void> {
    await this.mutationQueue;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutationQueue.then(operation, operation);
    this.mutationQueue = pending.catch(() => undefined);
    return pending;
  }
}
