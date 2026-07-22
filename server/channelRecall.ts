import type { ChatMessage } from "../shared/types.js";
import { unicodeCaselessKey } from "../shared/unicodeSafety.js";

const DEFAULT_MAX_MESSAGES = 8;
const HARD_MAX_MESSAGES = 10;
const DEFAULT_EPISODE_GAP_MS = 5 * 60_000;
const MIN_EPISODE_GAP_MS = 1_000;
const MAX_EPISODE_GAP_MS = 30 * 60_000;
const MAX_QUERY_CHARACTERS = 4_000;
const MAX_DOCUMENT_CHARACTERS = 4_000;
const MAX_QUERY_TOKENS = 64;
const MAX_DOCUMENT_TOKENS = 192;
const RARE_DOCUMENT_SHARE = 0.2;
const MIN_DISCRIMINATIVE_IDF = 1.4;

type IdCollection = ReadonlySet<string> | readonly string[];

export interface ChannelRecallTrigger {
  id: string;
  channelId: string;
  createdAt: string;
}

export interface ChannelRecallInput {
  /** Retained public messages. Messages from another channel are always ignored. */
  messages: readonly ChatMessage[];
  query: string;
  /** Strict upper channel/time boundary. The trigger itself can never be recalled. */
  trigger: ChannelRecallTrigger;
  /** Optional inclusive lower timestamp boundary for the retained search. */
  notBefore?: string;
  /** Messages already present in the caller's live context; never return them again. */
  recentMessageIds: IdCollection;
  /** Server-owned persona IDs permitted to become episode witnesses. */
  allowedPersonaIds: IdCollection;
  /**
   * Optional stable participant binding supplied only after semantic
   * resolution. When present, a same-label product/topic mention can never be
   * the retrieval anchor for that participant.
   */
  participantSubjects?: ReadonlyArray<{ id: string; displayLabel: string }>;
  /** Defaults to eight and is mechanically capped at ten. */
  maxMessages?: number;
  /** Structural conversation boundary, independent of language or message content. */
  episodeGapMs?: number;
}

export interface ChannelRecallResult {
  /** Exact retained source messages, in chronological order. */
  messages: ChatMessage[];
  /**
   * Source messages in the returned window that directly matched the query.
   * Kept as a backwards-compatible alias for `anchorMessageIds`.
   */
  matchedMessageIds: string[];
  /** Direct retrieval anchors. Surrounding episode context is never included. */
  anchorMessageIds: string[];
  /** Returned episode rows that did not directly match the retrieval query. */
  contextMessageIds: string[];
  /** Stable per-row provenance that callers can carry into later grounding. */
  rows: ChannelRecallRowMetadata[];
  /** Allowed AI authors and reactors directly observed in the returned window. */
  witnessPersonaIds: string[];
  /** Deterministic retrieval score for diagnostics; it is never model evidence. */
  score: number;
}

export type ChannelRecallAnchorMatch = "author_identity" | "content";

export interface ChannelRecallRowMetadata {
  messageId: string;
  authorId: string;
  role: "anchor" | "context";
  /** Empty for context rows; ordered deterministically for direct anchors. */
  anchorMatches: ChannelRecallAnchorMatch[];
  system: boolean;
  generation: ChatMessage["generation"] | null;
}

interface SourceRecord {
  message: ChatMessage;
  time: number;
  ordinal: number;
}

interface IndexedRecord extends SourceRecord {
  tokens: Set<string>;
  authorNameTokens: Set<string>;
}

interface ScoredRecord extends IndexedRecord {
  identityMatch: boolean;
  contentMatch: boolean;
  score: number;
}

const boundedInteger = (value: number | undefined, fallback: number, minimum: number, maximum: number): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
};

const asIdSet = (values: IdCollection): Set<string> => new Set(values);

const tokenizeFallback = (value: string, limit: number): string[] => {
  const tokens: string[] = [];
  for (const match of value.matchAll(/[\p{L}\p{M}\p{N}]+/gu)) {
    const token = match[0];
    if (!token) continue;
    tokens.push(token);
    if (tokens.length >= limit) break;
  }
  return tokens;
};

