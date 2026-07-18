import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { stripDangerousTextControls, unicodeCaselessKey } from "../shared/unicodeSafety.js";
import { validatePublicHttpsUrl } from "./safeHttpsFetch.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const SAFE_ID = /^[\p{L}\p{M}\p{N}_.:@-]{1,160}$/u;

export const AMBIENT_EPISODE_LEDGER_DEFAULTS = Object.freeze({
  activeTtlMs: 2 * HOUR_MS,
  retentionMs: 14 * DAY_MS,
  callbackTtlMs: 7 * DAY_MS,
  semanticCooldownMs: 6 * HOUR_MS,
  relevanceHalfLifeMs: 36 * HOUR_MS,
  maxChannels: 64,
  maxRecentEpisodesPerChannel: 48,
  maxSemanticRecencyEntriesPerChannel: 96,
  maxFacetsPerEpisode: 12,
  maxEntitiesPerEpisode: 12,
  maxStancesPerEpisode: 16,
  maxHooksPerEpisode: 12,
  maxSourceUrlsPerEpisode: 8,
  maxParticipantsPerEpisode: 32,
  maxWitnessesPerEpisode: 32,
  maxMessageIdsPerEpisode: 80,
  maxUsedCallbacksPerEpisode: 12,
  maxOperationIdsPerEpisode: 64,
  persistDelayMs: 250,
} as const);

const HARD_LIMITS = Object.freeze({
  maxChannels: 128,
  maxRecentEpisodesPerChannel: 96,
  maxSemanticRecencyEntriesPerChannel: 96,
  maxFacetsPerEpisode: 24,
  maxEntitiesPerEpisode: 24,
  maxStancesPerEpisode: 32,
  maxHooksPerEpisode: 24,
  maxSourceUrlsPerEpisode: 16,
  maxParticipantsPerEpisode: 64,
  maxWitnessesPerEpisode: 64,
  maxMessageIdsPerEpisode: 160,
  maxUsedCallbacksPerEpisode: 24,
  maxOperationIdsPerEpisode: 128,
});

export type AmbientEpisodeStatus = "current" | "closed";
export type AmbientEpisodeHookStatus = "open" | "resolved" | "abandoned";

/**
 * Compact semantic metadata only. `semanticKey` is an opaque, classifier- or
 * server-owned label; it is never interpreted with language-specific rules.
 */
export interface AmbientEpisodeStance {
  actorId: string;
  semanticKey: string;
  sourceMessageIds: string[];
  updatedAt: number;
}

/**
 * An unresolved conversational obligation/reference. The room store remains
 * authoritative for words, authors and reply structure; this record retains
 * provenance IDs only and deliberately has no free-text payload.
 */
export interface AmbientEpisodeHook {
  id: string;
  semanticKey?: string;
  sourceMessageIds: string[];
  status: AmbientEpisodeHookStatus;
  createdAt: number;
  resolvedAt?: number;
}

export interface AmbientEpisodeUsedCallback {
  callbackId: string;
  sourceEpisodeId: string;
  sourceMessageIds: string[];
  usedAt: number;
}

export interface AmbientEpisode {
  id: string;
  channelId: string;
  semanticFamily: string;
  semanticKey: string;
  sourceKind: string;
  causalRootId: string;
  facets: string[];
  entities: string[];
  stances: AmbientEpisodeStance[];
  sourceUrls: string[];
  hooks: AmbientEpisodeHook[];
  participantIds: string[];
  witnessIds: string[];
  messageIds: string[];
  usedCallbacks: AmbientEpisodeUsedCallback[];
  status: AmbientEpisodeStatus;
  openedAt: number;
  lastActivityAt: number;
  closedAt?: number;
  closeReason?: string;
  cooldownUntil?: number;
}

interface StoredAmbientEpisode extends AmbientEpisode {
  operationIds: string[];
}

export interface AmbientSemanticRecencyEntry {
  semanticFamily: string;
  semanticKey: string;
  lastPublishedAt: number;
}

interface StoredAmbientChannel {
  channelId: string;
  current?: StoredAmbientEpisode;
  recent: StoredAmbientEpisode[];
  semanticRecency: AmbientSemanticRecencyEntry[];
}

export interface AmbientEpisodePersistedState {
  version: 1;
  channels: Array<{
    channelId: string;
    current?: AmbientEpisode & { operationIds: string[] };
    recent: Array<AmbientEpisode & { operationIds: string[] }>;
    /** Optional so existing version-1 JSON remains valid and is migrated on load. */
    semanticRecency?: AmbientSemanticRecencyEntry[];
  }>;
}

export interface AmbientEpisodePersistence {
  load(): Promise<unknown | undefined>;
  save(state: AmbientEpisodePersistedState): Promise<void>;
}

export class MemoryAmbientEpisodePersistence implements AmbientEpisodePersistence {
  private value?: AmbientEpisodePersistedState;

  async load(): Promise<unknown | undefined> {
    return this.value ? structuredClone(this.value) : undefined;
  }

  async save(state: AmbientEpisodePersistedState): Promise<void> {
    this.value = structuredClone(state);
  }
}

/** Atomic, size-bounded JSON persistence for a process-local deployment. */
export class JsonFileAmbientEpisodePersistence implements AmbientEpisodePersistence {
  constructor(private readonly path: string) {}