/** Unicode word segmentation without locale-, language- or vocabulary-specific rules. */
export const channelRecallTokens = (raw: string, limit = MAX_DOCUMENT_TOKENS): string[] => {
  const boundedLimit = boundedInteger(limit, MAX_DOCUMENT_TOKENS, 1, MAX_DOCUMENT_TOKENS);
  const normalized = unicodeCaselessKey(raw.slice(0, MAX_DOCUMENT_CHARACTERS));
  if (!normalized.trim()) return [];
  const segmented = typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(normalized)]
      .filter((part) => part.isWordLike)
      .map((part) => part.segment)
      .slice(0, boundedLimit)
    : tokenizeFallback(normalized, boundedLimit);
  return [...new Set(segmented.filter(Boolean))];
};

const compareSource = (left: SourceRecord, right: SourceRecord): number =>
  left.time - right.time || left.message.createdAt.localeCompare(right.message.createdAt) ||
  left.message.id.localeCompare(right.message.id);

/**
 * Only a row's own content is direct retrieval evidence. A reply preview is a
 * denormalized copy of another row and may help a later caller display context,
 * but it must never turn the reply itself into a second retrieval anchor.
 */
const indexedContent = (message: ChatMessage): string =>
  message.content.slice(0, MAX_DOCUMENT_CHARACTERS);

const sourceHistory = (input: ChannelRecallInput, triggerTime: number, notBefore: number): {
  allBounded: SourceRecord[];
  eligible: SourceRecord[];
} => {
  const byId = new Set<string>();
  const channel = input.messages
    .flatMap((message) => {
      if (message.channelId !== input.trigger.channelId || byId.has(message.id)) return [];
      const time = Date.parse(message.createdAt);
      if (!Number.isFinite(time)) return [];
      byId.add(message.id);
      return [{ message, time, ordinal: 0 }];
    })
    .sort(compareSource)
    .map((record, ordinal) => ({ ...record, ordinal }));
  const triggerOrdinal = channel.find((record) => record.message.id === input.trigger.id)?.ordinal;
  const isBeforeTrigger = (record: SourceRecord): boolean => {
    if (record.time < triggerTime) return true;
    if (record.time > triggerTime) return false;
    return triggerOrdinal === undefined
      ? record.message.id.localeCompare(input.trigger.id) < 0
      : record.ordinal < triggerOrdinal;
  };
  const allBounded = channel.filter((record) =>
    record.time >= notBefore && isBeforeTrigger(record) && record.message.id !== input.trigger.id
  );
  const recentIds = asIdSet(input.recentMessageIds);
  return {
    allBounded,
    eligible: allBounded.filter((record) => !recentIds.has(record.message.id)),
  };
};