  async load(): Promise<unknown | undefined> {
    try {
      const metadata = await stat(this.path);
      if (!metadata.isFile() || metadata.size > MAX_STATE_BYTES) return undefined;
      return JSON.parse(await readFile(this.path, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }

  async save(state: AmbientEpisodePersistedState): Promise<void> {
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(payload) > MAX_STATE_BYTES) {
      throw new Error("Ambient episode state exceeded its persistence bound");
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

export interface AmbientEpisodeLedgerOptions {
  persistence?: AmbientEpisodePersistence;
  now?: () => number;
  activeTtlMs?: number;
  retentionMs?: number;
  callbackTtlMs?: number;
  semanticCooldownMs?: number;
  relevanceHalfLifeMs?: number;
  maxChannels?: number;
  maxRecentEpisodesPerChannel?: number;
  maxSemanticRecencyEntriesPerChannel?: number;
  maxFacetsPerEpisode?: number;
  maxEntitiesPerEpisode?: number;
  maxStancesPerEpisode?: number;
  maxHooksPerEpisode?: number;
  maxSourceUrlsPerEpisode?: number;
  maxParticipantsPerEpisode?: number;
  maxWitnessesPerEpisode?: number;
  maxMessageIdsPerEpisode?: number;
  maxUsedCallbacksPerEpisode?: number;
  maxOperationIdsPerEpisode?: number;
  persistDelayMs?: number;
}

export interface AmbientEpisodeStanceInput {
  actorId: string;
  semanticKey: string;
  sourceMessageIds: readonly string[];
  updatedAt?: number;
}

export interface AmbientEpisodeHookInput {
  id: string;
  semanticKey?: string;
  sourceMessageIds: readonly string[];
  createdAt?: number;
}

export interface OpenAmbientEpisodeInput {
  id: string;
  channelId: string;
  semanticFamily: string;
  semanticKey: string;
  sourceKind: string;
  causalRootId?: string;
  facets?: readonly string[];
  entities?: readonly string[];
  stances?: readonly AmbientEpisodeStanceInput[];
  sourceUrls?: readonly string[];
  hooks?: readonly AmbientEpisodeHookInput[];
  participantIds?: readonly string[];
  witnessIds?: readonly string[];
  messageIds?: readonly string[];
  openedAt?: number;
  operationId?: string;
}

export interface UpdateAmbientEpisodeInput {
  facets?: readonly string[];
  entities?: readonly string[];
  stances?: readonly AmbientEpisodeStanceInput[];
  sourceUrls?: readonly string[];
  hooks?: readonly AmbientEpisodeHookInput[];
  resolveHookIds?: readonly string[];
  abandonHookIds?: readonly string[];
  participantIds?: readonly string[];
  witnessIds?: readonly string[];
  messageIds?: readonly string[];
  activityAt?: number;
  operationId?: string;
}

export interface CloseAmbientEpisodeOptions {
  closedAt?: number;
  cooldownMs?: number;
  operationId?: string;
}

export interface AmbientEpisodeRecallCandidate {
  episode: AmbientEpisode;
  ageMs: number;
  relevance: number;
}

export interface AmbientEpisodeCallbackCandidate {
  sourceEpisodeId: string;
  semanticFamily: string;
  semanticKey: string;
  causalRootId: string;
  hook: AmbientEpisodeHook;
  ageMs: number;
  relevance: number;
}

export interface AmbientEpisodePruneResult {
  episodesClosed: number;
  episodesRemoved: number;
  channelsRemoved: number;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const finiteNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const positiveDuration = (value: unknown, fallback: number): number =>
  Math.max(1, Math.floor(finiteNumber(value, fallback)));

const boundedCount = (value: unknown, fallback: number, hardMaximum: number): number =>
  Math.max(1, Math.min(hardMaximum, Math.floor(finiteNumber(value, fallback))));

const safeTimestamp = (value: unknown, fallback: number): number =>
  Math.max(0, finiteNumber(value, fallback));

const safeId = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = stripDangerousTextControls(value.normalize("NFKC")).trim();
  return SAFE_ID.test(normalized) ? normalized : undefined;
};

const safeSemantic = (value: unknown, maximum = 160): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = stripDangerousTextControls(value.normalize("NFKC"))
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum);
  return normalized && /[\p{L}\p{N}]/u.test(normalized) ? normalized : undefined;
};

const semanticIdentity = (value: string): string => unicodeCaselessKey(value);

const boundedUnique = <T>(
  values: readonly T[],
  maximum: number,
  normalize: (value: T) => string | undefined,
  existing: readonly string[] = [],
  identity: (value: string) => string = (value) => value,
): string[] => {
  const output = [...existing];
  const seen = new Set(existing.map(identity));
  for (const raw of values) {
    const normalized = normalize(raw);
    if (!normalized) continue;
    const key = identity(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= maximum) break;
  }
  return output.slice(0, maximum);
};

const safeIds = (values: unknown, maximum: number, existing: readonly string[] = []): string[] =>
  boundedUnique(Array.isArray(values) ? values : [], maximum, safeId, existing);

const safeSemantics = (values: unknown, maximum: number, existing: readonly string[] = []): string[] =>
  boundedUnique(
    Array.isArray(values) ? values : [],
    maximum,
    (value) => safeSemantic(value),
    existing,
    semanticIdentity,
  );

const canonicalSourceUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const url = validatePublicHttpsUrl(value);
  if (!url) return undefined;
  url.hash = "";
  url.searchParams.sort();
  return url.toString();
};

const safeSourceUrls = (values: unknown, maximum: number, existing: readonly string[] = []): string[] =>
  boundedUnique(Array.isArray(values) ? values : [], maximum, canonicalSourceUrl, existing);

const cloneStance = (stance: AmbientEpisodeStance): AmbientEpisodeStance => ({
  ...stance,
  sourceMessageIds: [...stance.sourceMessageIds],
});

const cloneHook = (hook: AmbientEpisodeHook): AmbientEpisodeHook => ({
  ...hook,
  sourceMessageIds: [...hook.sourceMessageIds],
});

const cloneCallback = (callback: AmbientEpisodeUsedCallback): AmbientEpisodeUsedCallback => ({
  ...callback,
  sourceMessageIds: [...callback.sourceMessageIds],
});

const snapshot = (episode: StoredAmbientEpisode): AmbientEpisode => ({
  id: episode.id,
  channelId: episode.channelId,
  semanticFamily: episode.semanticFamily,
  semanticKey: episode.semanticKey,
  sourceKind: episode.sourceKind,
  causalRootId: episode.causalRootId,
  facets: [...episode.facets],
  entities: [...episode.entities],
  stances: episode.stances.map(cloneStance),
  sourceUrls: [...episode.sourceUrls],
  hooks: episode.hooks.map(cloneHook),
  participantIds: [...episode.participantIds],
  witnessIds: [...episode.witnessIds],
  messageIds: [...episode.messageIds],
  usedCallbacks: episode.usedCallbacks.map(cloneCallback),
  status: episode.status,
  openedAt: episode.openedAt,
  lastActivityAt: episode.lastActivityAt,
  ...(episode.closedAt !== undefined ? { closedAt: episode.closedAt } : {}),
  ...(episode.closeReason !== undefined ? { closeReason: episode.closeReason } : {}),
  ...(episode.cooldownUntil !== undefined ? { cooldownUntil: episode.cooldownUntil } : {}),
});

const compareRecent = (left: StoredAmbientEpisode, right: StoredAmbientEpisode): number =>
  (right.closedAt ?? right.lastActivityAt) - (left.closedAt ?? left.lastActivityAt) ||
  right.lastActivityAt - left.lastActivityAt ||
  left.id.localeCompare(right.id);

const compareSemanticRecency = (
  left: AmbientSemanticRecencyEntry,
  right: AmbientSemanticRecencyEntry,
): number =>
  right.lastPublishedAt - left.lastPublishedAt ||
  semanticIdentity(left.semanticFamily).localeCompare(semanticIdentity(right.semanticFamily)) ||
  semanticIdentity(left.semanticKey).localeCompare(semanticIdentity(right.semanticKey));

const semanticRecencyIdentity = (
  semanticFamily: string,
  semanticKey: string,
): string => `${semanticIdentity(semanticFamily)}\u241f${semanticIdentity(semanticKey)}`;

const AUTHORED_NOVELTY_SOURCE_KINDS = new Set([
  "room_seed",
  "autonomous_research",
  // Backward compatibility for ledgers written before room_seed was named.
  "idle_seed",
]);

const contributesAuthoredNovelty = (sourceKind: string): boolean =>
  AUTHORED_NOVELTY_SOURCE_KINDS.has(semanticIdentity(sourceKind));

/**
 * Persistent, bounded metadata for ambient conversation episodes. It never
 * stores message bodies, reply previews, reactions or member snapshots; the
 * normal room store remains the only authority for chat history.
 */
export class AmbientEpisodeLedger {
  private readonly persistence: AmbientEpisodePersistence;
  private readonly now: () => number;
  private readonly activeTtlMs: number;
  private readonly retentionMs: number;
  private readonly callbackTtlMs: number;
  private readonly semanticCooldownMs: number;
  private readonly relevanceHalfLifeMs: number;
  private readonly maxChannels: number;
  private readonly maxRecentEpisodesPerChannel: number;
  private readonly maxSemanticRecencyEntriesPerChannel: number;
  private readonly maxFacetsPerEpisode: number;
  private readonly maxEntitiesPerEpisode: number;
  private readonly maxStancesPerEpisode: number;
  private readonly maxHooksPerEpisode: number;
  private readonly maxSourceUrlsPerEpisode: number;
  private readonly maxParticipantsPerEpisode: number;
  private readonly maxWitnessesPerEpisode: number;
  private readonly maxMessageIdsPerEpisode: number;
  private readonly maxUsedCallbacksPerEpisode: number;
  private readonly maxOperationIdsPerEpisode: number;
  private readonly persistDelayMs: number;
  private readonly channels = new Map<string, StoredAmbientChannel>();
  private persistTimer?: NodeJS.Timeout;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: AmbientEpisodeLedgerOptions = {}) {
    this.persistence = options.persistence ?? new JsonFileAmbientEpisodePersistence(resolve(
      process.cwd(),
      process.env.AMBIENT_EPISODE_STATE_PATH ?? "data/ambient-episodes.json",
    ));
    this.now = options.now ?? Date.now;
    this.activeTtlMs = positiveDuration(options.activeTtlMs, AMBIENT_EPISODE_LEDGER_DEFAULTS.activeTtlMs);
    this.retentionMs = positiveDuration(options.retentionMs, AMBIENT_EPISODE_LEDGER_DEFAULTS.retentionMs);
    this.callbackTtlMs = Math.min(
      this.retentionMs,
      positiveDuration(options.callbackTtlMs, AMBIENT_EPISODE_LEDGER_DEFAULTS.callbackTtlMs),
    );
    this.semanticCooldownMs = Math.min(
      this.retentionMs,
      positiveDuration(options.semanticCooldownMs, AMBIENT_EPISODE_LEDGER_DEFAULTS.semanticCooldownMs),
    );
    this.relevanceHalfLifeMs = positiveDuration(
      options.relevanceHalfLifeMs,
      AMBIENT_EPISODE_LEDGER_DEFAULTS.relevanceHalfLifeMs,
    );
    this.maxChannels = boundedCount(
      options.maxChannels,
      AMBIENT_EPISODE_LEDGER_DEFAULTS.maxChannels,
      HARD_LIMITS.maxChannels,
    );
    this.maxRecentEpisodesPerChannel = boundedCount(
      options.maxRecentEpisodesPerChannel,
      AMBIENT_EPISODE_LEDGER_DEFAULTS.maxRecentEpisodesPerChannel,
      HARD_LIMITS.maxRecentEpisodesPerChannel,
    );
    this.maxSemanticRecencyEntriesPerChannel = boundedCount(
      options.maxSemanticRecencyEntriesPerChannel,
      AMBIENT_EPISODE_LEDGER_DEFAULTS.maxSemanticRecencyEntriesPerChannel,
      HARD_LIMITS.maxSemanticRecencyEntriesPerChannel,
    );
    this.maxFacetsPerEpisode = boundedCount(options.maxFacetsPerEpisode, AMBIENT_EPISODE_LEDGER_DEFAULTS.maxFacetsPerEpisode, HARD_LIMITS.maxFacetsPerEpisode);
    this.maxEntitiesPerEpisode = boundedCount(options.maxEntitiesPerEpisode, AMBIENT_EPISODE_LEDGER_DEFAULTS.maxEntitiesPerEpisode, HARD_LIMITS.maxEntitiesPerEpisode);
    this.maxStancesPerEpisode = boundedCount(options.maxStancesPerEpisode, AMBIENT_EPISODE_LEDGER_DEFAULTS.maxStancesPerEpisode, HARD_LIMITS.maxStancesPerEpisode);
    this.maxHooksPerEpisode = boundedCount(options.maxHooksPerEpisode, AMBIENT_EPISODE_LEDGER_DEFAULTS.maxHooksPerEpisode, HARD_LIMITS.maxHooksPerEpisode);
    this.maxSourceUrlsPerEpisode = boundedCount(options.maxSourceUrlsPerEpisode, AMBIENT_EPISODE_LEDGER_DEFAULTS.maxSourceUrlsPerEpisode, HARD_LIMITS.maxSourceUrlsPerEpisode);
    this.maxParticipantsPerEpisode = boundedCount(options.maxParticipantsPerEpisode, AMBIENT_EPISODE_LEDGER_DEFAULTS.maxParticipantsPerEpisode, HARD_LIMITS.maxParticipantsPerEpisode);
    this.maxWitnessesPerEpisode = boundedCount(options.maxWitnessesPerEpisode, AMBIENT_EPISODE_LEDGER_DEFAULTS.maxWitnessesPerEpisode, HARD_LIMITS.maxWitnessesPerEpisode);
    this.maxMessageIdsPerEpisode = boundedCount(options.maxMessageIdsPerEpisode, AMBIENT_EPISODE_LEDGER_DEFAULTS.maxMessageIdsPerEpisode, HARD_LIMITS.maxMessageIdsPerEpisode);
    this.maxUsedCallbacksPerEpisode = boundedCount(options.maxUsedCallbacksPerEpisode, AMBIENT_EPISODE_LEDGER_DEFAULTS.maxUsedCallbacksPerEpisode, HARD_LIMITS.maxUsedCallbacksPerEpisode);
    this.maxOperationIdsPerEpisode = boundedCount(options.maxOperationIdsPerEpisode, AMBIENT_EPISODE_LEDGER_DEFAULTS.maxOperationIdsPerEpisode, HARD_LIMITS.maxOperationIdsPerEpisode);
    this.persistDelayMs = Math.max(0, Math.floor(finiteNumber(options.persistDelayMs, AMBIENT_EPISODE_LEDGER_DEFAULTS.persistDelayMs)));
  }

  async load(): Promise<void> {
    this.channels.clear();
    const loaded = await this.persistence.load();
    const root = asRecord(loaded);
    const now = this.now();
    const seenEpisodeIds = new Set<string>();
    let semanticRecencyNeedsPersist = false;
    if (root?.version === 1 && Array.isArray(root.channels)) {
      for (const rawChannel of root.channels.slice(0, HARD_LIMITS.maxChannels * 2)) {
        const record = asRecord(rawChannel);
        const channelId = safeId(record?.channelId);
        if (!channelId || this.channels.has(channelId)) continue;
        const channel: StoredAmbientChannel = { channelId, recent: [], semanticRecency: [] };
        const rawSemanticRecency = record?.semanticRecency;
        const hasPersistedSemanticRecency = Array.isArray(rawSemanticRecency);
        if (hasPersistedSemanticRecency) {
          for (const rawEntry of rawSemanticRecency.slice(
            0,
            HARD_LIMITS.maxSemanticRecencyEntriesPerChannel * 2,
          )) {
            const entry = this.sanitizeSemanticRecencyEntry(rawEntry, now);
            if (!entry) continue;
            this.rememberSemanticPublication(
              channel,
              entry.semanticFamily,
              entry.semanticKey,
              entry.lastPublishedAt,
            );
          }
        } else {
          semanticRecencyNeedsPersist = true;
        }
        const current = this.sanitizeEpisode(record?.current, channelId, now);
        if (current && !seenEpisodeIds.has(current.id)) {
          seenEpisodeIds.add(current.id);
          if (current.status === "current") channel.current = current;
          else channel.recent.push(current);
        }
        if (Array.isArray(record?.recent)) {
          for (const rawEpisode of record.recent.slice(0, HARD_LIMITS.maxRecentEpisodesPerChannel * 2)) {
            const episode = this.sanitizeEpisode(rawEpisode, channelId, now);
            if (!episode || seenEpisodeIds.has(episode.id)) continue;
            seenEpisodeIds.add(episode.id);
            if (episode.status === "current" && !channel.current) channel.current = episode;
            else {
              episode.status = "closed";
              episode.closedAt ??= episode.lastActivityAt;
              episode.closeReason ??= "recovered";
              episode.cooldownUntil ??= episode.closedAt + this.semanticCooldownMs;
              channel.recent.push(episode);
            }
          }
        }
        channel.recent.sort(compareRecent);
        channel.recent = channel.recent.slice(0, this.maxRecentEpisodesPerChannel);
        // Legacy files are bootstrapped from retained authored publications.
        // New files merge those publications too, repairing an index that was
        // partially written or sanitized while preserving older compact rows.
        for (const episode of [...channel.recent, ...(channel.current ? [channel.current] : [])]) {
          if (!contributesAuthoredNovelty(episode.sourceKind)) continue;
          const repaired = this.rememberSemanticPublication(
            channel,
            episode.semanticFamily,
            episode.semanticKey,
            episode.lastActivityAt,
          );
          if (hasPersistedSemanticRecency && repaired) semanticRecencyNeedsPersist = true;
        }
        if (channel.current || channel.recent.length > 0 || channel.semanticRecency.length > 0) {
          this.channels.set(channelId, channel);
        }
      }
    }
    const result = this.pruneInternal(now);
    const channelsTrimmed = this.trimChannels();
    if (
      result.episodesClosed > 0 || result.episodesRemoved > 0 ||
      result.channelsRemoved > 0 || channelsTrimmed > 0 || semanticRecencyNeedsPersist
    ) {
      this.schedulePersist();
    }
  }

  async flush(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      await this.persistence.save(this.serialize());
    });
    return this.writeQueue;
  }

  openEpisode(input: OpenAmbientEpisodeInput): AmbientEpisode {
    const observedNow = this.now();
    const now = Math.min(observedNow, safeTimestamp(input.openedAt, observedNow));
    this.pruneAndSchedule(observedNow);
    const normalized = this.newEpisode(input, now);
    const existing = this.findStored(normalized.id)?.episode;
    if (existing) {
      if (
        existing.channelId !== normalized.channelId ||
        semanticIdentity(existing.semanticFamily) !== semanticIdentity(normalized.semanticFamily) ||
        semanticIdentity(existing.semanticKey) !== semanticIdentity(normalized.semanticKey) ||
        existing.sourceKind !== normalized.sourceKind ||
        existing.causalRootId !== normalized.causalRootId
      ) {
        throw new TypeError("Ambient episode ID already belongs to different immutable metadata");
      }
      return snapshot(existing);
    }

    let channel = this.channels.get(normalized.channelId);
    if (!channel) {
      channel = { channelId: normalized.channelId, recent: [], semanticRecency: [] };
      this.channels.set(normalized.channelId, channel);
    }
    if (channel.current) this.closeStored(channel, channel.current, "superseded", now, this.semanticCooldownMs);
    channel.current = normalized;
    if (contributesAuthoredNovelty(normalized.sourceKind)) {
      this.rememberSemanticPublication(
        channel,
        normalized.semanticFamily,
        normalized.semanticKey,
        observedNow,
      );
    }
    this.trimChannels();
    // A replayed, already-expired episode becomes bounded recent history
    // immediately instead of temporarily reviving as a current conversation.
    this.pruneAndSchedule(observedNow);
    this.schedulePersist();
    return snapshot(normalized);
  }

  updateEpisode(episodeId: string, input: UpdateAmbientEpisodeInput): AmbientEpisode | undefined {
    const observedNow = this.now();
    this.pruneAndSchedule(observedNow);
    const safeEpisodeId = safeId(episodeId);
    if (!safeEpisodeId) return undefined;
    const found = this.findStored(safeEpisodeId);
    if (!found) return undefined;
    const episode = found.episode;
    const operationId = safeId(input.operationId);
    if (operationId && episode.operationIds.includes(operationId)) return snapshot(episode);
    if (episode.status !== "current") return undefined;
    const at = Math.max(
      episode.lastActivityAt,
      Math.min(observedNow, safeTimestamp(input.activityAt, observedNow)),
    );
    const incomingMessageIds = safeIds(input.messageIds, this.maxMessageIdsPerEpisode);
    const hasNewPublishedMessage = incomingMessageIds.some((messageId) =>
      !episode.messageIds.includes(messageId)
    );

    episode.facets = safeSemantics(input.facets, this.maxFacetsPerEpisode, episode.facets);
    episode.entities = safeSemantics(input.entities, this.maxEntitiesPerEpisode, episode.entities);
    episode.sourceUrls = safeSourceUrls(input.sourceUrls, this.maxSourceUrlsPerEpisode, episode.sourceUrls);
    episode.participantIds = safeIds(input.participantIds, this.maxParticipantsPerEpisode, episode.participantIds);
    episode.witnessIds = safeIds(input.witnessIds, this.maxWitnessesPerEpisode, episode.witnessIds);
    episode.messageIds = safeIds(incomingMessageIds, this.maxMessageIdsPerEpisode, episode.messageIds);
    this.mergeStances(episode, input.stances, at);
    this.mergeHooks(episode, input.hooks, at);
    this.changeHookStatuses(episode, input.resolveHookIds, "resolved", at);
    this.changeHookStatuses(episode, input.abandonHookIds, "abandoned", at);
    this.includeProvenanceMessageIds(episode);
    episode.lastActivityAt = at;
    this.rememberOperation(episode, operationId);
    if (hasNewPublishedMessage && contributesAuthoredNovelty(episode.sourceKind)) {
      this.rememberSemanticPublication(
        found.channel,
        episode.semanticFamily,
        episode.semanticKey,
        at,
      );
    }
    this.schedulePersist();
    return snapshot(episode);
  }

  closeEpisode(
    episodeId: string,
    reason: string,
    options: CloseAmbientEpisodeOptions = {},
  ): AmbientEpisode | undefined {
    const observedNow = this.now();
    this.pruneAndSchedule(observedNow);
    const safeEpisodeId = safeId(episodeId);
    const safeReason = safeSemantic(reason, 80);
    if (!safeEpisodeId || !safeReason) return undefined;
    const found = this.findStored(safeEpisodeId);
    if (!found) return undefined;
    const operationId = safeId(options.operationId);
    if (operationId && found.episode.operationIds.includes(operationId)) return snapshot(found.episode);
    if (found.episode.status === "closed") return snapshot(found.episode);
    const at = Math.max(
      found.episode.lastActivityAt,
      Math.min(observedNow, safeTimestamp(options.closedAt, observedNow)),
    );
    this.rememberOperation(found.episode, operationId);
    const cooldownMs = Math.min(
      this.retentionMs,
      Math.max(0, finiteNumber(options.cooldownMs, this.semanticCooldownMs)),
    );
    this.closeStored(found.channel, found.episode, safeReason, at, cooldownMs);
    this.schedulePersist();
    return snapshot(found.episode);
  }

  current(channelId: string): AmbientEpisode | undefined {
    const safeChannelId = safeId(channelId);
    if (!safeChannelId) return undefined;
    this.pruneAndSchedule(this.now());
    const episode = this.channels.get(safeChannelId)?.current;
    return episode ? snapshot(episode) : undefined;
  }

  recent(channelId: string, limit = 12): AmbientEpisode[] {
    const safeChannelId = safeId(channelId);
    if (!safeChannelId) return [];
    this.pruneAndSchedule(this.now());
    const boundedLimit = Math.max(1, Math.min(this.maxRecentEpisodesPerChannel, Math.floor(finiteNumber(limit, 12))));
    return (this.channels.get(safeChannelId)?.recent ?? []).slice(0, boundedLimit).map(snapshot);
  }

  episode(episodeId: string): AmbientEpisode | undefined {
    const safeEpisodeId = safeId(episodeId);
    if (!safeEpisodeId) return undefined;
    this.pruneAndSchedule(this.now());
    const episode = this.findStored(safeEpisodeId)?.episode;
    return episode ? snapshot(episode) : undefined;
  }

  recallCandidates(channelId: string, limit = 12): AmbientEpisodeRecallCandidate[] {
    const now = this.now();
    return this.recent(channelId, limit).map((episode) => {
      const ageMs = Math.max(0, now - (episode.closedAt ?? episode.lastActivityAt));
      return { episode, ageMs, relevance: this.decayedRelevance(ageMs) };
    });
  }

  eligibleCallbacks(channelId: string, limit = 8): AmbientEpisodeCallbackCandidate[] {
    const safeChannelId = safeId(channelId);
    if (!safeChannelId) return [];
    const now = this.now();
    this.pruneAndSchedule(now);
    const channel = this.channels.get(safeChannelId);
    if (!channel) return [];
    const used = new Set(
      [channel.current, ...channel.recent]
        .flatMap((episode) => episode?.usedCallbacks ?? [])
        .map((callback) => `${callback.sourceEpisodeId}\u241f${callback.callbackId}`),
    );
    const boundedLimit = Math.max(1, Math.min(this.maxHooksPerEpisode, Math.floor(finiteNumber(limit, 8))));
    const candidates: AmbientEpisodeCallbackCandidate[] = [];
    for (const episode of channel.recent) {
      const ageMs = Math.max(0, now - (episode.closedAt ?? episode.lastActivityAt));
      if (ageMs > this.callbackTtlMs) continue;
      for (const hook of episode.hooks) {
        if (hook.status !== "open" || used.has(`${episode.id}\u241f${hook.id}`)) continue;
        candidates.push({
          sourceEpisodeId: episode.id,
          semanticFamily: episode.semanticFamily,
          semanticKey: episode.semanticKey,
          causalRootId: episode.causalRootId,
          hook: cloneHook(hook),
          ageMs,
          relevance: this.decayedRelevance(ageMs),
        });
        if (candidates.length >= boundedLimit) return candidates;
      }
    }
    return candidates;
  }

  markCallbackUsed(
    targetEpisodeId: string,
    sourceEpisodeId: string,
    callbackId: string,
    options: { usedAt?: number; operationId?: string } = {},
  ): AmbientEpisode | undefined {
    const observedNow = this.now();
    this.pruneAndSchedule(observedNow);
    const targetFound = this.findStored(safeId(targetEpisodeId) ?? "");
    const sourceFound = this.findStored(safeId(sourceEpisodeId) ?? "");
    const safeCallbackId = safeId(callbackId);
    if (!targetFound || !sourceFound || !safeCallbackId) return undefined;
    const operationId = safeId(options.operationId);
    if (operationId && targetFound.episode.operationIds.includes(operationId)) {
      return snapshot(targetFound.episode);
    }
    if (
      targetFound.episode.status !== "current" || sourceFound.episode.status !== "closed" ||
      targetFound.episode.id === sourceFound.episode.id ||
      targetFound.episode.channelId !== sourceFound.episode.channelId
    ) return undefined;
    const hook = sourceFound.episode.hooks.find((candidate) => candidate.id === safeCallbackId);
    if (!hook || hook.status !== "open") return undefined;
    const alreadyUsed = [...this.channels.get(targetFound.episode.channelId)!.recent, targetFound.episode]
      .some((episode) => episode.usedCallbacks.some((candidate) =>
        candidate.sourceEpisodeId === sourceFound.episode.id && candidate.callbackId === safeCallbackId
      ));
    if (alreadyUsed) return snapshot(targetFound.episode);
    const usedAt = Math.max(
      targetFound.episode.lastActivityAt,
      Math.min(observedNow, safeTimestamp(options.usedAt, observedNow)),
    );
    targetFound.episode.usedCallbacks.push({
      callbackId: safeCallbackId,
      sourceEpisodeId: sourceFound.episode.id,
      sourceMessageIds: [...hook.sourceMessageIds],
      usedAt,
    });
    targetFound.episode.usedCallbacks = targetFound.episode.usedCallbacks.slice(-this.maxUsedCallbacksPerEpisode);
    targetFound.episode.messageIds = safeIds(
      hook.sourceMessageIds,
      this.maxMessageIdsPerEpisode,
      targetFound.episode.messageIds,
    );
    targetFound.episode.lastActivityAt = usedAt;
    this.rememberOperation(targetFound.episode, operationId);
    this.schedulePersist();
    return snapshot(targetFound.episode);
  }

  isCoolingDown(
    channelId: string,
    semantic: { semanticKey?: string; semanticFamily?: string },
    at = this.now(),
  ): boolean {
    const safeChannelId = safeId(channelId);
    const semanticKey = safeSemantic(semantic.semanticKey);
    const semanticFamily = safeSemantic(semantic.semanticFamily);
    if (!safeChannelId || (!semanticKey && !semanticFamily)) return false;
    this.pruneAndSchedule(at);
    return (this.channels.get(safeChannelId)?.recent ?? []).some((episode) => {
      if ((episode.cooldownUntil ?? 0) <= at) return false;
      if (semanticKey && semanticIdentity(episode.semanticKey) === semanticIdentity(semanticKey)) return true;
      return Boolean(semanticFamily && semanticIdentity(episode.semanticFamily) === semanticIdentity(semanticFamily));
    });
  }

  /**
   * Returns publication-derived semantic recency without inspecting message
   * prose. The director uses this to prefer the least recently used authored
   * topic across restarts; a selected or rejected generation never appears in
   * this ledger and therefore cannot consume novelty.
   */
  semanticLastUsedAt(
    channelId: string,
    semantic: { semanticKey?: string; semanticFamily?: string },
    at = this.now(),
  ): number | undefined {
    const safeChannelId = safeId(channelId);
    const semanticKey = safeSemantic(semantic.semanticKey);
    const semanticFamily = safeSemantic(semantic.semanticFamily);
    if (!safeChannelId || (!semanticKey && !semanticFamily)) return undefined;
    this.pruneAndSchedule(at);
    const channel = this.channels.get(safeChannelId);
    if (!channel) return undefined;
    return channel.semanticRecency.reduce<number | undefined>(
      (latest, entry) => {
        const matchesKey = semanticKey &&
          semanticIdentity(entry.semanticKey) === semanticIdentity(semanticKey);
        const matchesFamily = semanticFamily &&
          semanticIdentity(entry.semanticFamily) === semanticIdentity(semanticFamily);
        if (!matchesKey && !matchesFamily) return latest;
        const usedAt = Math.min(at, entry.lastPublishedAt);
        return latest === undefined ? usedAt : Math.max(latest, usedAt);
      },
      undefined,
    );
  }

  relevance(episodeId: string, at = this.now()): number {
    this.pruneAndSchedule(at);
    const episode = this.findStored(safeId(episodeId) ?? "")?.episode;
    if (!episode) return 0;
    if (episode.status === "current") return 1;
    return this.decayedRelevance(Math.max(0, at - (episode.closedAt ?? episode.lastActivityAt)));
  }

  prune(at = this.now()): AmbientEpisodePruneResult {
    const result = this.pruneInternal(safeTimestamp(at, this.now()));
    if (result.episodesClosed > 0 || result.episodesRemoved > 0 || result.channelsRemoved > 0) {
      this.schedulePersist();
    }
    return result;
  }

  private newEpisode(input: OpenAmbientEpisodeInput, at: number): StoredAmbientEpisode {
    const id = safeId(input.id);
    const channelId = safeId(input.channelId);
    const semanticFamily = safeSemantic(input.semanticFamily);
    const semanticKey = safeSemantic(input.semanticKey);
    const sourceKind = safeSemantic(input.sourceKind, 80);
    const causalRootId = safeId(input.causalRootId ?? input.id);
    if (!id || !channelId || !semanticFamily || !semanticKey || !sourceKind || !causalRootId) {
      throw new TypeError("Ambient episode requires safe IDs and compact semantic metadata");
    }
    const episode: StoredAmbientEpisode = {
      id,
      channelId,
      semanticFamily,
      semanticKey,
      sourceKind,
      causalRootId,
      facets: safeSemantics(input.facets, this.maxFacetsPerEpisode),
      entities: safeSemantics(input.entities, this.maxEntitiesPerEpisode),
      stances: [],
      sourceUrls: safeSourceUrls(input.sourceUrls, this.maxSourceUrlsPerEpisode),
      hooks: [],
      participantIds: safeIds(input.participantIds, this.maxParticipantsPerEpisode),
      witnessIds: safeIds(input.witnessIds, this.maxWitnessesPerEpisode),
      messageIds: safeIds(input.messageIds, this.maxMessageIdsPerEpisode),
      usedCallbacks: [],
      operationIds: [],
      status: "current",
      openedAt: at,
      lastActivityAt: at,
    };
    this.mergeStances(episode, input.stances, at);
    this.mergeHooks(episode, input.hooks, at);
    this.includeProvenanceMessageIds(episode);
    this.rememberOperation(episode, safeId(input.operationId));
    return episode;
  }

  private mergeStances(
    episode: StoredAmbientEpisode,
    rawStances: readonly AmbientEpisodeStanceInput[] | undefined,
    fallbackAt: number,
  ): void {
    if (!Array.isArray(rawStances)) return;
    for (const raw of rawStances.slice(0, this.maxStancesPerEpisode)) {
      const actorId = safeId(raw?.actorId);
      const semanticKey = safeSemantic(raw?.semanticKey);
      const sourceMessageIds = safeIds(raw?.sourceMessageIds, this.maxMessageIdsPerEpisode);
      if (!actorId || !semanticKey || sourceMessageIds.length === 0) continue;
      const stance: AmbientEpisodeStance = {
        actorId,
        semanticKey,
        sourceMessageIds,
        updatedAt: Math.min(fallbackAt, safeTimestamp(raw.updatedAt, fallbackAt)),
      };
      const existingIndex = episode.stances.findIndex((candidate) => candidate.actorId === actorId);
      if (existingIndex >= 0) episode.stances.splice(existingIndex, 1);
      episode.stances.push(stance);
      episode.participantIds = safeIds([actorId], this.maxParticipantsPerEpisode, episode.participantIds);
    }
    episode.stances = episode.stances
      .sort((left, right) => right.updatedAt - left.updatedAt || left.actorId.localeCompare(right.actorId))
      .slice(0, this.maxStancesPerEpisode);
  }

  private mergeHooks(
    episode: StoredAmbientEpisode,
    rawHooks: readonly AmbientEpisodeHookInput[] | undefined,
    fallbackAt: number,
  ): void {
    if (!Array.isArray(rawHooks)) return;
    for (const raw of rawHooks.slice(0, this.maxHooksPerEpisode)) {
      const id = safeId(raw?.id);
      const semanticKey = safeSemantic(raw?.semanticKey);
      const sourceMessageIds = safeIds(raw?.sourceMessageIds, this.maxMessageIdsPerEpisode);
      if (!id || sourceMessageIds.length === 0) continue;
      const existing = episode.hooks.find((candidate) => candidate.id === id);
      if (existing) {
        existing.sourceMessageIds = safeIds(
          sourceMessageIds,
          this.maxMessageIdsPerEpisode,
          existing.sourceMessageIds,
        );
        existing.semanticKey ??= semanticKey;
      } else {
        episode.hooks.push({
          id,
          ...(semanticKey ? { semanticKey } : {}),
          sourceMessageIds,
          status: "open",
          createdAt: Math.min(fallbackAt, safeTimestamp(raw.createdAt, fallbackAt)),
        });
      }
      if (episode.hooks.length >= this.maxHooksPerEpisode) break;
    }
    episode.hooks = episode.hooks.slice(0, this.maxHooksPerEpisode);
  }

  private changeHookStatuses(
    episode: StoredAmbientEpisode,
    ids: readonly string[] | undefined,
    status: Exclude<AmbientEpisodeHookStatus, "open">,
    at: number,
  ): void {
    const safeHookIds = new Set(safeIds(ids, this.maxHooksPerEpisode));
    for (const hook of episode.hooks) {
      if (hook.status === "open" && safeHookIds.has(hook.id)) {
        hook.status = status;
        hook.resolvedAt = at;
      }
    }
  }

  private includeProvenanceMessageIds(episode: StoredAmbientEpisode): void {
    episode.messageIds = safeIds(
      [
        ...episode.stances.flatMap((stance) => stance.sourceMessageIds),
        ...episode.hooks.flatMap((hook) => hook.sourceMessageIds),
        ...episode.usedCallbacks.flatMap((callback) => callback.sourceMessageIds),
      ],
      this.maxMessageIdsPerEpisode,
      episode.messageIds,
    );
  }

  private closeStored(
    channel: StoredAmbientChannel,
    episode: StoredAmbientEpisode,
    reason: string,
    at: number,
    cooldownMs: number,
  ): void {
    episode.status = "closed";
    episode.closedAt = at;
    episode.closeReason = reason;
    episode.lastActivityAt = Math.max(episode.lastActivityAt, at);
    episode.cooldownUntil = at + Math.max(0, cooldownMs);
    if (channel.current?.id === episode.id) channel.current = undefined;
    if (!channel.recent.some((candidate) => candidate.id === episode.id)) channel.recent.unshift(episode);
    channel.recent.sort(compareRecent);
    channel.recent = channel.recent.slice(0, this.maxRecentEpisodesPerChannel);
  }

  private findStored(episodeId: string): { channel: StoredAmbientChannel; episode: StoredAmbientEpisode } | undefined {
    for (const channel of this.channels.values()) {
      if (channel.current?.id === episodeId) return { channel, episode: channel.current };
      const episode = channel.recent.find((candidate) => candidate.id === episodeId);
      if (episode) return { channel, episode };
    }
    return undefined;
  }

  private rememberOperation(episode: StoredAmbientEpisode, operationId: string | undefined): void {
    if (!operationId || episode.operationIds.includes(operationId)) return;
    episode.operationIds.push(operationId);
    episode.operationIds = episode.operationIds.slice(-this.maxOperationIdsPerEpisode);
  }

  private decayedRelevance(ageMs: number): number {
    if (ageMs >= this.retentionMs) return 0;
    return Math.max(0, Math.min(1, 0.5 ** (ageMs / this.relevanceHalfLifeMs)));
  }

  private pruneAndSchedule(at: number): void {
    const result = this.pruneInternal(safeTimestamp(at, this.now()));
    if (result.episodesClosed > 0 || result.episodesRemoved > 0 || result.channelsRemoved > 0) {
      this.schedulePersist();
    }
  }

  private pruneInternal(at: number): AmbientEpisodePruneResult {
    let episodesClosed = 0;
    let episodesRemoved = 0;
    let channelsRemoved = 0;
    for (const [channelId, channel] of this.channels) {
      if (channel.current && at - channel.current.lastActivityAt >= this.activeTtlMs) {
        // Expiration is anchored to the episode's own activity, not to the
        // arbitrary time at which a later process happens to notice it.
        const expiredAt = channel.current.lastActivityAt + this.activeTtlMs;
        this.closeStored(channel, channel.current, "stale", expiredAt, this.semanticCooldownMs);
        episodesClosed += 1;
      }
      const before = channel.recent.length;
      channel.recent = channel.recent
        .filter((episode) => at - (episode.closedAt ?? episode.lastActivityAt) <= this.retentionMs)
        .sort(compareRecent)
        .slice(0, this.maxRecentEpisodesPerChannel);
      channel.semanticRecency = channel.semanticRecency
        .filter((entry) => at - entry.lastPublishedAt <= this.retentionMs)
        .sort(compareSemanticRecency)
        .slice(0, this.maxSemanticRecencyEntriesPerChannel);
      episodesRemoved += before - channel.recent.length;
      if (!channel.current && channel.recent.length === 0 && channel.semanticRecency.length === 0) {
        this.channels.delete(channelId);
        channelsRemoved += 1;
      }
    }
    return { episodesClosed, episodesRemoved, channelsRemoved };
  }

  private trimChannels(): number {
    if (this.channels.size <= this.maxChannels) return 0;
    const ordered = [...this.channels.values()].sort((left, right) => {
      const currentPreference = Number(Boolean(right.current)) - Number(Boolean(left.current));
      if (currentPreference !== 0) return currentPreference;
      const leftTime = left.current?.lastActivityAt ?? left.recent[0]?.lastActivityAt ??
        left.semanticRecency[0]?.lastPublishedAt ?? 0;
      const rightTime = right.current?.lastActivityAt ?? right.recent[0]?.lastActivityAt ??
        right.semanticRecency[0]?.lastPublishedAt ?? 0;
      return rightTime - leftTime || left.channelId.localeCompare(right.channelId);
    });
    const keep = new Set(ordered.slice(0, this.maxChannels).map((channel) => channel.channelId));
    let removed = 0;
    for (const channelId of this.channels.keys()) {
      if (!keep.has(channelId) && this.channels.delete(channelId)) removed += 1;
    }
    return removed;
  }

  private sanitizeSemanticRecencyEntry(
    raw: unknown,
    now: number,
  ): AmbientSemanticRecencyEntry | undefined {
    const value = asRecord(raw);
    const semanticFamily = safeSemantic(value?.semanticFamily);
    const semanticKey = safeSemantic(value?.semanticKey);
    if (
      !semanticFamily || !semanticKey ||
      typeof value?.lastPublishedAt !== "number" || !Number.isFinite(value.lastPublishedAt)
    ) return undefined;
    return {
      semanticFamily,
      semanticKey,
      lastPublishedAt: Math.min(now, Math.max(0, value.lastPublishedAt)),
    };
  }

  private rememberSemanticPublication(
    channel: StoredAmbientChannel,
    rawSemanticFamily: string,
    rawSemanticKey: string,
    rawPublishedAt: number,
  ): boolean {
    const semanticFamily = safeSemantic(rawSemanticFamily);
    const semanticKey = safeSemantic(rawSemanticKey);
    if (!semanticFamily || !semanticKey || !Number.isFinite(rawPublishedAt)) return false;
    const lastPublishedAt = Math.max(0, rawPublishedAt);
    const identity = semanticRecencyIdentity(semanticFamily, semanticKey);
    const existingIndex = channel.semanticRecency.findIndex((entry) =>
      semanticRecencyIdentity(entry.semanticFamily, entry.semanticKey) === identity
    );
    const existing = existingIndex >= 0 ? channel.semanticRecency[existingIndex] : undefined;
    if (existing && existing.lastPublishedAt >= lastPublishedAt) return false;
    if (existingIndex >= 0) channel.semanticRecency.splice(existingIndex, 1);
    channel.semanticRecency.push({ semanticFamily, semanticKey, lastPublishedAt });
    channel.semanticRecency = channel.semanticRecency
      .sort(compareSemanticRecency)
      .slice(0, this.maxSemanticRecencyEntriesPerChannel);
    return true;
  }

  private sanitizeEpisode(raw: unknown, channelId: string, now: number): StoredAmbientEpisode | undefined {
    const value = asRecord(raw);
    const id = safeId(value?.id);
    const storedChannelId = safeId(value?.channelId);
    const semanticFamily = safeSemantic(value?.semanticFamily);
    const semanticKey = safeSemantic(value?.semanticKey);
    const sourceKind = safeSemantic(value?.sourceKind, 80);
    const causalRootId = safeId(value?.causalRootId ?? value?.id);
    if (!value || !id || storedChannelId !== channelId || !semanticFamily || !semanticKey || !sourceKind || !causalRootId) {
      return undefined;
    }
    const openedAt = Math.min(now, safeTimestamp(value.openedAt, now));
    const lastActivityAt = Math.max(
      openedAt,
      Math.min(now, safeTimestamp(value.lastActivityAt, openedAt)),
    );
    const status: AmbientEpisodeStatus = value.status === "closed" ? "closed" : "current";
    const episode: StoredAmbientEpisode = {
      id,
      channelId,
      semanticFamily,
      semanticKey,
      sourceKind,
      causalRootId,
      facets: safeSemantics(value.facets, this.maxFacetsPerEpisode),
      entities: safeSemantics(value.entities, this.maxEntitiesPerEpisode),
      stances: [],
      sourceUrls: safeSourceUrls(value.sourceUrls, this.maxSourceUrlsPerEpisode),
      hooks: [],
      participantIds: safeIds(value.participantIds, this.maxParticipantsPerEpisode),
      witnessIds: safeIds(value.witnessIds, this.maxWitnessesPerEpisode),
      messageIds: safeIds(value.messageIds, this.maxMessageIdsPerEpisode),
      usedCallbacks: [],
      operationIds: safeIds(value.operationIds, this.maxOperationIdsPerEpisode),
      status,
      openedAt,
      lastActivityAt,
    };

    if (Array.isArray(value.stances)) {
      this.mergeStances(episode, value.stances as AmbientEpisodeStanceInput[], lastActivityAt);
    }
    if (Array.isArray(value.hooks)) {
      for (const rawHook of value.hooks.slice(0, this.maxHooksPerEpisode)) {
        const hookValue = asRecord(rawHook);
        const hookId = safeId(hookValue?.id);
        const sourceMessageIds = safeIds(hookValue?.sourceMessageIds, this.maxMessageIdsPerEpisode);
        if (!hookId || sourceMessageIds.length === 0) continue;
        const hookStatus: AmbientEpisodeHookStatus = hookValue?.status === "resolved" || hookValue?.status === "abandoned"
          ? hookValue.status
          : "open";
        const createdAt = Math.min(lastActivityAt, safeTimestamp(hookValue?.createdAt, openedAt));
        const resolvedAt = hookStatus === "open"
          ? undefined
          : Math.max(
              createdAt,
              Math.min(lastActivityAt, safeTimestamp(hookValue?.resolvedAt, lastActivityAt)),
            );
        const hookSemanticKey = safeSemantic(hookValue?.semanticKey);
        episode.hooks.push({
          id: hookId,
          ...(hookSemanticKey ? { semanticKey: hookSemanticKey } : {}),
          sourceMessageIds,
          status: hookStatus,
          createdAt,
          ...(resolvedAt !== undefined ? { resolvedAt } : {}),
        });
      }
    }
    if (Array.isArray(value.usedCallbacks)) {
      for (const rawCallback of value.usedCallbacks.slice(-this.maxUsedCallbacksPerEpisode)) {
        const callbackValue = asRecord(rawCallback);
        const callbackId = safeId(callbackValue?.callbackId);
        const sourceEpisodeId = safeId(callbackValue?.sourceEpisodeId);
        const sourceMessageIds = safeIds(callbackValue?.sourceMessageIds, this.maxMessageIdsPerEpisode);
        if (!callbackId || !sourceEpisodeId || sourceMessageIds.length === 0) continue;
        episode.usedCallbacks.push({
          callbackId,
          sourceEpisodeId,
          sourceMessageIds,
          usedAt: Math.min(lastActivityAt, safeTimestamp(callbackValue?.usedAt, lastActivityAt)),
        });
      }
    }
    if (status === "closed") {
      const closedAt = Math.max(
        lastActivityAt,
        Math.min(now, safeTimestamp(value.closedAt, lastActivityAt)),
      );
      episode.closedAt = closedAt;
      episode.closeReason = safeSemantic(value.closeReason, 80) ?? "recovered";
      episode.cooldownUntil = Math.min(
        closedAt + this.retentionMs,
        Math.max(closedAt, safeTimestamp(value.cooldownUntil, closedAt + this.semanticCooldownMs)),
      );
    }
    this.includeProvenanceMessageIds(episode);
    return episode;
  }

  private serialize(): AmbientEpisodePersistedState {
    return {
      version: 1,
      channels: [...this.channels.values()]
        .sort((left, right) => left.channelId.localeCompare(right.channelId))
        .map((channel) => ({
          channelId: channel.channelId,
          ...(channel.current ? { current: structuredClone(channel.current) } : {}),
          recent: channel.recent.map((episode) => structuredClone(episode)),
          semanticRecency: channel.semanticRecency.map((entry) => ({ ...entry })),
        })),
    };
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.flush().catch((error) => console.warn("Could not persist ambient episode metadata.", error));
    }, this.persistDelayMs);
    this.persistTimer.unref?.();
  }
}