const documentFrequency = (records: readonly IndexedRecord[]): Map<string, number> => {
  const frequencies = new Map<string, number>();
  for (const record of records) {
    for (const token of record.tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return frequencies;
};

const inverseDocumentFrequency = (documentCount: number, frequency: number): number =>
  Math.log((documentCount + 1) / (frequency + 1)) + 1;

const scoredHistory = (
  records: readonly SourceRecord[],
  queryTokens: readonly string[],
  participantSubjects: ReadonlyArray<{ id: string; displayLabel: string }> = [],
): ScoredRecord[] => {
  const subjectIds = new Set(participantSubjects.map((subject) => subject.id));
  const subjectLabelTokens = new Set(
    participantSubjects.flatMap((subject) => channelRecallTokens(subject.displayLabel, MAX_QUERY_TOKENS)),
  );
  const contentQueryTokens = participantSubjects.length > 0
    ? queryTokens.filter((token) => !subjectLabelTokens.has(token))
    : [...queryTokens];
  const querySet = new Set(queryTokens);
  const indexed: IndexedRecord[] = records.map((record) => ({
    ...record,
    tokens: new Set(channelRecallTokens(indexedContent(record.message))),
    authorNameTokens: new Set(channelRecallTokens(record.message.authorSnapshot?.name ?? "", MAX_QUERY_TOKENS)),
  }));
  const frequencies = documentFrequency(indexed);
  const rareFrequencyCeiling = Math.max(1, Math.floor(indexed.length * RARE_DOCUMENT_SHARE));
  const discriminative = new Set(
    contentQueryTokens.filter((token) => {
      const frequency = frequencies.get(token) ?? 0;
      return frequency > 0 && frequency <= rareFrequencyCeiling &&
        inverseDocumentFrequency(indexed.length, frequency) >= MIN_DISCRIMINATIVE_IDF;
    }),
  );

  return indexed.flatMap((record) => {
    const identityMatch = participantSubjects.length > 0
      ? subjectIds.has(record.message.authorId)
      : record.authorNameTokens.size > 0 && [...record.authorNameTokens].every((token) => querySet.has(token));
    const rareMatches = [...discriminative].filter((token) => record.tokens.has(token));
    const contentMatch = rareMatches.length > 0;
    // An entity-bound recall may use other rows only as surrounding episode
    // context. It requires the exact stable author ID as its direct anchor.
    if (participantSubjects.length > 0 && !identityMatch) return [];
    if (!identityMatch && !contentMatch) return [];
    const commonMatches = contentQueryTokens.filter((token) =>
      !discriminative.has(token) && (frequencies.get(token) ?? 0) > 0 && record.tokens.has(token)
    );
    const rareScore = rareMatches.reduce((total, token) => {
      const idf = inverseDocumentFrequency(indexed.length, frequencies.get(token) ?? indexed.length);
      return total + idf * idf;
    }, 0);
    const commonScore = commonMatches.reduce((total, token) =>
      total + inverseDocumentFrequency(indexed.length, frequencies.get(token) ?? indexed.length) * 0.1, 0);
    return [{ ...record, identityMatch, contentMatch, score: rareScore + commonScore + (identityMatch ? 8 : 0) }];
  });
};

const episodeAround = (
  eligible: readonly SourceRecord[],
  seed: SourceRecord,
  episodeGapMs: number,
): SourceRecord[] => {
  const seedIndex = eligible.findIndex((record) => record.message.id === seed.message.id);
  if (seedIndex < 0) return [];
  let start = seedIndex;
  let end = seedIndex;
  while (start > 0) {
    const previous = eligible[start - 1]!;
    const current = eligible[start]!;
    if (current.ordinal !== previous.ordinal + 1 || current.time - previous.time > episodeGapMs) break;
    start -= 1;
  }
  while (end + 1 < eligible.length) {
    const current = eligible[end]!;
    const next = eligible[end + 1]!;
    if (next.ordinal !== current.ordinal + 1 || next.time - current.time > episodeGapMs) break;
    end += 1;
  }
  return eligible.slice(start, end + 1);
};

const bestBoundedWindow = (
  episode: readonly SourceRecord[],
  scoredById: ReadonlyMap<string, ScoredRecord>,
  seedId: string,
  maxMessages: number,
): SourceRecord[] => {
  if (episode.length <= maxMessages) return [...episode];
  const seedIndex = episode.findIndex((record) => record.message.id === seedId);
  let bestStart = 0;
  let bestIdentityCount = -1;
  let bestScore = -1;
  let bestMatchCount = -1;
  let bestCenterDistance = Number.POSITIVE_INFINITY;
  for (let start = 0; start + maxMessages <= episode.length; start += 1) {
    const window = episode.slice(start, start + maxMessages);
    const matches = window.flatMap((record) => {
      const scored = scoredById.get(record.message.id);
      return scored ? [scored] : [];
    });
    const identityCount = matches.filter((record) => record.identityMatch).length;
    const score = matches.reduce((total, record) => total + record.score, 0);
    const centerDistance = Math.abs(start + (maxMessages - 1) / 2 - seedIndex);
    const better = identityCount > bestIdentityCount ||
      (identityCount === bestIdentityCount && score > bestScore) ||
      (identityCount === bestIdentityCount && score === bestScore && matches.length > bestMatchCount) ||
      (identityCount === bestIdentityCount && score === bestScore && matches.length === bestMatchCount &&
        centerDistance < bestCenterDistance);
    if (!better) continue;
    bestStart = start;
    bestIdentityCount = identityCount;
    bestScore = score;
    bestMatchCount = matches.length;
    bestCenterDistance = centerDistance;
  }
  return episode.slice(bestStart, bestStart + maxMessages);
};

const witnessesFor = (
  messages: readonly ChatMessage[],
  allowedPersonaIds: IdCollection,
): string[] => {
  const allowed = asIdSet(allowedPersonaIds);
  const witnesses = new Set<string>();
  const add = (id: string | undefined): void => {
    if (id && allowed.has(id)) witnesses.add(id);
  };
  for (const message of messages) {
    add(message.authorId);
    for (const reaction of message.reactions) {
      for (const memberId of reaction.memberIds) add(memberId);
    }
  }
  return [...witnesses];
};

/**
 * Retrieves one bounded, exact public-history episode using only Unicode token
 * identity and corpus rarity. It does not infer intent or meaning and therefore
 * fails closed when the only overlap is common room vocabulary.
 */
export const recallChannelHistory = (input: ChannelRecallInput): ChannelRecallResult | undefined => {
  const triggerTime = Date.parse(input.trigger.createdAt);
  if (!input.trigger.id || !input.trigger.channelId || !Number.isFinite(triggerTime)) return undefined;
  const notBefore = input.notBefore === undefined ? Number.NEGATIVE_INFINITY : Date.parse(input.notBefore);
  if (!Number.isFinite(notBefore) && input.notBefore !== undefined) return undefined;
  if (notBefore > triggerTime) return undefined;
  const queryTokens = channelRecallTokens(input.query.slice(0, MAX_QUERY_CHARACTERS), MAX_QUERY_TOKENS);
  if (queryTokens.length === 0) return undefined;
  const { eligible } = sourceHistory(input, triggerTime, notBefore);
  if (eligible.length === 0) return undefined;

  const participantSubjects = (input.participantSubjects ?? [])
    .filter((subject, index, subjects) =>
      Boolean(subject.id) && subjects.findIndex((candidate) => candidate.id === subject.id) === index
    )
    .slice(0, 2);
  const scored = scoredHistory(eligible, queryTokens, participantSubjects);
  if (scored.length === 0) return undefined;
  const identityMatches = scored.filter((record) => record.identityMatch);
  if (participantSubjects.length > 0 && identityMatches.length === 0) return undefined;
  const seedPool = identityMatches.length > 0 ? identityMatches : scored;
  const seed = [...seedPool].sort((left, right) =>
    right.score - left.score || right.time - left.time || left.message.id.localeCompare(right.message.id)
  )[0];
  if (!seed) return undefined;

  const episodeGapMs = boundedInteger(
    input.episodeGapMs,
    DEFAULT_EPISODE_GAP_MS,
    MIN_EPISODE_GAP_MS,
    MAX_EPISODE_GAP_MS,
  );
  const maxMessages = boundedInteger(input.maxMessages, DEFAULT_MAX_MESSAGES, 1, HARD_MAX_MESSAGES);
  const episode = episodeAround(eligible, seed, episodeGapMs);
  if (episode.length === 0) return undefined;
  const scoredById = new Map(scored.map((record) => [record.message.id, record]));
  const window = bestBoundedWindow(episode, scoredById, seed.message.id, maxMessages);
  const messages = window.map((record) => record.message);
  const anchorMessageIds = messages
    .filter((message) => scoredById.has(message.id))
    .map((message) => message.id);
  if (anchorMessageIds.length === 0) return undefined;
  const anchorIds = new Set(anchorMessageIds);
  const contextMessageIds = messages
    .filter((message) => !anchorIds.has(message.id))
    .map((message) => message.id);
  const rows: ChannelRecallRowMetadata[] = messages.map((message) => {
    const scoredRecord = scoredById.get(message.id);
    const anchorMatches: ChannelRecallAnchorMatch[] = scoredRecord
      ? [
          ...(scoredRecord.identityMatch ? ["author_identity" as const] : []),
          ...(scoredRecord.contentMatch ? ["content" as const] : []),
        ]
      : [];
    return {
      messageId: message.id,
      authorId: message.authorId,
      role: scoredRecord ? "anchor" : "context",
      anchorMatches,
      system: message.system === true,
      generation: message.generation ?? null,
    };
  });
  const windowScore = anchorMessageIds.reduce((total, id) => total + (scoredById.get(id)?.score ?? 0), 0);
  return {
    messages,
    matchedMessageIds: anchorMessageIds,
    anchorMessageIds,
    contextMessageIds,
    rows,
    witnessPersonaIds: witnessesFor(messages, input.allowedPersonaIds),
    score: Number(windowScore.toFixed(6)),
  };
};
