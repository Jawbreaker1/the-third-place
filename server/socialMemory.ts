import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const SCHEMA_VERSION = 5;

const LIMITS = {
  id: 120,
  summary: 600,
  perspective: 800,
  reason: 240,
  sourceMessages: 24,
  participants: 32,
  views: 32,
  relationshipDeltas: 32,
  openLoops: 24,
  openLoopUpdates: 24,
  episodeEvents: 3,
  retrieval: 50,
  consolidationSources: 12,
  recalledMemories: 50,
  consolidationBuckets: 2_500,
} as const;

const DAY_MS = 24 * 60 * 60_000;

/**
 * Conservative, deterministic storage policy. Semantic decisions remain at
 * the model boundary; the store only reasons about explicit metadata and
 * exact identity/scope keys.
 */
export const SOCIAL_MEMORY_LIFECYCLE_DEFAULTS = Object.freeze({
  recallCooldownMs: 6 * 60 * 60_000,
  recallWriteDebounceMs: 10 * 60_000,
  lowSalienceExpiryMs: 45 * DAY_MS,
  standardExpiryMs: 180 * DAY_MS,
  highSalienceExpiryMs: 365 * DAY_MS,
  consolidatedExpiryMs: 540 * DAY_MS,
  supersededRetentionMs: 30 * DAY_MS,
  maxActiveEpisodicPerBucket: 40,
  maxActiveConsolidatedPerBucket: 15,
  maxActivePerOwner: 600,
  maxActiveGlobal: 5_000,
  maxSupersededMemories: 5_000,
  maxPinnedPerOwner: 64,
  maxPinnedGlobal: 512,
  maxOpenLoopsPerOwner: 64,
  maxOpenLoopsGlobal: 2_000,
  maxClosedOpenLoops: 5_000,
  maxPinnedOpenLoopsPerOwner: 16,
  maxPinnedOpenLoopsGlobal: 512,
  maxUpdatesPerOpenLoop: 64,
  defaultConsolidationBatch: 8,
  minimumConsolidationBatch: 4,
  relationshipProvenanceRetentionMs: 90 * DAY_MS,
  relationshipCheckpointRetentionMs: 730 * DAY_MS,
  maxRelationshipCheckpointsPerPair: 128,
  maxRelationshipCheckpoints: 10_000,
  maxRelationshipChangesPerOwner: 1_000,
  maxRelationshipChanges: 20_000,
  maxRelationshipDailyBudgetsPerPair: 730,
  maxRelationshipDailyBudgets: 100_000,
  orphanEventRetentionMs: 30 * DAY_MS,
  maxOrphanEvents: 5_000,
  maxSocialEvents: 500_000,
  closedLoopRetentionMs: 180 * DAY_MS,
  auditRetentionMs: 365 * DAY_MS,
  receiptRetentionMs: 365 * DAY_MS,
  // Must exceed the maximum 2,000 open + 5,000 closed loops because the
  // newest state audit for each retained loop is replay-critical.
  maxAuditEntries: 8_000,
  maxEpisodeReceipts: 20_000,
} as const);

const ID_PATTERN = /^[\p{L}\p{N}_.:@/-]{1,120}$/u;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/u;
const CONTROL_PATTERN = /[\p{Cc}\p{Cf}]/u;
const SECRET_ASSIGNMENT_PATTERN =
  /\b(?:authorization|cookie|session(?:_?token)?|access(?:_?token)?|refresh(?:_?token)?|api[-_ ]?key)\s*[:=]\s*\S+/iu;
const BEARER_PATTERN = /\bbearer\s+[A-Za-z\d._~+/=-]{12,}/iu;
const JWT_PATTERN = /\beyJ[A-Za-z\d_-]{8,}\.[A-Za-z\d_-]{8,}\.[A-Za-z\d_-]{8,}\b/u;
const OPAQUE_TOKEN_PATTERN = /^(?:[A-Fa-f\d]{48,}|[A-Za-z\d+/]{64,}={0,2})$/u;

export type SocialEventOrigin = "human" | "autonomous";
export type SocialEventKind =
  | "shared_moment"
  | "personal_disclosure"
  | "support"
  | "conflict"
  | "repair"
  | "humor"
  | "promise"
  | "request"
  | "boundary"
  | "milestone"
  | "other";

export type SocialMemoryScope =
  | { kind: "public"; channelId: string }
  | { kind: "dm"; threadId: string; participantIds: string[] }
  | { kind: "voice"; roomId: string; participantIds: string[] };

export type RelationshipDimension =
  | "familiarity"
  | "warmth"
  | "trust"
  | "respect"
  | "friction";

export interface RelationshipVector {
  familiarity: number;
  warmth: number;
  trust: number;
  respect: number;
  friction: number;
}

export interface SocialMemoryViewInput {
  id: string;
  ownerId: string;
  subjectIds: string[];
  /** A bounded, subjective recollection. It must not contain raw chat or credentials. */
  perspective: string;
  salience: number;
  confidence: number;
}

export interface RelationshipDeltaInput extends Partial<RelationshipVector> {
  ownerId: string;
  subjectId: string;
}

export type OpenLoopKind = "promise" | "question" | "request" | "plan" | "conflict" | "follow_up";
export type OpenLoopState = "open" | "resolved" | "dismissed";

export interface OpenLoopInput {
  id: string;
  ownerId: string;
  subjectIds: string[];
  kind: OpenLoopKind;
  summary: string;
  dueAt?: number;
}

export interface OpenLoopUpdateInput {
  id: string;
  state: Extract<OpenLoopState, "open" | "resolved">;
  /** Optional refreshed wording when a conversation continues or resolves the loop. */
  summary?: string;
}

/**
 * Input from the semantic extraction boundary. `sourceMessageIds` are mandatory:
 * inferred social state can never exist without a canonical chat source.
 */
export interface RecordSocialEventInput {
  id: string;
  kind: SocialEventKind;
  origin: SocialEventOrigin;
  scope: SocialMemoryScope;
  sourceMessageIds: string[];
  actorIds: string[];
  subjectIds: string[];
  witnessIds: string[];
  occurredAt: number;
  summary: string;
  salience: number;
  confidence: number;
  memoryViews?: SocialMemoryViewInput[];
  relationshipDeltas?: RelationshipDeltaInput[];
  openLoops?: OpenLoopInput[];
  openLoopUpdates?: OpenLoopUpdateInput[];
}

export interface SocialEvent {
  id: string;
  kind: SocialEventKind;
  origin: SocialEventOrigin;
  scope: SocialMemoryScope;
  sourceMessageIds: string[];
  actorIds: string[];
  subjectIds: string[];
  witnessIds: string[];
  occurredAt: number;
  summary: string;
  salience: number;
  confidence: number;
  createdAt: number;
}

export interface SocialMemoryView {
  id: string;
  eventId: string;
  ownerId: string;
  subjectIds: string[];
  perspective: string;
  salience: number;
  confidence: number;
  pinned: boolean;
  tier: "episodic" | "consolidated";
  /** Canonical source events. Consolidated memories may cite several. */
  sourceEventIds: string[];
  recallCount: number;
  lastRecalledAt?: number;
  reinforcedAt: number;
  expiresAt?: number;
  supersededBy?: string;
  createdAt: number;
  updatedAt: number;
  event: Pick<
    SocialEvent,
    "kind" | "origin" | "scope" | "sourceMessageIds" | "summary" | "occurredAt"
  >;
}

export interface RelationshipEdge extends RelationshipVector {
  ownerId: string;
  subjectId: string;
  updatedAt: number;
}

export interface AppliedRelationshipDelta extends RelationshipVector {
  ownerId: string;
  subjectId: string;
  eventId: string;
  origin: SocialEventOrigin;
  dayKey: string;
}

export interface OpenLoop {
  id: string;
  eventId: string;
  ownerId: string;
  subjectIds: string[];
  kind: OpenLoopKind;
  summary: string;
  state: OpenLoopState;
  dueAt?: number;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

export type AuditAction =
  | "memory.pin"
  | "memory.unpin"
  | "memory.delete"
  | "relationship.reset"
  | "loop.pin"
  | "loop.unpin"
  | "loop.state";

export interface AuditEntry {
  id: number;
  adminId: string;
  action: AuditAction;
  targetType: "memory" | "relationship" | "open_loop";
  targetId: string;
  reason?: string;
  metadata: Record<string, boolean | number | string | null>;
  createdAt: number;
}

export interface RecordSocialEventResult {
  created: boolean;
  event: SocialEvent;
  appliedRelationshipDeltas: AppliedRelationshipDelta[];
  updatedOpenLoops: OpenLoop[];
}

export interface SocialEpisodeReceipt {
  episodeId: string;
  fingerprint: string;
  status: "recorded" | "no_events" | "erased";
  participantIds: string[];
  eventIds: string[];
  createdAt: number;
}

export interface RecordSocialEpisodeInput {
  episodeId: string;
  /** Stable fingerprint of the delivered, pre-analysis episode. */
  fingerprint: string;
  participantIds: string[];
  /** Zero events is a durable `no_events` decision. */
  events: RecordSocialEventInput[];
}

export interface RecordSocialEpisodeResult {
  created: boolean;
  receipt: SocialEpisodeReceipt;
  /** Populated only while this call creates the receipt. */
  eventResults: RecordSocialEventResult[];
}

export interface MemoryQuery {
  ownerId: string;
  subjectId?: string;
  /** Exact storage scope, primarily for admin/diagnostic queries. */
  scope?: SocialMemoryScope;
  /**
   * Prompt visibility: all public memories plus only the exact current private
   * audience. Applied before ranking and limiting so hidden scopes cannot
   * crowd relevant recollections out of the bounded result.
   */
  visibleInScope?: SocialMemoryScope;
  limit?: number;
  /** Admin/diagnostic use only. Prompt retrieval must keep the default false. */
  includeInactive?: boolean;
}

export interface RelationshipQuery {
  ownerId?: string;
  subjectId?: string;
  limit?: number;
}

export interface OpenLoopQuery {
  ownerId: string;
  subjectId?: string;
  state?: OpenLoopState;
  /** Exact storage scope. */
  scope?: SocialMemoryScope;
  /** Same pre-limit prompt-visibility policy as MemoryQuery.visibleInScope. */
  visibleInScope?: SocialMemoryScope;
  limit?: number;
}

export interface AuditQuery {
  targetType?: AuditEntry["targetType"];
  targetId?: string;
  limit?: number;
}

export interface SocialMemoryStoreOptions {
  filePath: string;
  now?: () => number;
  humanDailyCaps?: Partial<RelationshipVector>;
  autonomousDailyCaps?: Partial<RelationshipVector>;
}

export interface SocialMemoryDatabaseStatus {
  schemaVersion: number;
  journalMode: string;
  foreignKeys: boolean;
}

export interface SocialMemoryOverview {
  stats: {
    actors: number;
    events: number;
    memories: number;
    relationships: number;
    openLoops: number;
    auditEntries: number;
    activeEpisodicMemories: number;
    consolidatedMemories: number;
    expiredMemories: number;
    supersededMemories: number;
  };
  /** Stable ids only; display names remain the responsibility of the actor registries. */
  actorIds: string[];
}

export interface SocialMemoryForgetResult {
  events: number;
  memories: number;
  relationships: number;
  openLoops: number;
}

export interface ConsolidationBatchQuery {
  limit?: number;
  minimum?: number;
}

export interface ConsolidationCandidateQuery extends ConsolidationBatchQuery {
  /** Deterministic eligible-bucket offset for lifecycle cooldown scans. */
  offset?: number;
}

export interface ConsolidationBatch {
  /** Stable across memory changes within the same exact privacy bucket. */
  bucketId: string;
  ownerId: string;
  subjectIds: string[];
  scope: SocialMemoryScope;
  memoryCount: number;
  windowOffset: number;
  memories: SocialMemoryView[];
}

export interface ApplyMemoryConsolidationInput {
  id: string;
  ownerId: string;
  subjectIds: string[];
  scope: SocialMemoryScope;
  sourceMemoryIds: string[];
  perspective: string;
  salience: number;
  confidence: number;
  at?: number;
  expiresAt?: number;
}

export interface ApplyMemoryConsolidationResult {
  created: boolean;
  memory: SocialMemoryView;
}

export interface SocialMemoryLifecycleStats {
  activeEpisodic: number;
  activeConsolidated: number;
  expired: number;
  superseded: number;
  pinned: number;
  recalled: number;
  provenanceLinks: number;
  relationshipCheckpoints: number;
  relationshipChanges: number;
  relationshipDailyBudgets: number;
}

export interface LifecycleMaintenanceOptions {
  now?: number;
}

export interface LifecycleMaintenanceResult {
  now: number;
  expiredMemories: number;
  deletedMemories: number;
  deletedSupersededMemories: number;
  checkpointedRelationshipChanges: number;
  prunedRelationshipCheckpoints: number;
  prunedRelationshipDailyBudgets: number;
  dismissedOpenLoopOverflow: number;
  prunedClosedLoops: number;
  prunedEvents: number;
  prunedAuditEntries: number;
  prunedEpisodeReceipts: number;
  protectedOverflow: {
    buckets: number;
    owners: number;
    global: number;
  };
  stats: SocialMemoryLifecycleStats;
}

const DEFAULT_HUMAN_CAPS: RelationshipVector = {
  familiarity: 0.2,
  warmth: 0.18,
  trust: 0.15,
  respect: 0.15,
  friction: 0.2,
};

const DEFAULT_AUTONOMOUS_CAPS: RelationshipVector = {
  familiarity: 0.01,
  warmth: 0.008,
  trust: 0.006,
  respect: 0.006,
  friction: 0.01,
};

/**
 * Autonomous chat can run around the clock. These signed lifetime envelopes
 * prevent tiny daily deltas from eventually manufacturing extreme intimacy or
 * hostility. Human-origin events are deliberately not subject to this guard.
 */
const AUTONOMOUS_LIFETIME_ENVELOPES: RelationshipVector = {
  familiarity: 0.35,
  warmth: 0.3,
  trust: 0.25,
  respect: 0.25,
  friction: 0.3,
};

const DIMENSIONS: RelationshipDimension[] = [
  "familiarity",
  "warmth",
  "trust",
  "respect",
  "friction",
];

const EVENT_KINDS = new Set<SocialEventKind>([
  "shared_moment",
  "personal_disclosure",
  "support",
  "conflict",
  "repair",
  "humor",
  "promise",
  "request",
  "boundary",
  "milestone",
  "other",
]);
const LOOP_KINDS = new Set<OpenLoopKind>([
  "promise",
  "question",
  "request",
  "plan",
  "conflict",
  "follow_up",
]);
const LOOP_STATES = new Set<OpenLoopState>(["open", "resolved", "dismissed"]);

const assertNoSecret = (value: string, label: string): void => {
  if (
    SECRET_ASSIGNMENT_PATTERN.test(value) ||
    BEARER_PATTERN.test(value) ||
    JWT_PATTERN.test(value) ||
    OPAQUE_TOKEN_PATTERN.test(value)
  ) {
    throw new Error(`${label} must not contain credentials or raw auth tokens`);
  }
};

const cleanId = (value: unknown, label: string): string => {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const result = value.normalize("NFKC").trim();
  if (result.length > LIMITS.id || !ID_PATTERN.test(result) || CONTROL_PATTERN.test(result)) {
    throw new Error(`${label} is not a safe bounded identifier`);
  }
  assertNoSecret(result, label);
  return result;
};

const cleanFingerprint = (value: unknown): string => {
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) {
    throw new Error("fingerprint must be a lowercase SHA-256 hex digest");
  }
  // A content digest is intentionally opaque; unlike general persisted text,
  // it is not a credential and must not pass through the token-secret guard.
  return value;
};

const cleanText = (value: unknown, maximum: number, label: string): string => {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  if (CONTROL_PATTERN.test(value)) throw new Error(`${label} contains unsafe control characters`);
  const result = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  if (!result || result.length > maximum) throw new Error(`${label} must contain 1..${maximum} characters`);
  assertNoSecret(result, label);
  return result;
};

const cleanTimestamp = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw new Error(`${label} must be a non-negative safe epoch millisecond timestamp`);
  }
  return value;
};

const cleanUnit = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite number between 0 and 1`);
  }
  return value;
};

const cleanDelta = (value: unknown, label: string): number => {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < -1 || value > 1) {
    throw new Error(`${label} must be a finite number between -1 and 1`);
  }
  return value;
};

const cleanUniqueIds = (value: unknown, maximum: number, label: string, minimum = 0): string[] => {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must contain ${minimum}..${maximum} identifiers`);
  }
  const result = [...new Set(value.map((candidate, index) => cleanId(candidate, `${label}[${index}]`)))].sort();
  if (result.length !== value.length) throw new Error(`${label} must not contain duplicate identifiers`);
  return result;
};

const cleanLimit = (value: unknown, maximum: number = LIMITS.retrieval): number => {
  if (value === undefined) return 20;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("limit must be a positive integer");
  }
  return Math.min(value, maximum);
};

const cleanConsolidationCount = (value: unknown, fallback: number, label: string): number => {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 2) {
    throw new Error(`${label} must be an integer of at least 2`);
  }
  return Math.min(value, LIMITS.consolidationSources);
};

const memoryExpiryFor = (at: number, salience: number, tier: SocialMemoryView["tier"]): number => {
  if (tier === "consolidated") return at + SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.consolidatedExpiryMs;
  if (salience < 0.45) return at + SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.lowSalienceExpiryMs;
  if (salience < 0.75) return at + SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.standardExpiryMs;
  return at + SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.highSalienceExpiryMs;
};

const scopeParts = (scope: SocialMemoryScope): {
  scope: SocialMemoryScope;
  kind: SocialMemoryScope["kind"];
  id: string;
  participants: string[];
} => {
  if (!scope || typeof scope !== "object") throw new TypeError("scope must be an object");
  if (scope.kind === "public") {
    const channelId = cleanId(scope.channelId, "scope.channelId");
    return { scope: { kind: "public", channelId }, kind: "public", id: channelId, participants: [] };
  }
  if (scope.kind === "dm") {
    const threadId = cleanId(scope.threadId, "scope.threadId");
    const participantIds = cleanUniqueIds(scope.participantIds, LIMITS.participants, "scope.participantIds", 2);
    return {
      scope: { kind: "dm", threadId, participantIds },
      kind: "dm",
      id: threadId,
      participants: participantIds,
    };
  }
  if (scope.kind === "voice") {
    const roomId = cleanId(scope.roomId, "scope.roomId");
    const participantIds = cleanUniqueIds(scope.participantIds, LIMITS.participants, "scope.participantIds", 1);
    return {
      scope: { kind: "voice", roomId, participantIds },
      kind: "voice",
      id: roomId,
      participants: participantIds,
    };
  }
  throw new Error("scope.kind must be public, dm, or voice");
};

const appendPromptVisibilityClause = (
  clauses: string[],
  parameters: SQLInputValue[],
  tableAlias: string,
  currentScope: SocialMemoryScope,
): void => {
  const current = scopeParts(currentScope);
  if (current.kind === "public") {
    clauses.push(`${tableAlias}.scope_kind = 'public'`);
    return;
  }
  if (current.kind === "dm") {
    clauses.push(
      `(${tableAlias}.scope_kind = 'public' OR (` +
      `${tableAlias}.scope_kind = 'dm' AND ${tableAlias}.scope_id = ? AND ` +
      `${tableAlias}.scope_participants_json = ?))`,
    );
    parameters.push(current.id, JSON.stringify(current.participants));
    return;
  }
  // Voice recollections survive a room session ID change only when the exact
  // private audience is unchanged. Public history remains safe to remember.
  clauses.push(
    `(${tableAlias}.scope_kind = 'public' OR (` +
    `${tableAlias}.scope_kind = 'voice' AND ${tableAlias}.scope_participants_json = ?))`,
  );
  parameters.push(JSON.stringify(current.participants));
};

interface NormalizedRecordInput extends Omit<
  RecordSocialEventInput,
  "scope" | "memoryViews" | "relationshipDeltas" | "openLoops" | "openLoopUpdates"
> {
  scope: SocialMemoryScope;
  memoryViews: SocialMemoryViewInput[];
  relationshipDeltas: Array<RelationshipDeltaInput & RelationshipVector>;
  openLoops: OpenLoopInput[];
  openLoopUpdates: OpenLoopUpdateInput[];
}

const normalizeRecordInput = (input: RecordSocialEventInput): NormalizedRecordInput => {
  if (!input || typeof input !== "object") throw new TypeError("event input must be an object");
  if (!EVENT_KINDS.has(input.kind)) throw new Error("event kind is not supported");
  if (input.origin !== "human" && input.origin !== "autonomous") {
    throw new Error("event origin must be human or autonomous");
  }
  const scoped = scopeParts(input.scope);
  const actorIds = cleanUniqueIds(input.actorIds, LIMITS.participants, "actorIds", 1);
  const subjectIds = cleanUniqueIds(input.subjectIds, LIMITS.participants, "subjectIds");
  const witnessIds = cleanUniqueIds(input.witnessIds, LIMITS.participants, "witnessIds");
  const sourceMessageIds = cleanUniqueIds(
    input.sourceMessageIds,
    LIMITS.sourceMessages,
    "sourceMessageIds",
    1,
  );

  if (scoped.kind !== "public") {
    const participants = new Set(scoped.participants);
    for (const actorId of actorIds) {
      if (!participants.has(actorId)) throw new Error("private/voice event actors must be scope participants");
    }
    for (const witnessId of witnessIds) {
      if (!participants.has(witnessId)) throw new Error("private/voice witnesses must be scope participants");
    }
  }

  // Merely being listed in a private/voice scope is not evidence that an actor
  // heard this particular source episode. Subjective state may only be owned by
  // a source author or an explicit witness.
  const observers = new Set([...actorIds, ...witnessIds]);
  const involved = new Set([...observers, ...subjectIds, ...scoped.participants]);
  const memoryViews = (input.memoryViews ?? []).map((view, index): SocialMemoryViewInput => {
    if (!view || typeof view !== "object") throw new TypeError(`memoryViews[${index}] must be an object`);
    const ownerId = cleanId(view.ownerId, `memoryViews[${index}].ownerId`);
    if (!observers.has(ownerId)) throw new Error("memory owner must be a source actor or have witnessed the event explicitly");
    const viewSubjectIds = cleanUniqueIds(
      view.subjectIds,
      LIMITS.participants,
      `memoryViews[${index}].subjectIds`,
      1,
    );
    if (viewSubjectIds.some((subjectId) => !involved.has(subjectId))) {
      throw new Error("memory subjects must be involved in the source event");
    }
    return {
      id: cleanId(view.id, `memoryViews[${index}].id`),
      ownerId,
      subjectIds: viewSubjectIds,
      perspective: cleanText(view.perspective, LIMITS.perspective, `memoryViews[${index}].perspective`),
      salience: cleanUnit(view.salience, `memoryViews[${index}].salience`),
      confidence: cleanUnit(view.confidence, `memoryViews[${index}].confidence`),
    };
  });
  if (memoryViews.length > LIMITS.views) throw new Error(`memoryViews may contain at most ${LIMITS.views} items`);
  if (new Set(memoryViews.map((view) => view.id)).size !== memoryViews.length) {
    throw new Error("memoryViews must not contain duplicate ids");
  }
  if (new Set(memoryViews.map((view) => view.ownerId)).size !== memoryViews.length) {
    throw new Error("an event may have only one memory view per owner");
  }

  const relationshipDeltas = (input.relationshipDeltas ?? []).map(
    (delta, index): RelationshipDeltaInput & RelationshipVector => {
      if (!delta || typeof delta !== "object") {
        throw new TypeError(`relationshipDeltas[${index}] must be an object`);
      }
      const ownerId = cleanId(delta.ownerId, `relationshipDeltas[${index}].ownerId`);
      const subjectId = cleanId(delta.subjectId, `relationshipDeltas[${index}].subjectId`);
      if (ownerId === subjectId) throw new Error("a relationship edge cannot point to itself");
      if (!observers.has(ownerId) || !involved.has(subjectId)) {
        throw new Error("relationship deltas require a source actor or explicit witness as owner and an involved subject");
      }
      const normalized = {
        ownerId,
        subjectId,
        familiarity: cleanDelta(delta.familiarity, `relationshipDeltas[${index}].familiarity`),
        warmth: cleanDelta(delta.warmth, `relationshipDeltas[${index}].warmth`),
        trust: cleanDelta(delta.trust, `relationshipDeltas[${index}].trust`),
        respect: cleanDelta(delta.respect, `relationshipDeltas[${index}].respect`),
        friction: cleanDelta(delta.friction, `relationshipDeltas[${index}].friction`),
      };
      if (DIMENSIONS.every((dimension) => normalized[dimension] === 0)) {
        throw new Error("relationship delta must change at least one dimension");
      }
      return normalized;
    },
  );
  if (relationshipDeltas.length > LIMITS.relationshipDeltas) {
    throw new Error(`relationshipDeltas may contain at most ${LIMITS.relationshipDeltas} items`);
  }
  if (
    new Set(relationshipDeltas.map((delta) => `${delta.ownerId}\u0000${delta.subjectId}`)).size !==
    relationshipDeltas.length
  ) {
    throw new Error("an event may change a directed relationship only once");
  }

  const openLoops = (input.openLoops ?? []).map((loop, index): OpenLoopInput => {
    if (!loop || typeof loop !== "object") throw new TypeError(`openLoops[${index}] must be an object`);
    if (!LOOP_KINDS.has(loop.kind)) throw new Error(`openLoops[${index}].kind is not supported`);
    const ownerId = cleanId(loop.ownerId, `openLoops[${index}].ownerId`);
    if (!observers.has(ownerId)) throw new Error("open-loop owner must be a source actor or explicit witness");
    const loopSubjectIds = cleanUniqueIds(
      loop.subjectIds,
      LIMITS.participants,
      `openLoops[${index}].subjectIds`,
    );
    if (loopSubjectIds.some((subjectId) => !involved.has(subjectId))) {
      throw new Error("open-loop subjects must be involved in the source event");
    }
    return {
      id: cleanId(loop.id, `openLoops[${index}].id`),
      ownerId,
      subjectIds: loopSubjectIds,
      kind: loop.kind,
      summary: cleanText(loop.summary, LIMITS.summary, `openLoops[${index}].summary`),
      ...(loop.dueAt === undefined ? {} : { dueAt: cleanTimestamp(loop.dueAt, `openLoops[${index}].dueAt`) }),
    };
  });
  if (openLoops.length > LIMITS.openLoops) throw new Error(`openLoops may contain at most ${LIMITS.openLoops} items`);
  if (new Set(openLoops.map((loop) => loop.id)).size !== openLoops.length) {
    throw new Error("openLoops must not contain duplicate ids");
  }

  const openLoopUpdates = (input.openLoopUpdates ?? []).map(
    (update, index): OpenLoopUpdateInput => {
      if (!update || typeof update !== "object") {
        throw new TypeError(`openLoopUpdates[${index}] must be an object`);
      }
      if (update.state !== "open" && update.state !== "resolved") {
        throw new Error(`openLoopUpdates[${index}].state must be open or resolved`);
      }
      return {
        id: cleanId(update.id, `openLoopUpdates[${index}].id`),
        state: update.state,
        ...(update.summary === undefined
          ? {}
          : {
              summary: cleanText(
                update.summary,
                LIMITS.summary,
                `openLoopUpdates[${index}].summary`,
              ),
            }),
      };
    },
  );
  if (openLoopUpdates.length > LIMITS.openLoopUpdates) {
    throw new Error(`openLoopUpdates may contain at most ${LIMITS.openLoopUpdates} items`);
  }
  if (new Set(openLoopUpdates.map((update) => update.id)).size !== openLoopUpdates.length) {
    throw new Error("openLoopUpdates must not contain duplicate ids");
  }
  const newlyCreatedLoopIds = new Set(openLoops.map((loop) => loop.id));
  if (openLoopUpdates.some((update) => newlyCreatedLoopIds.has(update.id))) {
    throw new Error("an event cannot create and update the same open loop");
  }

  return {
    id: cleanId(input.id, "id"),
    kind: input.kind,
    origin: input.origin,
    scope: scoped.scope,
    sourceMessageIds,
    actorIds,
    subjectIds,
    witnessIds,
    occurredAt: cleanTimestamp(input.occurredAt, "occurredAt"),
    summary: cleanText(input.summary, LIMITS.summary, "summary"),
    salience: cleanUnit(input.salience, "salience"),
    confidence: cleanUnit(input.confidence, "confidence"),
    memoryViews: memoryViews.sort((left, right) => left.id.localeCompare(right.id)),
    relationshipDeltas: relationshipDeltas.sort((left, right) =>
      `${left.ownerId}\u0000${left.subjectId}`.localeCompare(`${right.ownerId}\u0000${right.subjectId}`),
    ),
    openLoops: openLoops.sort((left, right) => left.id.localeCompare(right.id)),
    openLoopUpdates: openLoopUpdates.sort((left, right) => left.id.localeCompare(right.id)),
  };
};

const stableHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const dimensionRange = (dimension: RelationshipDimension): [number, number] =>
  dimension === "familiarity" || dimension === "friction" ? [0, 1] : [-1, 1];

const cleanCaps = (partial: Partial<RelationshipVector> | undefined, defaults: RelationshipVector): RelationshipVector => {
  const result = { ...defaults };
  if (!partial) return result;
  for (const dimension of DIMENSIONS) {
    const value = partial[dimension];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${dimension} daily cap must be between 0 and 1`);
    }
    result[dimension] = value;
  }
  return result;
};

const rowString = (row: Record<string, unknown>, key: string): string => String(row[key]);
const rowNumber = (row: Record<string, unknown>, key: string): number => Number(row[key]);

const migrationOne = `
  CREATE TABLE social_events (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    origin TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    scope_participants_json TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    summary TEXT NOT NULL,
    salience REAL NOT NULL,
    confidence REAL NOT NULL,
    payload_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE event_sources (
    event_id TEXT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    PRIMARY KEY (event_id, message_id)
  ) STRICT;
  CREATE TABLE event_actors (
    event_id TEXT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL,
    PRIMARY KEY (event_id, actor_id)
  ) STRICT;
  CREATE TABLE event_subjects (
    event_id TEXT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
    subject_id TEXT NOT NULL,
    PRIMARY KEY (event_id, subject_id)
  ) STRICT;
  CREATE TABLE event_witnesses (
    event_id TEXT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
    witness_id TEXT NOT NULL,
    PRIMARY KEY (event_id, witness_id)
  ) STRICT;
  CREATE TABLE memory_views (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    perspective TEXT NOT NULL,
    salience REAL NOT NULL,
    confidence REAL NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    tier TEXT NOT NULL DEFAULT 'episodic' CHECK (tier IN ('episodic', 'consolidated')),
    recall_count INTEGER NOT NULL DEFAULT 0 CHECK (recall_count >= 0),
    last_recalled_at INTEGER,
    reinforced_at INTEGER NOT NULL,
    expires_at INTEGER,
    superseded_by TEXT,
    lifecycle_hash TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (event_id, owner_id)
  ) STRICT;
  CREATE TABLE memory_subjects (
    memory_id TEXT NOT NULL REFERENCES memory_views(id) ON DELETE CASCADE,
    subject_id TEXT NOT NULL,
    PRIMARY KEY (memory_id, subject_id)
  ) STRICT;
  CREATE TABLE memory_consolidation_inputs (
    memory_id TEXT NOT NULL REFERENCES memory_views(id) ON DELETE CASCADE,
    source_memory_id TEXT NOT NULL,
    PRIMARY KEY (memory_id, source_memory_id)
  ) STRICT;
  CREATE TABLE memory_provenance (
    memory_id TEXT NOT NULL REFERENCES memory_views(id) ON DELETE CASCADE,
    source_event_id TEXT NOT NULL,
    source_message_ids_json TEXT NOT NULL,
    participant_ids_json TEXT NOT NULL,
    PRIMARY KEY (memory_id, source_event_id)
  ) STRICT;
  CREATE TABLE relationship_edges (
    owner_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    familiarity REAL NOT NULL,
    warmth REAL NOT NULL,
    trust REAL NOT NULL,
    respect REAL NOT NULL,
    friction REAL NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, subject_id),
    CHECK (owner_id <> subject_id)
  ) STRICT;
  CREATE TABLE relationship_changes (
    event_id TEXT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    origin TEXT NOT NULL,
    day_key TEXT NOT NULL,
    familiarity REAL NOT NULL,
    warmth REAL NOT NULL,
    trust REAL NOT NULL,
    respect REAL NOT NULL,
    friction REAL NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (event_id, owner_id, subject_id)
  ) STRICT;
  CREATE TABLE relationship_checkpoints (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('human', 'autonomous')),
    day_key TEXT NOT NULL,
    participant_ids_json TEXT NOT NULL,
    familiarity REAL NOT NULL,
    warmth REAL NOT NULL,
    trust REAL NOT NULL,
    respect REAL NOT NULL,
    friction REAL NOT NULL,
    spent_familiarity REAL NOT NULL CHECK (spent_familiarity >= 0),
    spent_warmth REAL NOT NULL CHECK (spent_warmth >= 0),
    spent_trust REAL NOT NULL CHECK (spent_trust >= 0),
    spent_respect REAL NOT NULL CHECK (spent_respect >= 0),
    spent_friction REAL NOT NULL CHECK (spent_friction >= 0),
    through_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (owner_id, subject_id, origin, day_key, participant_ids_json),
    CHECK (owner_id <> subject_id)
  ) STRICT;
  CREATE TABLE relationship_daily_budgets (
    owner_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('human', 'autonomous')),
    day_key TEXT NOT NULL,
    spent_familiarity REAL NOT NULL CHECK (spent_familiarity >= 0),
    spent_warmth REAL NOT NULL CHECK (spent_warmth >= 0),
    spent_trust REAL NOT NULL CHECK (spent_trust >= 0),
    spent_respect REAL NOT NULL CHECK (spent_respect >= 0),
    spent_friction REAL NOT NULL CHECK (spent_friction >= 0),
    through_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, subject_id, origin, day_key),
    CHECK (owner_id <> subject_id)
  ) STRICT;
  CREATE TABLE open_loops (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    initial_summary TEXT NOT NULL,
    summary TEXT NOT NULL,
    state TEXT NOT NULL,
    due_at INTEGER,
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE open_loop_subjects (
    loop_id TEXT NOT NULL REFERENCES open_loops(id) ON DELETE CASCADE,
    subject_id TEXT NOT NULL,
    PRIMARY KEY (loop_id, subject_id)
  ) STRICT;
  CREATE TABLE open_loop_updates (
    event_id TEXT NOT NULL REFERENCES social_events(id) ON DELETE CASCADE,
    loop_id TEXT NOT NULL REFERENCES open_loops(id) ON DELETE CASCADE,
    previous_state TEXT NOT NULL,
    next_state TEXT NOT NULL,
    previous_summary TEXT NOT NULL,
    next_summary TEXT NOT NULL,
    summary_override TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (event_id, loop_id)
  ) STRICT;
  CREATE TABLE audit_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    reason TEXT,
    metadata_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE episode_receipts (
    episode_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    events_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('recorded', 'no_events', 'erased')),
    participant_ids_json TEXT NOT NULL,
    event_ids_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE social_memory_lifecycle_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX memory_owner_recency ON memory_views(owner_id, pinned DESC, updated_at DESC);
  CREATE INDEX memory_lifecycle_lookup
    ON memory_views(owner_id, tier, superseded_by, expires_at, reinforced_at DESC);
  CREATE INDEX memory_subject_lookup ON memory_subjects(subject_id, memory_id);
  CREATE INDEX memory_provenance_event_lookup ON memory_provenance(source_event_id, memory_id);
  CREATE INDEX event_scope_recency ON social_events(scope_kind, scope_id, occurred_at DESC);
  CREATE INDEX relation_subject_lookup ON relationship_edges(subject_id, owner_id);
  CREATE INDEX relation_budget_lookup
    ON relationship_changes(owner_id, subject_id, origin, day_key);
  CREATE INDEX loop_owner_state ON open_loops(owner_id, state, pinned DESC, updated_at DESC);
  CREATE INDEX loop_subject_lookup ON open_loop_subjects(subject_id, loop_id);
  CREATE INDEX audit_target_recency ON audit_entries(target_type, target_id, created_at DESC);
`;

const migrationTwo = `
  ALTER TABLE open_loops ADD COLUMN initial_summary TEXT;
  UPDATE open_loops
  SET initial_summary = COALESCE(
    (SELECT previous_summary FROM open_loop_updates u
     WHERE u.loop_id = open_loops.id
     ORDER BY u.created_at ASC, u.rowid ASC LIMIT 1),
    summary
  );
  ALTER TABLE open_loop_updates ADD COLUMN summary_override TEXT;
  UPDATE open_loop_updates
  SET summary_override = CASE
    WHEN next_summary <> previous_summary THEN next_summary
    ELSE NULL
  END;
  CREATE TABLE episode_receipts (
    episode_id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    events_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('recorded', 'no_events', 'erased')),
    participant_ids_json TEXT NOT NULL,
    event_ids_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;
`;

const migrationThree = `
  ALTER TABLE memory_views ADD COLUMN tier TEXT NOT NULL DEFAULT 'episodic'
    CHECK (tier IN ('episodic', 'consolidated'));
  ALTER TABLE memory_views ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0
    CHECK (recall_count >= 0);
  ALTER TABLE memory_views ADD COLUMN last_recalled_at INTEGER;
  ALTER TABLE memory_views ADD COLUMN reinforced_at INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE memory_views ADD COLUMN expires_at INTEGER;
  ALTER TABLE memory_views ADD COLUMN superseded_by TEXT;
  ALTER TABLE memory_views ADD COLUMN lifecycle_hash TEXT;
  UPDATE memory_views SET reinforced_at = updated_at WHERE reinforced_at = 0;
  UPDATE memory_views SET expires_at = reinforced_at + CASE
    WHEN salience < 0.45 THEN ${SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.lowSalienceExpiryMs}
    WHEN salience < 0.75 THEN ${SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.standardExpiryMs}
    ELSE ${SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.highSalienceExpiryMs}
  END WHERE expires_at IS NULL;
  CREATE TABLE memory_consolidation_inputs (
    memory_id TEXT NOT NULL REFERENCES memory_views(id) ON DELETE CASCADE,
    source_memory_id TEXT NOT NULL,
    PRIMARY KEY (memory_id, source_memory_id)
  ) STRICT;
  CREATE TABLE memory_provenance (
    memory_id TEXT NOT NULL REFERENCES memory_views(id) ON DELETE CASCADE,
    source_event_id TEXT NOT NULL,
    source_message_ids_json TEXT NOT NULL,
    participant_ids_json TEXT NOT NULL,
    PRIMARY KEY (memory_id, source_event_id)
  ) STRICT;
  CREATE TABLE relationship_checkpoints (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('human', 'autonomous')),
    participant_ids_json TEXT NOT NULL,
    familiarity REAL NOT NULL,
    warmth REAL NOT NULL,
    trust REAL NOT NULL,
    respect REAL NOT NULL,
    friction REAL NOT NULL,
    through_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (owner_id, subject_id, origin, participant_ids_json),
    CHECK (owner_id <> subject_id)
  ) STRICT;
  CREATE INDEX memory_lifecycle_lookup
    ON memory_views(owner_id, tier, superseded_by, expires_at, reinforced_at DESC);
  CREATE INDEX memory_provenance_event_lookup ON memory_provenance(source_event_id, memory_id);
`;

const migrationFour = `
  ALTER TABLE relationship_checkpoints RENAME TO relationship_checkpoints_v3;
  CREATE TABLE relationship_checkpoints (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('human', 'autonomous')),
    day_key TEXT NOT NULL,
    participant_ids_json TEXT NOT NULL,
    familiarity REAL NOT NULL,
    warmth REAL NOT NULL,
    trust REAL NOT NULL,
    respect REAL NOT NULL,
    friction REAL NOT NULL,
    spent_familiarity REAL NOT NULL CHECK (spent_familiarity >= 0),
    spent_warmth REAL NOT NULL CHECK (spent_warmth >= 0),
    spent_trust REAL NOT NULL CHECK (spent_trust >= 0),
    spent_respect REAL NOT NULL CHECK (spent_respect >= 0),
    spent_friction REAL NOT NULL CHECK (spent_friction >= 0),
    through_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (owner_id, subject_id, origin, day_key, participant_ids_json),
    CHECK (owner_id <> subject_id)
  ) STRICT;
  INSERT INTO relationship_checkpoints
    (id, owner_id, subject_id, origin, day_key, participant_ids_json,
     familiarity, warmth, trust, respect, friction,
     spent_familiarity, spent_warmth, spent_trust, spent_respect, spent_friction,
     through_at, updated_at)
  SELECT id, owner_id, subject_id, origin, 'legacy',
         participant_ids_json,
         familiarity, warmth, trust, respect, friction,
         ABS(familiarity), ABS(warmth), ABS(trust), ABS(respect), ABS(friction),
         through_at, updated_at
  FROM relationship_checkpoints_v3;
  DROP TABLE relationship_checkpoints_v3;
  CREATE TABLE social_memory_lifecycle_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;
  UPDATE memory_views SET pinned = 0 WHERE id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY owner_id ORDER BY updated_at DESC, created_at DESC, id DESC
      ) AS pin_rank
      FROM memory_views WHERE pinned = 1
    ) WHERE pin_rank > ${SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxPinnedPerOwner}
  );
  UPDATE memory_views SET pinned = 0 WHERE id IN (
    SELECT id FROM memory_views WHERE pinned = 1
    ORDER BY updated_at ASC, created_at ASC, id ASC
    LIMIT MAX(0, (SELECT COUNT(*) FROM memory_views WHERE pinned = 1) -
      ${SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxPinnedGlobal})
  );
  UPDATE open_loops SET pinned = 0 WHERE id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY owner_id ORDER BY updated_at DESC, created_at DESC, id DESC
      ) AS pin_rank
      FROM open_loops WHERE pinned = 1
    ) WHERE pin_rank > ${SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxPinnedOpenLoopsPerOwner}
  );
  UPDATE open_loops SET pinned = 0 WHERE id IN (
    SELECT id FROM open_loops WHERE pinned = 1
    ORDER BY updated_at ASC, created_at ASC, id ASC
    LIMIT MAX(0, (SELECT COUNT(*) FROM open_loops WHERE pinned = 1) -
      ${SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxPinnedOpenLoopsGlobal})
  );
`;

const migrationFive = `
  CREATE TABLE relationship_daily_budgets (
    owner_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('human', 'autonomous')),
    day_key TEXT NOT NULL,
    spent_familiarity REAL NOT NULL CHECK (spent_familiarity >= 0),
    spent_warmth REAL NOT NULL CHECK (spent_warmth >= 0),
    spent_trust REAL NOT NULL CHECK (spent_trust >= 0),
    spent_respect REAL NOT NULL CHECK (spent_respect >= 0),
    spent_friction REAL NOT NULL CHECK (spent_friction >= 0),
    through_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner_id, subject_id, origin, day_key),
    CHECK (owner_id <> subject_id)
  ) STRICT;
  WITH daily_spend AS (
    SELECT c.owner_id, c.subject_id, c.origin, c.day_key,
           ABS(c.familiarity) AS spent_familiarity,
           ABS(c.warmth) AS spent_warmth,
           ABS(c.trust) AS spent_trust,
           ABS(c.respect) AS spent_respect,
           ABS(c.friction) AS spent_friction,
           e.occurred_at AS through_at,
           c.created_at AS updated_at
    FROM relationship_changes c
    JOIN social_events e ON e.id = c.event_id
    UNION ALL
    SELECT owner_id, subject_id, origin, day_key,
           spent_familiarity, spent_warmth, spent_trust,
           spent_respect, spent_friction, through_at, updated_at
    FROM relationship_checkpoints
    WHERE day_key <> 'legacy'
  )
  INSERT INTO relationship_daily_budgets
    (owner_id, subject_id, origin, day_key,
     spent_familiarity, spent_warmth, spent_trust, spent_respect, spent_friction,
     through_at, updated_at)
  SELECT owner_id, subject_id, origin, day_key,
         SUM(spent_familiarity), SUM(spent_warmth), SUM(spent_trust),
         SUM(spent_respect), SUM(spent_friction),
         MAX(through_at), MAX(updated_at)
  FROM daily_spend
  GROUP BY owner_id, subject_id, origin, day_key;
`;

/** Synchronous SQLite domain store; callers should keep one instance per process. */
export class SocialMemoryStore {
  readonly #database: DatabaseSync;
  readonly #now: () => number;
  readonly #humanCaps: RelationshipVector;
  readonly #autonomousCaps: RelationshipVector;

  constructor(options: SocialMemoryStoreOptions) {
    const filePath = options?.filePath;
    if (typeof filePath !== "string" || !filePath.trim()) throw new Error("filePath is required");
    if (filePath !== ":memory:") mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(filePath);
    this.#now = options.now ?? Date.now;
    this.#humanCaps = cleanCaps(options.humanDailyCaps, DEFAULT_HUMAN_CAPS);
    this.#autonomousCaps = cleanCaps(options.autonomousDailyCaps, DEFAULT_AUTONOMOUS_CAPS);
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.#database.exec("PRAGMA journal_mode = WAL;");
    this.#migrate();
    if (filePath !== ":memory:") {
      for (const privateFile of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
        if (existsSync(privateFile)) chmodSync(privateFile, 0o600);
      }
    }
  }

  close(): void {
    this.#database.close();
  }

  status(): SocialMemoryDatabaseStatus {
    const version = this.#database.prepare("PRAGMA user_version").get() as Record<string, unknown>;
    const journal = this.#database.prepare("PRAGMA journal_mode").get() as Record<string, unknown>;
    const foreignKeys = this.#database.prepare("PRAGMA foreign_keys").get() as Record<string, unknown>;
    return {
      schemaVersion: Number(version.user_version),
      journalMode: String(journal.journal_mode),
      foreignKeys: Number(foreignKeys.foreign_keys) === 1,
    };
  }

  lifecycleStats(at = this.#nowTimestamp()): SocialMemoryLifecycleStats {
    const now = cleanTimestamp(at, "at");
    const protectedIds = this.#unresolvedLoopBackedMemoryIds();
    const rows = this.#database.prepare(
      `SELECT id, tier, pinned, recall_count, expires_at, superseded_by
       FROM memory_views`,
    ).all() as Record<string, unknown>[];
    let activeEpisodic = 0;
    let activeConsolidated = 0;
    let expired = 0;
    let superseded = 0;
    let pinned = 0;
    let recalled = 0;
    for (const row of rows) {
      const id = rowString(row, "id");
      const isPinned = rowNumber(row, "pinned") === 1;
      const isSuperseded = row.superseded_by !== null;
      const isExpired = row.expires_at !== null && rowNumber(row, "expires_at") <= now;
      if (isPinned) pinned += 1;
      if (rowNumber(row, "recall_count") > 0) recalled += 1;
      if (isSuperseded) superseded += 1;
      else if (isExpired && !isPinned && !protectedIds.has(id)) expired += 1;
      else if (rowString(row, "tier") === "consolidated") activeConsolidated += 1;
      else activeEpisodic += 1;
    }
    const provenance = this.#database.prepare(
      "SELECT COUNT(*) AS count FROM memory_provenance",
    ).get() as Record<string, unknown>;
    const relationshipCheckpoints = this.#database.prepare(
      "SELECT COUNT(*) AS count FROM relationship_checkpoints",
    ).get() as Record<string, unknown>;
    const relationshipChanges = this.#database.prepare(
      "SELECT COUNT(*) AS count FROM relationship_changes",
    ).get() as Record<string, unknown>;
    const relationshipDailyBudgets = this.#database.prepare(
      "SELECT COUNT(*) AS count FROM relationship_daily_budgets",
    ).get() as Record<string, unknown>;
    return {
      activeEpisodic,
      activeConsolidated,
      expired,
      superseded,
      pinned,
      recalled,
      provenanceLinks: rowNumber(provenance, "count"),
      relationshipCheckpoints: rowNumber(relationshipCheckpoints, "count"),
      relationshipChanges: rowNumber(relationshipChanges, "count"),
      relationshipDailyBudgets: rowNumber(relationshipDailyBudgets, "count"),
    };
  }

  overview(): SocialMemoryOverview {
    const lifecycle = this.lifecycleStats();
    const actorRows = this.#database
      .prepare(
        `SELECT actor_id FROM (
           SELECT actor_id FROM event_actors
           UNION SELECT subject_id AS actor_id FROM event_subjects
           UNION SELECT witness_id AS actor_id FROM event_witnesses
           UNION SELECT owner_id AS actor_id FROM memory_views
           UNION SELECT owner_id AS actor_id FROM relationship_edges
           UNION SELECT subject_id AS actor_id FROM relationship_edges
           UNION SELECT owner_id AS actor_id FROM open_loops
           UNION SELECT subject_id AS actor_id FROM open_loop_subjects
         ) ORDER BY actor_id LIMIT 1000`,
      )
      .all() as Record<string, unknown>[];
    const count = (table: string, predicate = ""): number => {
      const row = this.#database.prepare(`SELECT COUNT(*) AS count FROM ${table} ${predicate}`).get() as Record<
        string,
        unknown
      >;
      return rowNumber(row, "count");
    };
    const actorIds = actorRows.map((row) => rowString(row, "actor_id"));
    const actorCountRow = this.#database
      .prepare(
        `SELECT COUNT(*) AS count FROM (
           SELECT actor_id FROM event_actors
           UNION SELECT subject_id AS actor_id FROM event_subjects
           UNION SELECT witness_id AS actor_id FROM event_witnesses
           UNION SELECT owner_id AS actor_id FROM memory_views
           UNION SELECT owner_id AS actor_id FROM relationship_edges
           UNION SELECT subject_id AS actor_id FROM relationship_edges
           UNION SELECT owner_id AS actor_id FROM open_loops
           UNION SELECT subject_id AS actor_id FROM open_loop_subjects
         )`,
      )
      .get() as Record<string, unknown>;
    return {
      stats: {
        actors: rowNumber(actorCountRow, "count"),
        events: count("social_events"),
        memories: count("memory_views"),
        relationships: count("relationship_edges"),
        openLoops: count("open_loops", "WHERE state = 'open'"),
        auditEntries: count("audit_entries"),
        activeEpisodicMemories: lifecycle.activeEpisodic,
        consolidatedMemories: lifecycle.activeConsolidated,
        expiredMemories: lifecycle.expired,
        supersededMemories: lifecycle.superseded,
      },
      actorIds,
    };
  }

  /**
   * Removes every derived social-memory artifact involving one actor. Public
   * chat remains in RoomStore; this deletes only the model-derived recollection,
   * relationship and open-loop layer, including private event summaries.
   */
  forgetActor(actorId: string): SocialMemoryForgetResult {
    const actor = cleanId(actorId, "actorId");
    return this.#transaction(() => {
      const receiptRows = this.#database.prepare(
        `SELECT episode_id, participant_ids_json, event_ids_json
         FROM episode_receipts WHERE status <> 'erased'`,
      ).all() as Record<string, unknown>[];
      const receiptEventIds = new Set<string>();
      const eraseReceipt = this.#database.prepare(
        `UPDATE episode_receipts
         SET status = 'erased', events_hash = '', participant_ids_json = '[]', event_ids_json = '[]'
         WHERE episode_id = ?`,
      );
      for (const row of receiptRows) {
        const participants = JSON.parse(rowString(row, "participant_ids_json")) as unknown;
        if (Array.isArray(participants) && participants.includes(actor)) {
          const linkedEventIds = JSON.parse(rowString(row, "event_ids_json")) as unknown;
          if (Array.isArray(linkedEventIds)) {
            for (const eventId of linkedEventIds) {
              if (typeof eventId === "string") receiptEventIds.add(eventId);
            }
          }
          eraseReceipt.run(rowString(row, "episode_id"));
        }
      }
      const eventRows = this.#database.prepare(
        `SELECT event_id FROM event_actors WHERE actor_id = ?
         UNION SELECT event_id FROM event_subjects WHERE subject_id = ?
         UNION SELECT event_id FROM event_witnesses WHERE witness_id = ?
         UNION SELECT event_id FROM memory_views WHERE owner_id = ?
         UNION SELECT event_id FROM memory_views m
           WHERE EXISTS (SELECT 1 FROM memory_subjects s WHERE s.memory_id = m.id AND s.subject_id = ?)
         UNION SELECT event_id FROM open_loops WHERE owner_id = ?
         UNION SELECT event_id FROM open_loops l
           WHERE EXISTS (SELECT 1 FROM open_loop_subjects s WHERE s.loop_id = l.id AND s.subject_id = ?)`,
      ).all(actor, actor, actor, actor, actor, actor, actor) as Record<string, unknown>[];
      const eventIds = new Set([
        ...receiptEventIds,
        ...eventRows.map((row) => rowString(row, "event_id")),
      ]);
      // Private scope participation is itself retained personal context. A
      // participant may have stayed silent and therefore be absent from every
      // actor/subject/witness projection above; forgetting them must still
      // remove the complete private episode.
      const privateScopeRows = this.#database.prepare(
        `SELECT id, scope_participants_json FROM social_events
         WHERE scope_kind IN ('dm', 'voice')`,
      ).all() as Record<string, unknown>[];
      for (const row of privateScopeRows) {
        const participants = JSON.parse(rowString(row, "scope_participants_json")) as unknown;
        if (Array.isArray(participants) && participants.includes(actor)) {
          eventIds.add(rowString(row, "id"));
        }
      }
      // Consolidated memories retain source ids after old source events are
      // compacted. If any still-present provenance event involves the actor,
      // erase the consolidation and its synthetic anchor as well.
      const derivedMemoryRows = this.#database.prepare(
        `SELECT DISTINCT m.id, m.event_id
         FROM memory_views m
         WHERE m.owner_id = ? OR EXISTS (
           SELECT 1 FROM memory_subjects s WHERE s.memory_id = m.id AND s.subject_id = ?
         )`,
      ).all(actor, actor) as Record<string, unknown>[];
      const derivedMemoryIds = new Set(derivedMemoryRows.map((row) => rowString(row, "id")));
      const retainedProvenanceRows = this.#database.prepare(
        "SELECT memory_id, participant_ids_json FROM memory_provenance",
      ).all() as Record<string, unknown>[];
      for (const row of retainedProvenanceRows) {
        const participants = JSON.parse(rowString(row, "participant_ids_json")) as unknown;
        if (Array.isArray(participants) && participants.includes(actor)) {
          derivedMemoryIds.add(rowString(row, "memory_id"));
        }
      }
      if (eventIds.size > 0) {
        const provenanceRows = this.#database.prepare(
          "SELECT memory_id FROM memory_provenance WHERE source_event_id = ?",
        );
        for (const eventId of eventIds) {
          for (const row of provenanceRows.all(eventId) as Record<string, unknown>[]) {
            derivedMemoryIds.add(rowString(row, "memory_id"));
          }
        }
      }
      const memoryAnchor = this.#database.prepare("SELECT event_id FROM memory_views WHERE id = ?");
      for (const memoryId of derivedMemoryIds) {
        const row = memoryAnchor.get(memoryId) as Record<string, unknown> | undefined;
        if (row) eventIds.add(rowString(row, "event_id"));
      }
      const affectedLoopIds = new Set<string>();
      const updatedLoopsForEvent = this.#database.prepare(
        "SELECT loop_id FROM open_loop_updates WHERE event_id = ?",
      );
      for (const eventId of eventIds) {
        const rows = updatedLoopsForEvent.all(eventId) as Record<string, unknown>[];
        for (const row of rows) affectedLoopIds.add(rowString(row, "loop_id"));
      }
      const countWhereActor = (table: string, ownerColumn: string, subjectTable: string, foreignKey: string): number => {
        const row = this.#database.prepare(
          `SELECT COUNT(DISTINCT item.id) AS count FROM ${table} item
           WHERE item.${ownerColumn} = ? OR EXISTS (
             SELECT 1 FROM ${subjectTable} subject
             WHERE subject.${foreignKey} = item.id AND subject.subject_id = ?
           )`,
        ).get(actor, actor) as Record<string, unknown>;
        return rowNumber(row, "count");
      };
      const memories = derivedMemoryIds.size;
      const openLoops = countWhereActor("open_loops", "owner_id", "open_loop_subjects", "loop_id");
      const relationshipRow = this.#database.prepare(
        "SELECT COUNT(*) AS count FROM relationship_edges WHERE owner_id = ? OR subject_id = ?",
      ).get(actor, actor) as Record<string, unknown>;
      const relationships = rowNumber(relationshipRow, "count");

      const deleteEvent = this.#database.prepare("DELETE FROM social_events WHERE id = ?");
      for (const eventId of eventIds) deleteEvent.run(eventId);
      this.#database.prepare(
        `DELETE FROM memory_views WHERE owner_id = ? OR EXISTS (
           SELECT 1 FROM memory_subjects s WHERE s.memory_id = memory_views.id AND s.subject_id = ?
         )`,
      ).run(actor, actor);
      this.#database.prepare(
        `DELETE FROM open_loops WHERE owner_id = ? OR EXISTS (
           SELECT 1 FROM open_loop_subjects s WHERE s.loop_id = open_loops.id AND s.subject_id = ?
         )`,
      ).run(actor, actor);
      this.#database.prepare(
        "DELETE FROM relationship_edges WHERE owner_id = ? OR subject_id = ?",
      ).run(actor, actor);
      this.#database.prepare(
        "DELETE FROM relationship_changes WHERE owner_id = ? OR subject_id = ?",
      ).run(actor, actor);
      const checkpointRows = this.#database.prepare(
        "SELECT id, participant_ids_json FROM relationship_checkpoints",
      ).all() as Record<string, unknown>[];
      const deleteCheckpoint = this.#database.prepare(
        "DELETE FROM relationship_checkpoints WHERE id = ?",
      );
      for (const row of checkpointRows) {
        const participants = JSON.parse(rowString(row, "participant_ids_json")) as unknown;
        if (Array.isArray(participants) && participants.includes(actor)) {
          deleteCheckpoint.run(rowString(row, "id"));
        }
      }
      this.#database.prepare(
        "DELETE FROM relationship_checkpoints WHERE owner_id = ? OR subject_id = ?",
      ).run(actor, actor);
      // Daily spend is intentionally not keyed by witnesses: forgetting a
      // third party cannot reopen another pair's already-consumed allowance.
      // If the forgotten actor is an endpoint, the pair itself no longer
      // exists and its anonymous spend watermark can be removed as well.
      this.#database.prepare(
        "DELETE FROM relationship_daily_budgets WHERE owner_id = ? OR subject_id = ?",
      ).run(actor, actor);
      // Event deletion cascades provenance rows, not the materialized edges.
      // Rebuilding from the surviving changes also repairs unrelated pairs
      // when the forgotten actor merely witnessed their source event.
      this.#recomputeAllRelationshipEdges();
      // A deleted event may have continued a loop created by another event.
      // Replay only surviving, explicit provenance so inherited wording from
      // the deleted update cannot remain in the materialized loop.
      for (const loopId of affectedLoopIds) this.#recomputeOpenLoop(loopId);
      return { events: eventIds.size, memories, relationships, openLoops };
    });
  }

  recordEvent(input: RecordSocialEventInput): RecordSocialEventResult {
    const normalized = normalizeRecordInput(input);
    return this.#transaction(() => this.#recordNormalizedEvent(normalized));
  }

  getEpisodeReceipt(episodeId: string): SocialEpisodeReceipt | undefined {
    const id = cleanId(episodeId, "episodeId");
    const row = this.#database
      .prepare("SELECT * FROM episode_receipts WHERE episode_id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.#episodeReceiptFromRow(row) : undefined;
  }

  /**
   * Atomically commits one analyzer decision. A receipt is durable even when
   * the decision contains no events, so restarts cannot re-analyse and drift.
   */
  recordEpisode(input: RecordSocialEpisodeInput): RecordSocialEpisodeResult {
    if (!input || typeof input !== "object") throw new TypeError("episode input must be an object");
    const episodeId = cleanId(input.episodeId, "episodeId");
    const fingerprint = cleanFingerprint(input.fingerprint);
    const durableReceipt = this.getEpisodeReceipt(episodeId);
    if (durableReceipt?.status === "erased") {
      if (durableReceipt.fingerprint !== fingerprint) {
        throw new Error(`social episode ${episodeId} already exists with different content`);
      }
      return { created: false, receipt: durableReceipt, eventResults: [] };
    }
    const participantIds = cleanUniqueIds(
      input.participantIds,
      LIMITS.participants,
      "participantIds",
      1,
    );
    if (!Array.isArray(input.events) || input.events.length > LIMITS.episodeEvents) {
      throw new Error(`events must contain 0..${LIMITS.episodeEvents} items`);
    }
    // Normalize the entire batch before opening a write transaction.
    const normalized = input.events.map(normalizeRecordInput);
    if (new Set(normalized.map((event) => event.id)).size !== normalized.length) {
      throw new Error("episode events must not contain duplicate ids");
    }
    const participantSet = new Set(participantIds);
    for (const event of normalized) {
      const referenced = new Set([
        ...event.actorIds,
        ...event.subjectIds,
        ...event.witnessIds,
        ...scopeParts(event.scope).participants,
        ...event.memoryViews.flatMap((view) => [view.ownerId, ...view.subjectIds]),
        ...event.relationshipDeltas.flatMap((delta) => [delta.ownerId, delta.subjectId]),
        ...event.openLoops.flatMap((loop) => [loop.ownerId, ...loop.subjectIds]),
      ]);
      if ([...referenced].some((actorId) => !participantSet.has(actorId))) {
        throw new Error("episode participantIds must include every actor referenced by its events");
      }
    }
    const canonicalEvents = [...normalized].sort((left, right) => left.id.localeCompare(right.id));
    const eventIds = canonicalEvents.map((event) => event.id);
    const eventsHash = stableHash(canonicalEvents);

    return this.#transaction(() => {
      const existingRow = this.#database
        .prepare("SELECT * FROM episode_receipts WHERE episode_id = ?")
        .get(episodeId) as Record<string, unknown> | undefined;
      if (existingRow) {
        const existing = this.#episodeReceiptFromRow(existingRow);
        if (existing.fingerprint !== fingerprint) {
          throw new Error(`social episode ${episodeId} already exists with different content`);
        }
        if (existing.status === "erased") {
          return { created: false, receipt: existing, eventResults: [] };
        }
        if (
          rowString(existingRow, "events_hash") !== eventsHash ||
          JSON.stringify(existing.eventIds) !== JSON.stringify(eventIds) ||
          JSON.stringify(existing.participantIds) !== JSON.stringify(participantIds)
        ) throw new Error(`social episode ${episodeId} already exists with different content`);
        return { created: false, receipt: existing, eventResults: [] };
      }

      const eventResults = canonicalEvents.map((event) => this.#recordNormalizedEvent(event));
      const createdAt = this.#nowTimestamp();
      this.#database.prepare(
        `INSERT INTO episode_receipts
         (episode_id, fingerprint, events_hash, status, participant_ids_json, event_ids_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        episodeId,
        fingerprint,
        eventsHash,
        eventIds.length === 0 ? "no_events" : "recorded",
        JSON.stringify(participantIds),
        JSON.stringify(eventIds),
        createdAt,
      );
      return {
        created: true,
        receipt: {
          episodeId,
          fingerprint,
          status: eventIds.length === 0 ? "no_events" : "recorded",
          participantIds,
          eventIds,
          createdAt,
        },
        eventResults,
      };
    });
  }

  #recordNormalizedEvent(normalized: NormalizedRecordInput): RecordSocialEventResult {
      const payloadHash = stableHash(normalized);
      const existing = this.#database
        .prepare("SELECT payload_hash FROM social_events WHERE id = ?")
        .get(normalized.id) as Record<string, unknown> | undefined;
      if (existing) {
        if (rowString(existing, "payload_hash") !== payloadHash) {
          throw new Error(`social event ${normalized.id} already exists with different content`);
        }
        return {
          created: false,
          event: this.#requireEvent(normalized.id),
          appliedRelationshipDeltas: this.#listAppliedDeltas(normalized.id),
          updatedOpenLoops: this.#listEventUpdatedLoops(normalized.id),
        };
      }

      const createdAt = this.#nowTimestamp();
      const scoped = scopeParts(normalized.scope);
      this.#database
        .prepare(
          `INSERT INTO social_events
           (id, kind, origin, scope_kind, scope_id, scope_participants_json, occurred_at,
            summary, salience, confidence, payload_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          normalized.id,
          normalized.kind,
          normalized.origin,
          scoped.kind,
          scoped.id,
          JSON.stringify(scoped.participants),
          normalized.occurredAt,
          normalized.summary,
          normalized.salience,
          normalized.confidence,
          payloadHash,
          createdAt,
        );
      this.#insertIds("event_sources", "message_id", normalized.id, normalized.sourceMessageIds);
      this.#insertIds("event_actors", "actor_id", normalized.id, normalized.actorIds);
      this.#insertIds("event_subjects", "subject_id", normalized.id, normalized.subjectIds);
      this.#insertIds("event_witnesses", "witness_id", normalized.id, normalized.witnessIds);

      for (const view of normalized.memoryViews) {
        this.#database
          .prepare(
            `INSERT INTO memory_views
             (id, event_id, owner_id, perspective, salience, confidence, pinned, tier,
              recall_count, last_recalled_at, reinforced_at, expires_at, superseded_by,
              lifecycle_hash, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, 'episodic', 0, NULL, ?, ?, NULL, NULL, ?, ?)`,
          )
          .run(
            view.id,
            normalized.id,
            view.ownerId,
            view.perspective,
            view.salience,
            view.confidence,
            normalized.occurredAt,
            memoryExpiryFor(normalized.occurredAt, view.salience, "episodic"),
            createdAt,
            createdAt,
          );
        const statement = this.#database.prepare(
          "INSERT INTO memory_subjects (memory_id, subject_id) VALUES (?, ?)",
        );
        for (const subjectId of view.subjectIds) statement.run(view.id, subjectId);
      }

      const appliedRelationshipDeltas = normalized.relationshipDeltas.map((delta) =>
        this.#applyRelationshipDelta(normalized, delta, createdAt),
      );

      for (const loop of normalized.openLoops) {
        this.#database
          .prepare(
            `INSERT INTO open_loops
             (id, event_id, owner_id, kind, initial_summary, summary, state, due_at, pinned, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'open', ?, 0, ?, ?)`,
          )
          .run(
            loop.id,
            normalized.id,
            loop.ownerId,
            loop.kind,
            loop.summary,
            loop.summary,
            loop.dueAt ?? null,
            createdAt,
            createdAt,
          );
        const statement = this.#database.prepare(
          "INSERT INTO open_loop_subjects (loop_id, subject_id) VALUES (?, ?)",
        );
        for (const subjectId of loop.subjectIds) statement.run(loop.id, subjectId);
      }

      const updatedOpenLoops = normalized.openLoopUpdates.map((update) =>
        this.#applyOpenLoopUpdate(normalized, update, createdAt),
      );

      return {
        created: true,
        event: this.#requireEvent(normalized.id),
        appliedRelationshipDeltas,
        updatedOpenLoops,
      };
  }

  getEvent(eventId: string): SocialEvent | undefined {
    const id = cleanId(eventId, "eventId");
    const row = this.#database.prepare("SELECT * FROM social_events WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.#eventFromRow(row) : undefined;
  }

  listMemories(query: MemoryQuery): SocialMemoryView[] {
    const ownerId = cleanId(query.ownerId, "ownerId");
    const subjectId = query.subjectId === undefined ? undefined : cleanId(query.subjectId, "subjectId");
    if (query.includeInactive !== undefined && typeof query.includeInactive !== "boolean") {
      throw new TypeError("includeInactive must be boolean");
    }
    // The admin inspector asks for one sentinel row so it can distinguish
    // exactly 50 rows from a genuinely truncated result. Prompt retrieval keeps
    // the original hard bound and never opts into inactive rows.
    const limit = cleanLimit(
      query.limit,
      query.includeInactive ? LIMITS.retrieval + 1 : LIMITS.retrieval,
    );
    if (query.scope !== undefined && query.visibleInScope !== undefined) {
      throw new Error("scope and visibleInScope are mutually exclusive");
    }
    const scope = query.scope === undefined ? undefined : scopeParts(query.scope);
    const clauses = ["m.owner_id = ?"];
    const parameters: SQLInputValue[] = [ownerId];
    if (subjectId) {
      clauses.push("EXISTS (SELECT 1 FROM memory_subjects ms WHERE ms.memory_id = m.id AND ms.subject_id = ?)");
      parameters.push(subjectId);
    }
    if (scope) {
      clauses.push("e.scope_kind = ?", "e.scope_id = ?");
      parameters.push(scope.kind, scope.id);
      if (scope.kind !== "public") {
        clauses.push("e.scope_participants_json = ?");
        parameters.push(JSON.stringify(scope.participants));
      }
    }
    if (query.visibleInScope !== undefined) {
      appendPromptVisibilityClause(clauses, parameters, "e", query.visibleInScope);
    }
    const now = this.#nowTimestamp();
    if (!query.includeInactive) {
      clauses.push("m.superseded_by IS NULL");
      clauses.push(
        `(m.pinned = 1 OR m.expires_at IS NULL OR m.expires_at > ? OR EXISTS (
         SELECT 1 FROM open_loops protected_loop
         WHERE protected_loop.state = 'open' AND (
           protected_loop.event_id = m.event_id OR EXISTS (
             SELECT 1 FROM memory_provenance protected_source
             WHERE protected_source.memory_id = m.id
               AND protected_source.source_event_id = protected_loop.event_id
           )
         )
         ))`,
      );
      parameters.push(now);
    }
    const rows = this.#database
      .prepare(
        `SELECT m.*, e.kind AS event_kind, e.origin AS event_origin,
                e.scope_kind, e.scope_id, e.scope_participants_json,
                e.summary AS event_summary, e.occurred_at
         FROM memory_views m
         JOIN social_events e ON e.id = m.event_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY m.id ASC`,
      )
      .all(...parameters) as Record<string, unknown>[];
    const protectedIds = query.includeInactive ? this.#unresolvedLoopBackedMemoryIds() : new Set<string>();
    rows.sort((left, right) => {
      if (query.includeInactive) {
        const leftActive = this.#isMemoryActiveRow(left, now, protectedIds);
        const rightActive = this.#isMemoryActiveRow(right, now, protectedIds);
        if (leftActive !== rightActive) return leftActive ? -1 : 1;
        if (!leftActive) {
          const supersededDifference = Number(right.superseded_by !== null) - Number(left.superseded_by !== null);
          if (supersededDifference !== 0) return supersededDifference;
          return rowNumber(right, "updated_at") - rowNumber(left, "updated_at") ||
            rowString(left, "id").localeCompare(rowString(right, "id"));
        }
      }
      return this.#compareMemoryRecallRank(left, right, now);
    });
    return rows.slice(0, limit).map((row) => this.#memoryFromRow(row));
  }

  /** Records prompt inclusion without inflating counts during retries. */
  markMemoriesRecalled(memoryIds: string[], at = this.#nowTimestamp()): number {
    const ids = cleanUniqueIds(memoryIds, LIMITS.recalledMemories, "memoryIds");
    const recalledAt = cleanTimestamp(at, "at");
    if (ids.length === 0) return 0;
    return this.#transaction(() => {
      let changed = 0;
      const protectedIds = this.#unresolvedLoopBackedMemoryIds();
      const select = this.#database.prepare(
        `SELECT id, pinned, expires_at, superseded_by, last_recalled_at
         FROM memory_views WHERE id = ?`,
      );
      const update = this.#database.prepare(
        `UPDATE memory_views
         SET recall_count = recall_count + 1, last_recalled_at = ?
         WHERE id = ?`,
      );
      for (const id of ids) {
        const row = select.get(id) as Record<string, unknown> | undefined;
        if (!row || !this.#isMemoryActiveRow(row, recalledAt, protectedIds)) continue;
        if (
          row.last_recalled_at !== null &&
          recalledAt - rowNumber(row, "last_recalled_at") < SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.recallWriteDebounceMs
        ) continue;
        update.run(recalledAt, id);
        changed += 1;
      }
      return changed;
    });
  }

  getConsolidationCursor(): string | undefined {
    const row = this.#database.prepare(
      "SELECT value FROM social_memory_lifecycle_state WHERE key = 'consolidation_cursor'",
    ).get() as Record<string, unknown> | undefined;
    return row ? rowString(row, "value") : undefined;
  }

  setConsolidationCursor(bucketId: string, at = this.#nowTimestamp()): void {
    const cursor = cleanId(bucketId, "bucketId");
    const updatedAt = cleanTimestamp(at, "at");
    this.#transaction(() => {
      this.#database.prepare(
        `INSERT INTO social_memory_lifecycle_state (key, value, updated_at)
         VALUES ('consolidation_cursor', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(cursor, updatedAt);
    });
  }

  advanceConsolidationWindow(batch: ConsolidationBatch, at = this.#nowTimestamp()): void {
    const bucketId = cleanId(batch.bucketId, "batch.bucketId");
    if (!Number.isInteger(batch.memoryCount) || batch.memoryCount < 2) {
      throw new Error("batch.memoryCount must be an integer of at least two");
    }
    if (!Number.isInteger(batch.windowOffset) || batch.windowOffset < 0 || batch.windowOffset >= batch.memoryCount) {
      throw new Error("batch.windowOffset is outside the memory bucket");
    }
    const updatedAt = cleanTimestamp(at, "at");
    const step = Math.max(1, Math.floor(batch.memories.length / 2));
    const nextOffset = batch.memoryCount <= batch.memories.length
      ? 0
      : (batch.windowOffset + step) % batch.memoryCount;
    const key = `consolidation_window:${bucketId}`;
    this.#transaction(() => {
      this.#database.prepare(
        `INSERT INTO social_memory_lifecycle_state (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(key, String(nextOffset), updatedAt);
      this.#database.prepare(
        `DELETE FROM social_memory_lifecycle_state
         WHERE key LIKE 'consolidation_window:%' AND updated_at <= ?`,
      ).run(updatedAt - SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.relationshipCheckpointRetentionMs);
      const count = rowNumber(this.#database.prepare(
        "SELECT COUNT(*) AS count FROM social_memory_lifecycle_state WHERE key LIKE 'consolidation_window:%'",
      ).get() as Record<string, unknown>, "count");
      const excess = Math.max(0, count - LIMITS.consolidationBuckets);
      if (excess > 0) {
        this.#database.prepare(
          `DELETE FROM social_memory_lifecycle_state WHERE key IN (
             SELECT key FROM social_memory_lifecycle_state
             WHERE key LIKE 'consolidation_window:%'
             ORDER BY updated_at ASC, key ASC LIMIT ?
           )`,
        ).run(excess);
      }
    });
  }

  /**
   * Returns every eligible exact identity/scope bucket in one bounded pass.
   * Choosing semantically overlapping source ids remains the model's job.
   */
  listConsolidationBatches(query: ConsolidationBatchQuery = {}): ConsolidationBatch[] {
    const limit = cleanConsolidationCount(
      query.limit,
      SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.defaultConsolidationBatch,
      "limit",
    );
    const minimum = cleanConsolidationCount(
      query.minimum,
      SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.minimumConsolidationBatch,
      "minimum",
    );
    if (minimum > limit) throw new Error("minimum must not exceed limit");
    const now = this.#nowTimestamp();
    const protectedIds = this.#unresolvedLoopBackedMemoryIds();
    const rows = this.#allMemoryRows().filter((row) =>
      rowNumber(row, "pinned") === 0 &&
      this.#isMemoryActiveRow(row, now, protectedIds),
    );
    const groups = new Map<string, { memories: SocialMemoryView[]; oldest: number }>();
    for (const row of rows) {
      const memory = this.#memoryFromRow(row);
      const key = stableHash({
        ownerId: memory.ownerId,
        subjectIds: memory.subjectIds,
        scope: scopeParts(memory.event.scope).scope,
        origin: memory.event.origin,
      });
      const group = groups.get(key) ?? { memories: [], oldest: memory.reinforcedAt };
      group.memories.push(memory);
      group.oldest = Math.min(group.oldest, memory.reinforcedAt);
      groups.set(key, group);
    }
    const eligible = [...groups.entries()]
      .filter(([, group]) => group.memories.length >= minimum)
      .sort((left, right) =>
        right[1].memories.length - left[1].memories.length ||
        left[1].oldest - right[1].oldest ||
        left[0].localeCompare(right[0]),
      );
    return eligible.slice(0, LIMITS.consolidationBuckets).map(([key, selected]) => {
      selected.memories.sort((left, right) =>
        left.reinforcedAt - right.reinforcedAt || left.id.localeCompare(right.id),
      );
      const bucketId = `memory_bucket_${key.slice(0, 32)}`;
      const cursorRow = this.#database.prepare(
        "SELECT value FROM social_memory_lifecycle_state WHERE key = ?",
      ).get(`consolidation_window:${bucketId}`) as Record<string, unknown> | undefined;
      const storedOffset = cursorRow ? Number(rowString(cursorRow, "value")) : 0;
      const windowOffset = Number.isInteger(storedOffset) && storedOffset >= 0
        ? storedOffset % selected.memories.length
        : 0;
      const memories = Array.from(
        { length: Math.min(limit, selected.memories.length) },
        (_, index) => selected.memories[(windowOffset + index) % selected.memories.length]!,
      );
      const first = memories[0]!;
      return {
        bucketId,
        ownerId: first.ownerId,
        subjectIds: first.subjectIds,
        scope: first.event.scope,
        memoryCount: selected.memories.length,
        windowOffset,
        memories,
      };
    });
  }

  nextConsolidationBatch(query: ConsolidationCandidateQuery = {}): ConsolidationBatch | undefined {
    if (
      query.offset !== undefined &&
      (typeof query.offset !== "number" || !Number.isInteger(query.offset) ||
        query.offset < 0 || query.offset >= LIMITS.consolidationBuckets)
    ) throw new Error(`offset must be an integer between 0 and ${LIMITS.consolidationBuckets - 1}`);
    return this.listConsolidationBatches(query)[query.offset ?? 0];
  }

  applyMemoryConsolidation(input: ApplyMemoryConsolidationInput): ApplyMemoryConsolidationResult {
    if (!input || typeof input !== "object") throw new TypeError("consolidation input must be an object");
    const id = cleanId(input.id, "id");
    const ownerId = cleanId(input.ownerId, "ownerId");
    const subjectIds = cleanUniqueIds(input.subjectIds, LIMITS.participants, "subjectIds", 1);
    const scoped = scopeParts(input.scope);
    const sourceMemoryIds = cleanUniqueIds(
      input.sourceMemoryIds,
      LIMITS.consolidationSources,
      "sourceMemoryIds",
      2,
    );
    if (sourceMemoryIds.includes(id)) throw new Error("a consolidation cannot cite itself");
    const perspective = cleanText(input.perspective, LIMITS.perspective, "perspective");
    const salience = cleanUnit(input.salience, "salience");
    const confidence = cleanUnit(input.confidence, "confidence");
    const at = input.at === undefined ? this.#nowTimestamp() : cleanTimestamp(input.at, "at");
    const expiresAt = input.expiresAt === undefined
      ? memoryExpiryFor(at, salience, "consolidated")
      : cleanTimestamp(input.expiresAt, "expiresAt");
    if (expiresAt <= at) throw new Error("expiresAt must be later than at");
    const lifecycleHash = stableHash({
      ownerId,
      subjectIds,
      scope: scoped.scope,
      sourceMemoryIds,
      perspective,
      salience,
      confidence,
      explicitExpiresAt: input.expiresAt,
    });

    return this.#transaction(() => {
      const existing = this.#getMemoryRow(id);
      if (existing) {
        if (existing.lifecycle_hash !== null && rowString(existing, "lifecycle_hash") === lifecycleHash) {
          return { created: false, memory: this.#memoryFromRow(existing) };
        }
        throw new Error(`memory ${id} already exists with different content`);
      }
      const protectedIds = this.#unresolvedLoopBackedMemoryIds();
      const sourceRows = sourceMemoryIds.map((sourceId) => {
        const row = this.#getMemoryRow(sourceId);
        if (!row) throw new Error(`source memory ${sourceId} does not exist`);
        if (!this.#isMemoryActiveRow(row, at, protectedIds)) {
          throw new Error(`source memory ${sourceId} is not active`);
        }
        if (rowNumber(row, "pinned") === 1 || protectedIds.has(sourceId)) {
          throw new Error(`source memory ${sourceId} is protected and cannot be superseded`);
        }
        const memory = this.#memoryFromRow(row);
        if (memory.ownerId !== ownerId) throw new Error("all source memories must have the exact owner");
        if (JSON.stringify(memory.subjectIds) !== JSON.stringify(subjectIds)) {
          throw new Error("all source memories must have the exact subject set");
        }
        const sourceScope = scopeParts(memory.event.scope);
        if (
          sourceScope.kind !== scoped.kind ||
          sourceScope.id !== scoped.id ||
          JSON.stringify(sourceScope.participants) !== JSON.stringify(scoped.participants)
        ) throw new Error("all source memories must have the exact scope and participants");
        return { row, memory };
      });
      const origin = sourceRows[0]!.memory.event.origin;
      if (sourceRows.some(({ memory }) => memory.event.origin !== origin)) {
        throw new Error("all source memories must have the exact event origin");
      }
      if (!sourceRows.some(({ memory }) => memory.perspective === perspective)) {
        throw new Error("consolidated perspective must exactly equal one cited source view");
      }
      const expectedSalience = Math.max(...sourceRows.map(({ memory }) => memory.salience));
      const expectedConfidence = Math.min(...sourceRows.map(({ memory }) => memory.confidence));
      if (salience !== expectedSalience) {
        throw new Error("consolidated salience must equal the maximum cited source salience");
      }
      if (confidence !== expectedConfidence) {
        throw new Error("consolidated confidence must equal the minimum cited source confidence");
      }
      if (at < Math.max(...sourceRows.map(({ memory }) => memory.reinforcedAt))) {
        throw new Error("consolidation time must not precede its newest source reinforcement");
      }

      const provenance = new Map<string, { messageIds: string[]; participantIds: string[] }>();
      for (const { memory } of sourceRows) {
        const rows = this.#database.prepare(
          `SELECT source_event_id, source_message_ids_json, participant_ids_json
           FROM memory_provenance WHERE memory_id = ? ORDER BY source_event_id`,
        ).all(memory.id) as Record<string, unknown>[];
        if (rows.length === 0) {
          const event = this.getEvent(memory.eventId);
          if (!event) throw new Error(`source event ${memory.eventId} does not exist`);
          provenance.set(memory.eventId, {
            messageIds: memory.event.sourceMessageIds,
            participantIds: [...new Set([
              ...event.actorIds,
              ...event.subjectIds,
              ...event.witnessIds,
              ...scopeParts(event.scope).participants,
            ])].sort(),
          });
          continue;
        }
        for (const row of rows) {
          const messages = JSON.parse(rowString(row, "source_message_ids_json")) as unknown;
          const participants = JSON.parse(rowString(row, "participant_ids_json")) as unknown;
          if (!Array.isArray(messages) || messages.some((message) => typeof message !== "string")) {
            throw new Error("memory provenance contains invalid source message ids");
          }
          if (!Array.isArray(participants) || participants.some((actor) => typeof actor !== "string")) {
            throw new Error("memory provenance contains invalid participant ids");
          }
          provenance.set(rowString(row, "source_event_id"), {
            messageIds: messages,
            participantIds: participants,
          });
        }
      }
      if (provenance.size < 2) throw new Error("consolidation requires at least two source events");
      if (provenance.size > LIMITS.consolidationSources) {
        throw new Error(`flattened consolidation provenance may contain at most ${LIMITS.consolidationSources} source events`);
      }

      const createdAt = this.#nowTimestamp();
      const syntheticEventId = `consolidation-${stableHash(id).slice(0, 40)}`;
      if (this.getEvent(syntheticEventId)) throw new Error("consolidation event id collision");
      const syntheticPayload = stableHash({ id, sourceEventIds: [...provenance.keys()].sort(), perspective });
      this.#database.prepare(
        `INSERT INTO social_events
         (id, kind, origin, scope_kind, scope_id, scope_participants_json, occurred_at,
          summary, salience, confidence, payload_hash, created_at)
         VALUES (?, 'other', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        syntheticEventId,
        origin,
        scoped.kind,
        scoped.id,
        JSON.stringify(scoped.participants),
        at,
        perspective,
        salience,
        confidence,
        syntheticPayload,
        createdAt,
      );
      const syntheticMessages = [...new Set([...provenance.values()].flatMap((source) => source.messageIds))]
        .sort()
        .slice(0, LIMITS.sourceMessages);
      this.#insertIds("event_sources", "message_id", syntheticEventId, syntheticMessages);
      this.#insertIds("event_actors", "actor_id", syntheticEventId, [ownerId]);
      this.#insertIds("event_subjects", "subject_id", syntheticEventId, subjectIds);
      this.#insertIds("event_witnesses", "witness_id", syntheticEventId, [ownerId]);

      this.#database.prepare(
        `INSERT INTO memory_views
         (id, event_id, owner_id, perspective, salience, confidence, pinned, tier,
          recall_count, last_recalled_at, reinforced_at, expires_at, superseded_by,
          lifecycle_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'consolidated', 0, NULL, ?, ?, NULL, ?, ?, ?)`,
      ).run(
        id,
        syntheticEventId,
        ownerId,
        perspective,
        salience,
        confidence,
        at,
        expiresAt,
        lifecycleHash,
        createdAt,
        at,
      );
      const insertSubject = this.#database.prepare(
        "INSERT INTO memory_subjects (memory_id, subject_id) VALUES (?, ?)",
      );
      for (const subjectId of subjectIds) insertSubject.run(id, subjectId);
      const insertInput = this.#database.prepare(
        "INSERT INTO memory_consolidation_inputs (memory_id, source_memory_id) VALUES (?, ?)",
      );
      for (const sourceId of sourceMemoryIds) insertInput.run(id, sourceId);
      const insertProvenance = this.#database.prepare(
        `INSERT INTO memory_provenance
         (memory_id, source_event_id, source_message_ids_json, participant_ids_json)
         VALUES (?, ?, ?, ?)`,
      );
      for (const [eventId, source] of [...provenance.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        insertProvenance.run(
          id,
          eventId,
          JSON.stringify([...new Set(source.messageIds)].sort()),
          JSON.stringify([...new Set(source.participantIds)].sort()),
        );
      }
      const supersede = this.#database.prepare(
        "UPDATE memory_views SET superseded_by = ?, updated_at = ? WHERE id = ?",
      );
      for (const sourceId of sourceMemoryIds) supersede.run(id, at, sourceId);
      const memory = this.#getMemoryRow(id);
      if (!memory) throw new Error(`consolidated memory ${id} disappeared during transaction`);
      return { created: true, memory: this.#memoryFromRow(memory) };
    });
  }

  runLifecycleMaintenance(options: LifecycleMaintenanceOptions = {}): LifecycleMaintenanceResult {
    const now = options.now === undefined ? this.#nowTimestamp() : cleanTimestamp(options.now, "now");
    return this.#transaction(() => {
      const dismissedOpenLoopOverflow = this.#boundOpenLoops(now);
      const protectedIds = this.#unresolvedLoopBackedMemoryIds();
      const rows = this.#allMemoryRows();
      const expireIds = new Set<string>();
      const protectedOverflow = { buckets: 0, owners: 0, global: 0 };
      const isProtected = (row: Record<string, unknown>): boolean =>
        rowNumber(row, "pinned") === 1 || protectedIds.has(rowString(row, "id"));
      const isActive = (row: Record<string, unknown>): boolean =>
        this.#isMemoryActiveRow(row, now, protectedIds) && !expireIds.has(rowString(row, "id"));
      const retentionScore = (row: Record<string, unknown>): number => {
        const age = Math.max(0, now - rowNumber(row, "reinforced_at"));
        const freshness = Math.max(0, 1 - age / SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.highSalienceExpiryMs);
        return (
          rowNumber(row, "salience") * 0.5 +
          rowNumber(row, "confidence") * 0.15 +
          freshness * 0.15 +
          (rowString(row, "tier") === "consolidated" ? 0.1 : 0)
        );
      };
      const expireWorst = (
        candidates: Record<string, unknown>[],
        maximum: number,
        autonomousFirst = false,
      ): number => {
        const active = candidates.filter(isActive);
        if (active.length <= maximum) return 0;
        const removable = active.filter((row) => !isProtected(row)).sort((left, right) =>
          (autonomousFirst
            ? Number(rowString(right, "event_origin") === "autonomous") -
              Number(rowString(left, "event_origin") === "autonomous")
            : 0) ||
          retentionScore(left) - retentionScore(right) ||
          rowNumber(left, "reinforced_at") - rowNumber(right, "reinforced_at") ||
          rowString(left, "id").localeCompare(rowString(right, "id")),
        );
        let excess = active.length - maximum;
        for (const row of removable) {
          if (excess <= 0) break;
          expireIds.add(rowString(row, "id"));
          excess -= 1;
        }
        return excess;
      };

      // Exact owner + subject-set + scope buckets keep episodic detail and
      // consolidated long-term state independently bounded.
      const buckets = new Map<string, Record<string, unknown>[]>();
      for (const row of rows.filter(isActive)) {
        const memory = this.#memoryFromRow(row);
        const key = stableHash({
          ownerId: memory.ownerId,
          subjectIds: memory.subjectIds,
          scope: scopeParts(memory.event.scope).scope,
          tier: memory.tier,
          // Autonomous 24/7 chatter must never consume the exact-bucket slot
          // of a sparse human-origin recollection.
          origin: memory.event.origin,
        });
        const bucket = buckets.get(key) ?? [];
        bucket.push(row);
        buckets.set(key, bucket);
      }
      for (const bucket of buckets.values()) {
        const tier = rowString(bucket[0]!, "tier") as SocialMemoryView["tier"];
        protectedOverflow.buckets += expireWorst(
          bucket,
          tier === "episodic"
            ? SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxActiveEpisodicPerBucket
            : SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxActiveConsolidatedPerBucket,
        );
      }

      const owners = new Map<string, Record<string, unknown>[]>();
      for (const row of rows.filter(isActive)) {
        const owner = rowString(row, "owner_id");
        const owned = owners.get(owner) ?? [];
        owned.push(row);
        owners.set(owner, owned);
      }
      for (const owned of owners.values()) {
        protectedOverflow.owners += expireWorst(
          owned,
          SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxActivePerOwner,
          true,
        );
      }
      protectedOverflow.global = expireWorst(
        rows,
        SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxActiveGlobal,
        true,
      );

      const expire = this.#database.prepare(
        `UPDATE memory_views SET expires_at = ?, updated_at = ?
         WHERE id = ? AND pinned = 0`,
      );
      for (const id of expireIds) expire.run(now, now, id);

      const refreshedRows = this.#allMemoryRows();
      const supersededRows = refreshedRows
        .filter((row) => !isProtected(row) && row.superseded_by !== null)
        .sort((left, right) =>
          rowNumber(left, "updated_at") - rowNumber(right, "updated_at") ||
          rowString(left, "id").localeCompare(rowString(right, "id")),
        );
      const deleteSupersededIds = new Set(
        supersededRows
          .filter((row) =>
            rowNumber(row, "updated_at") <= now - SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.supersededRetentionMs,
          )
          .map((row) => rowString(row, "id")),
      );
      const retainedSuperseded = supersededRows.filter((row) => !deleteSupersededIds.has(rowString(row, "id")));
      const supersededExcess = Math.max(
        0,
        retainedSuperseded.length - SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxSupersededMemories,
      );
      for (const row of retainedSuperseded.slice(0, supersededExcess)) {
        deleteSupersededIds.add(rowString(row, "id"));
      }
      const deletable = refreshedRows.filter((row) =>
        !isProtected(row) && (
          deleteSupersededIds.has(rowString(row, "id")) ||
          (row.expires_at !== null && rowNumber(row, "expires_at") <= now)
        ),
      );
      const deletedSupersededMemories = deletable.filter((row) => row.superseded_by !== null).length;
      const deleteMemory = this.#database.prepare("DELETE FROM memory_views WHERE id = ?");
      for (const row of deletable) deleteMemory.run(rowString(row, "id"));

      const checkpointedRelationshipChanges = this.#checkpointRelationshipChanges(
        now - SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.relationshipProvenanceRetentionMs,
        now,
      );
      const prunedRelationshipCheckpoints = this.#pruneRelationshipCheckpoints(now);
      const prunedRelationshipDailyBudgets = this.#pruneRelationshipDailyBudgets(now);
      if (prunedRelationshipCheckpoints > 0) this.#recomputeAllRelationshipEdges();

      const prunedClosedLoopsResult = this.#database.prepare(
        `DELETE FROM open_loops
         WHERE state <> 'open' AND pinned = 0 AND updated_at <= ?`,
      ).run(now - SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.closedLoopRetentionMs);
      let prunedClosedLoops = Number(prunedClosedLoopsResult.changes);
      const closedLoopCount = rowNumber(
        this.#database.prepare("SELECT COUNT(*) AS count FROM open_loops WHERE state <> 'open'").get() as Record<string, unknown>,
        "count",
      );
      const closedLoopExcess = Math.max(
        0,
        closedLoopCount - SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxClosedOpenLoops,
      );
      if (closedLoopExcess > 0) {
        prunedClosedLoops += Number(this.#database.prepare(
          `DELETE FROM open_loops WHERE id IN (
             SELECT l.id FROM open_loops l
             JOIN social_events e ON e.id = l.event_id
             WHERE l.state <> 'open' AND l.pinned = 0
             ORDER BY CASE WHEN e.origin = 'autonomous' THEN 0 ELSE 1 END,
                      l.updated_at ASC, l.created_at ASC, l.id ASC LIMIT ?
           )`,
        ).run(closedLoopExcess).changes);
      }

      const prunedEventsResult = this.#database.prepare(
        `DELETE FROM social_events
         WHERE created_at <= ?
           AND NOT EXISTS (SELECT 1 FROM memory_views m WHERE m.event_id = social_events.id)
           AND NOT EXISTS (SELECT 1 FROM open_loops l WHERE l.event_id = social_events.id)
           AND NOT EXISTS (SELECT 1 FROM open_loop_updates u WHERE u.event_id = social_events.id)
           AND NOT EXISTS (SELECT 1 FROM relationship_changes c WHERE c.event_id = social_events.id)`,
      ).run(now - SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.orphanEventRetentionMs);
      let prunedEvents = Number(prunedEventsResult.changes);
      const orphanCount = rowNumber(this.#database.prepare(
        `SELECT COUNT(*) AS count FROM social_events
         WHERE NOT EXISTS (SELECT 1 FROM memory_views m WHERE m.event_id = social_events.id)
           AND NOT EXISTS (SELECT 1 FROM open_loops l WHERE l.event_id = social_events.id)
           AND NOT EXISTS (SELECT 1 FROM open_loop_updates u WHERE u.event_id = social_events.id)
           AND NOT EXISTS (SELECT 1 FROM relationship_changes c WHERE c.event_id = social_events.id)`,
      ).get() as Record<string, unknown>, "count");
      const eventCount = rowNumber(this.#database.prepare(
        "SELECT COUNT(*) AS count FROM social_events",
      ).get() as Record<string, unknown>, "count");
      const eventOverflow = Math.max(0, eventCount - SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxSocialEvents);
      const orphanOverflow = Math.max(
        0,
        orphanCount - SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxOrphanEvents,
        eventOverflow,
      );
      if (orphanOverflow > 0) {
        prunedEvents += Number(this.#database.prepare(
          `DELETE FROM social_events WHERE id IN (
             SELECT candidate.id FROM social_events candidate
             WHERE NOT EXISTS (SELECT 1 FROM memory_views m WHERE m.event_id = candidate.id)
               AND NOT EXISTS (SELECT 1 FROM open_loops l WHERE l.event_id = candidate.id)
               AND NOT EXISTS (SELECT 1 FROM open_loop_updates u WHERE u.event_id = candidate.id)
               AND NOT EXISTS (SELECT 1 FROM relationship_changes c WHERE c.event_id = candidate.id)
             ORDER BY candidate.occurred_at ASC, candidate.created_at ASC, candidate.id ASC LIMIT ?
           )`,
        ).run(orphanOverflow).changes);
      }

      let prunedAuditEntries = Number(this.#database.prepare(
        `DELETE FROM audit_entries
         WHERE created_at <= ? AND NOT (
           action = 'loop.state' AND
           EXISTS (SELECT 1 FROM open_loops l WHERE l.id = audit_entries.target_id) AND
           id = (SELECT MAX(newer.id) FROM audit_entries newer
                 WHERE newer.action = 'loop.state'
                   AND newer.target_type = audit_entries.target_type
                   AND newer.target_id = audit_entries.target_id)
         )`,
      ).run(now - SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.auditRetentionMs).changes);
      const auditCount = rowNumber(
        this.#database.prepare("SELECT COUNT(*) AS count FROM audit_entries").get() as Record<string, unknown>,
        "count",
      );
      const auditExcess = Math.max(0, auditCount - SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxAuditEntries);
      if (auditExcess > 0) {
        prunedAuditEntries += Number(this.#database.prepare(
          `DELETE FROM audit_entries WHERE id IN (
             SELECT candidate.id FROM audit_entries candidate
             WHERE NOT (
               candidate.action = 'loop.state' AND
               EXISTS (SELECT 1 FROM open_loops l WHERE l.id = candidate.target_id) AND
               candidate.id = (SELECT MAX(newer.id) FROM audit_entries newer
                               WHERE newer.action = 'loop.state'
                                 AND newer.target_type = candidate.target_type
                                 AND newer.target_id = candidate.target_id)
             )
             ORDER BY candidate.created_at ASC, candidate.id ASC LIMIT ?
           )`,
        ).run(auditExcess).changes);
      }

      let prunedEpisodeReceipts = Number(this.#database.prepare(
        "DELETE FROM episode_receipts WHERE created_at <= ?",
      ).run(now - SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.receiptRetentionMs).changes);
      const receiptCount = rowNumber(
        this.#database.prepare("SELECT COUNT(*) AS count FROM episode_receipts").get() as Record<string, unknown>,
        "count",
      );
      const receiptExcess = Math.max(0, receiptCount - SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxEpisodeReceipts);
      if (receiptExcess > 0) {
        prunedEpisodeReceipts += Number(this.#database.prepare(
          `DELETE FROM episode_receipts WHERE episode_id IN (
             SELECT episode_id FROM episode_receipts
             ORDER BY created_at ASC, episode_id ASC LIMIT ?
           )`,
        ).run(receiptExcess).changes);
      }

      return {
        now,
        expiredMemories: expireIds.size,
        deletedMemories: deletable.length,
        deletedSupersededMemories,
        checkpointedRelationshipChanges,
        prunedRelationshipCheckpoints,
        prunedRelationshipDailyBudgets,
        dismissedOpenLoopOverflow,
        prunedClosedLoops,
        prunedEvents,
        prunedAuditEntries,
        prunedEpisodeReceipts,
        protectedOverflow,
        stats: this.lifecycleStats(now),
      };
    });
  }

  getRelationship(ownerId: string, subjectId: string): RelationshipEdge | undefined {
    const owner = cleanId(ownerId, "ownerId");
    const subject = cleanId(subjectId, "subjectId");
    const row = this.#database
      .prepare("SELECT * FROM relationship_edges WHERE owner_id = ? AND subject_id = ?")
      .get(owner, subject) as Record<string, unknown> | undefined;
    return row ? this.#relationshipFromRow(row) : undefined;
  }

  listRelationships(query: RelationshipQuery = {}): RelationshipEdge[] {
    const clauses: string[] = [];
    const parameters: SQLInputValue[] = [];
    if (query.ownerId !== undefined) {
      clauses.push("owner_id = ?");
      parameters.push(cleanId(query.ownerId, "ownerId"));
    }
    if (query.subjectId !== undefined) {
      clauses.push("subject_id = ?");
      parameters.push(cleanId(query.subjectId, "subjectId"));
    }
    parameters.push(cleanLimit(query.limit));
    const rows = this.#database
      .prepare(
        `SELECT * FROM relationship_edges
         ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY updated_at DESC, owner_id ASC, subject_id ASC LIMIT ?`,
      )
      .all(...parameters) as Record<string, unknown>[];
    return rows.map((row) => this.#relationshipFromRow(row));
  }

  listOpenLoops(query: OpenLoopQuery): OpenLoop[] {
    const ownerId = cleanId(query.ownerId, "ownerId");
    if (query.scope !== undefined && query.visibleInScope !== undefined) {
      throw new Error("scope and visibleInScope are mutually exclusive");
    }
    const clauses = ["l.owner_id = ?"];
    const parameters: SQLInputValue[] = [ownerId];
    if (query.subjectId !== undefined) {
      clauses.push("EXISTS (SELECT 1 FROM open_loop_subjects os WHERE os.loop_id = l.id AND os.subject_id = ?)");
      parameters.push(cleanId(query.subjectId, "subjectId"));
    }
    if (query.state !== undefined) {
      if (!LOOP_STATES.has(query.state)) throw new Error("state is not supported");
      clauses.push("l.state = ?");
      parameters.push(query.state);
    }
    if (query.scope !== undefined) {
      const scope = scopeParts(query.scope);
      clauses.push("e.scope_kind = ?", "e.scope_id = ?");
      parameters.push(scope.kind, scope.id);
      if (scope.kind !== "public") {
        clauses.push("e.scope_participants_json = ?");
        parameters.push(JSON.stringify(scope.participants));
      }
    }
    if (query.visibleInScope !== undefined) {
      appendPromptVisibilityClause(clauses, parameters, "e", query.visibleInScope);
    }
    parameters.push(cleanLimit(query.limit));
    const rows = this.#database
      .prepare(
        `SELECT l.* FROM open_loops l
         JOIN social_events e ON e.id = l.event_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY l.pinned DESC,
                  CASE l.state WHEN 'open' THEN 0 ELSE 1 END,
                  l.updated_at DESC, l.id ASC
         LIMIT ?`,
      )
      .all(...parameters) as Record<string, unknown>[];
    return rows.map((row) => this.#openLoopFromRow(row));
  }

  getOpenLoop(loopId: string): OpenLoop | undefined {
    const id = cleanId(loopId, "loopId");
    const row = this.#database.prepare("SELECT * FROM open_loops WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.#openLoopFromRow(row) : undefined;
  }

  setMemoryPinned(memoryId: string, pinned: boolean, adminId: string, reason?: string): boolean {
    const id = cleanId(memoryId, "memoryId");
    const admin = cleanId(adminId, "adminId");
    const cleanReason = reason === undefined ? undefined : cleanText(reason, LIMITS.reason, "reason");
    if (typeof pinned !== "boolean") throw new TypeError("pinned must be boolean");
    return this.#transaction(() => {
      const memory = this.#database
        .prepare("SELECT owner_id, event_id, pinned, superseded_by FROM memory_views WHERE id = ?")
        .get(id) as Record<string, unknown> | undefined;
      if (!memory) return false;
      if ((rowNumber(memory, "pinned") === 1) === pinned) return false;
      if (pinned) {
        if (memory.superseded_by !== null) throw new Error("a superseded memory cannot be pinned");
        const pinnedCount = this.#database.prepare(
          "SELECT COUNT(*) AS count FROM memory_views WHERE owner_id = ? AND pinned = 1",
        ).get(rowString(memory, "owner_id")) as Record<string, unknown>;
        if (rowNumber(pinnedCount, "count") >= SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxPinnedPerOwner) {
          throw new Error("owner has reached the protected-memory pin limit");
        }
        const globalPinnedCount = this.#database.prepare(
          "SELECT COUNT(*) AS count FROM memory_views WHERE pinned = 1",
        ).get() as Record<string, unknown>;
        if (rowNumber(globalPinnedCount, "count") >= SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxPinnedGlobal) {
          throw new Error("the global protected-memory pin limit has been reached");
        }
      }
      const result = this.#database
        .prepare("UPDATE memory_views SET pinned = ?, updated_at = ? WHERE id = ? AND pinned <> ?")
        .run(pinned ? 1 : 0, this.#nowTimestamp(), id, pinned ? 1 : 0);
      if (Number(result.changes) === 0) return false;
      this.#audit(admin, pinned ? "memory.pin" : "memory.unpin", "memory", id, cleanReason, {
        pinned,
        ownerId: rowString(memory, "owner_id"),
        eventId: rowString(memory, "event_id"),
      });
      return true;
    });
  }

  deleteMemory(memoryId: string, adminId: string, reason?: string): boolean {
    const id = cleanId(memoryId, "memoryId");
    const admin = cleanId(adminId, "adminId");
    const cleanReason = reason === undefined ? undefined : cleanText(reason, LIMITS.reason, "reason");
    return this.#transaction(() => {
      const memory = this.#database
        .prepare("SELECT owner_id, event_id FROM memory_views WHERE id = ?")
        .get(id) as Record<string, unknown> | undefined;
      if (!memory) return false;
      const result = this.#database.prepare("DELETE FROM memory_views WHERE id = ?").run(id);
      if (Number(result.changes) === 0) return false;
      this.#audit(admin, "memory.delete", "memory", id, cleanReason, {
        ownerId: rowString(memory, "owner_id"),
        eventId: rowString(memory, "event_id"),
      });
      return true;
    });
  }

  resetRelationship(ownerId: string, subjectId: string, adminId: string, reason?: string): boolean {
    const owner = cleanId(ownerId, "ownerId");
    const subject = cleanId(subjectId, "subjectId");
    const admin = cleanId(adminId, "adminId");
    const cleanReason = reason === undefined ? undefined : cleanText(reason, LIMITS.reason, "reason");
    return this.#transaction(() => {
      const result = this.#database
        .prepare("DELETE FROM relationship_edges WHERE owner_id = ? AND subject_id = ?")
        .run(owner, subject);
      if (Number(result.changes) === 0) return false;
      this.#database
        .prepare("DELETE FROM relationship_changes WHERE owner_id = ? AND subject_id = ?")
        .run(owner, subject);
      this.#database
        .prepare("DELETE FROM relationship_checkpoints WHERE owner_id = ? AND subject_id = ?")
        .run(owner, subject);
      this.#database
        .prepare("DELETE FROM relationship_daily_budgets WHERE owner_id = ? AND subject_id = ?")
        .run(owner, subject);
      this.#audit(admin, "relationship.reset", "relationship", `${owner}->${subject}`, cleanReason, {
        ownerId: owner,
        subjectId: subject,
      });
      return true;
    });
  }

  setOpenLoopPinned(loopId: string, pinned: boolean, adminId: string, reason?: string): boolean {
    const id = cleanId(loopId, "loopId");
    const admin = cleanId(adminId, "adminId");
    const cleanReason = reason === undefined ? undefined : cleanText(reason, LIMITS.reason, "reason");
    if (typeof pinned !== "boolean") throw new TypeError("pinned must be boolean");
    return this.#transaction(() => {
      const loop = this.#database
        .prepare("SELECT owner_id, event_id, pinned FROM open_loops WHERE id = ?")
        .get(id) as Record<string, unknown> | undefined;
      if (!loop) return false;
      if ((rowNumber(loop, "pinned") === 1) === pinned) return false;
      if (pinned) {
        const ownerPinned = this.#database.prepare(
          "SELECT COUNT(*) AS count FROM open_loops WHERE owner_id = ? AND pinned = 1",
        ).get(rowString(loop, "owner_id")) as Record<string, unknown>;
        if (rowNumber(ownerPinned, "count") >= SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxPinnedOpenLoopsPerOwner) {
          throw new Error("owner has reached the protected open-loop pin limit");
        }
        const globalPinned = this.#database.prepare(
          "SELECT COUNT(*) AS count FROM open_loops WHERE pinned = 1",
        ).get() as Record<string, unknown>;
        if (rowNumber(globalPinned, "count") >= SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxPinnedOpenLoopsGlobal) {
          throw new Error("the global protected open-loop pin limit has been reached");
        }
      }
      const result = this.#database
        .prepare("UPDATE open_loops SET pinned = ?, updated_at = ? WHERE id = ? AND pinned <> ?")
        .run(pinned ? 1 : 0, this.#nowTimestamp(), id, pinned ? 1 : 0);
      if (Number(result.changes) === 0) return false;
      this.#audit(admin, pinned ? "loop.pin" : "loop.unpin", "open_loop", id, cleanReason, {
        pinned,
        ownerId: rowString(loop, "owner_id"),
        eventId: rowString(loop, "event_id"),
      });
      return true;
    });
  }

  setOpenLoopState(loopId: string, state: OpenLoopState, adminId: string, reason?: string): boolean {
    const id = cleanId(loopId, "loopId");
    if (!LOOP_STATES.has(state)) throw new Error("state is not supported");
    const admin = cleanId(adminId, "adminId");
    const cleanReason = reason === undefined ? undefined : cleanText(reason, LIMITS.reason, "reason");
    return this.#transaction(() => {
      const existing = this.#database
        .prepare("SELECT state, owner_id, event_id FROM open_loops WHERE id = ?")
        .get(id) as
        | Record<string, unknown>
        | undefined;
      if (!existing || rowString(existing, "state") === state) return false;
      this.#database
        .prepare("UPDATE open_loops SET state = ?, updated_at = ? WHERE id = ?")
        .run(state, this.#nowTimestamp(), id);
      this.#audit(admin, "loop.state", "open_loop", id, cleanReason, {
        from: rowString(existing, "state"),
        to: state,
        ownerId: rowString(existing, "owner_id"),
        eventId: rowString(existing, "event_id"),
      });
      return true;
    });
  }

  listAudit(query: AuditQuery = {}): AuditEntry[] {
    const clauses: string[] = [];
    const parameters: SQLInputValue[] = [];
    if (query.targetType !== undefined) {
      if (!new Set(["memory", "relationship", "open_loop"]).has(query.targetType)) {
        throw new Error("targetType is not supported");
      }
      clauses.push("target_type = ?");
      parameters.push(query.targetType);
    }
    if (query.targetId !== undefined) {
      clauses.push("target_id = ?");
      parameters.push(cleanText(query.targetId, 260, "targetId"));
    }
    parameters.push(cleanLimit(query.limit));
    const rows = this.#database
      .prepare(
        `SELECT * FROM audit_entries ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...parameters) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: rowNumber(row, "id"),
      adminId: rowString(row, "admin_id"),
      action: rowString(row, "action") as AuditAction,
      targetType: rowString(row, "target_type") as AuditEntry["targetType"],
      targetId: rowString(row, "target_id"),
      ...(row.reason === null ? {} : { reason: rowString(row, "reason") }),
      metadata: JSON.parse(rowString(row, "metadata_json")) as AuditEntry["metadata"],
      createdAt: rowNumber(row, "created_at"),
    }));
  }

  #migrate(): void {
    const versionRow = this.#database.prepare("PRAGMA user_version").get() as Record<string, unknown>;
    const version = Number(versionRow.user_version);
    if (version > SCHEMA_VERSION) {
      throw new Error(`social-memory database schema ${version} is newer than supported ${SCHEMA_VERSION}`);
    }
    if (version < 1) {
      this.#transaction(() => {
        this.#database.exec(migrationOne);
        this.#database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
      return;
    }
    let migratedVersion = version;
    if (version < 2) {
      this.#transaction(() => {
        this.#database.exec(migrationTwo);
        this.#database.exec("PRAGMA user_version = 2");
      });
      migratedVersion = 2;
    }
    if (migratedVersion < 3) {
      this.#transaction(() => {
        this.#database.exec(migrationThree);
        this.#database.exec("PRAGMA user_version = 3");
      });
      migratedVersion = 3;
    }
    if (migratedVersion < 4) {
      this.#transaction(() => {
        this.#database.exec(migrationFour);
        this.#database.exec("PRAGMA user_version = 4");
      });
      migratedVersion = 4;
    }
    if (migratedVersion < 5) {
      this.#transaction(() => {
        this.#database.exec(migrationFive);
        this.#database.exec("PRAGMA user_version = 5");
      });
    }
    this.#reconcileLegacyOpenLoopUpdateBounds();
  }

  #reconcileLegacyOpenLoopUpdateBounds(): void {
    const table = this.#database.prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'open_loop_updates'",
    ).get() as Record<string, unknown> | undefined;
    if (!table) return;
    this.#transaction(() => {
      this.#database.prepare(
        `DELETE FROM open_loops WHERE id IN (
           SELECT loop_id FROM open_loop_updates
           GROUP BY loop_id HAVING COUNT(*) > ?
         )`,
      ).run(SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxUpdatesPerOpenLoop);
      this.#database.prepare(
        `UPDATE open_loops SET state = 'dismissed'
         WHERE state = 'open' AND id IN (
           SELECT loop_id FROM open_loop_updates
           GROUP BY loop_id HAVING COUNT(*) >= ?
         )`,
      ).run(SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxUpdatesPerOpenLoop);
    });
  }

  #nowTimestamp(): number {
    return cleanTimestamp(this.#now(), "now()");
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.#database.exec("COMMIT");
      return value;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #boundOpenLoops(at: number): number {
    const rows = (): Record<string, unknown>[] => this.#database.prepare(
      `SELECT l.id, l.owner_id, l.pinned, l.created_at, l.updated_at,
              e.origin AS event_origin
       FROM open_loops l JOIN social_events e ON e.id = l.event_id
       WHERE l.state = 'open'
       ORDER BY l.updated_at ASC, l.created_at ASC, l.id ASC`,
    ).all() as Record<string, unknown>[];
    const dismiss = this.#database.prepare(
      "UPDATE open_loops SET state = 'dismissed', updated_at = ? WHERE id = ? AND state = 'open' AND pinned = 0",
    );
    const recordAudit = this.#database.prepare(
      `INSERT INTO audit_entries
       (admin_id, action, target_type, target_id, reason, metadata_json, created_at)
       VALUES ('system-lifecycle', 'loop.state', 'open_loop', ?, ?, ?, ?)`,
    );
    const dismissRows = (candidates: Record<string, unknown>[], count: number): number => {
      let dismissed = 0;
      for (const row of candidates) {
        if (dismissed >= count) break;
        if (rowNumber(row, "pinned") === 1) continue;
        const id = rowString(row, "id");
        if (Number(dismiss.run(at, id).changes) === 0) continue;
        recordAudit.run(
          id,
          "Deterministic open-loop capacity bound",
          JSON.stringify({
            from: "open",
            to: "dismissed",
            ownerId: rowString(row, "owner_id"),
            lifecycle: true,
          }),
          at,
        );
        dismissed += 1;
      }
      return dismissed;
    };
    const autonomousFirst = (candidates: Record<string, unknown>[]): Record<string, unknown>[] =>
      [...candidates].sort((left, right) =>
        Number(rowString(right, "event_origin") === "autonomous") -
          Number(rowString(left, "event_origin") === "autonomous") ||
        rowNumber(left, "updated_at") - rowNumber(right, "updated_at") ||
        rowNumber(left, "created_at") - rowNumber(right, "created_at") ||
        rowString(left, "id").localeCompare(rowString(right, "id")),
      );

    let dismissed = 0;
    const byOwner = new Map<string, Record<string, unknown>[]>();
    for (const row of rows()) {
      const ownerId = rowString(row, "owner_id");
      const ownerRows = byOwner.get(ownerId) ?? [];
      ownerRows.push(row);
      byOwner.set(ownerId, ownerRows);
    }
    for (const ownerRows of byOwner.values()) {
      dismissed += dismissRows(
        autonomousFirst(ownerRows),
        Math.max(0, ownerRows.length - SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxOpenLoopsPerOwner),
      );
    }
    const remaining = rows();
    dismissed += dismissRows(
      autonomousFirst(remaining),
      Math.max(0, remaining.length - SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxOpenLoopsGlobal),
    );
    return dismissed;
  }

  /**
   * Checkpoints retain the exact source participant-set key. This lets actor
   * erasure remove every aggregate that actor contributed to, even after the
   * original events have been compacted.
   */
  #checkpointRelationshipChanges(cutoff: number, checkpointedAt: number): number {
    const rows = this.#database.prepare(
      `WITH ranked AS (
         SELECT c.*, e.occurred_at, e.scope_participants_json,
                ROW_NUMBER() OVER (
                  PARTITION BY c.owner_id
                  ORDER BY e.occurred_at DESC, c.created_at DESC, c.event_id DESC, c.subject_id DESC
                ) AS owner_rank,
                ROW_NUMBER() OVER (
                  ORDER BY e.occurred_at DESC, c.created_at DESC, c.event_id DESC,
                           c.owner_id DESC, c.subject_id DESC
                ) AS global_rank
         FROM relationship_changes c
         JOIN social_events e ON e.id = c.event_id
       )
       SELECT * FROM ranked
       WHERE occurred_at <= ? OR owner_rank > ? OR global_rank > ?
       ORDER BY occurred_at ASC, event_id ASC, owner_id ASC, subject_id ASC`,
    ).all(
      cutoff,
      SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxRelationshipChangesPerOwner,
      SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxRelationshipChanges,
    ) as Record<string, unknown>[];
    type Aggregate = RelationshipVector & {
      ownerId: string;
      subjectId: string;
      origin: SocialEventOrigin;
      dayKey: string;
      participantIds: string[];
      spent: RelationshipVector;
      throughAt: number;
      rows: Array<[string, string, string]>;
    };
    const aggregates = new Map<string, Aggregate>();
    for (const row of rows) {
      const ownerId = rowString(row, "owner_id");
      const subjectId = rowString(row, "subject_id");
      const endpoints = new Set([ownerId, subjectId]);
      const eventId = rowString(row, "event_id");
      const participants = JSON.parse(rowString(row, "scope_participants_json")) as unknown;
      if (!Array.isArray(participants) || participants.some((id) => typeof id !== "string")) continue;
      const involved = [
        ...this.#idsFor("event_actors", "actor_id", eventId),
        ...this.#idsFor("event_subjects", "subject_id", eventId),
        ...this.#idsFor("event_witnesses", "witness_id", eventId),
        ...(participants as string[]),
      ];
      for (const endpoint of endpoints) involved.push(endpoint);
      const participantIds = [...new Set(involved)].sort();
      const origin = rowString(row, "origin") as SocialEventOrigin;
      const dayKey = rowString(row, "day_key");
      const participantJson = JSON.stringify(participantIds);
      const key = `${ownerId}\u0000${subjectId}\u0000${origin}\u0000${dayKey}\u0000${participantJson}`;
      const aggregate = aggregates.get(key) ?? {
        ownerId,
        subjectId,
        origin,
        dayKey,
        participantIds,
        familiarity: 0,
        warmth: 0,
        trust: 0,
        respect: 0,
        friction: 0,
        spent: { familiarity: 0, warmth: 0, trust: 0, respect: 0, friction: 0 },
        throughAt: 0,
        rows: [],
      };
      for (const dimension of DIMENSIONS) {
        const applied = rowNumber(row, dimension);
        aggregate[dimension] += applied;
        aggregate.spent[dimension] += Math.abs(applied);
      }
      aggregate.throughAt = Math.max(aggregate.throughAt, rowNumber(row, "occurred_at"));
      aggregate.rows.push([eventId, ownerId, subjectId]);
      aggregates.set(key, aggregate);
    }
    const upsert = this.#database.prepare(
      `INSERT INTO relationship_checkpoints
       (id, owner_id, subject_id, origin, day_key, participant_ids_json,
        familiarity, warmth, trust, respect, friction,
        spent_familiarity, spent_warmth, spent_trust, spent_respect, spent_friction,
        through_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, subject_id, origin, day_key, participant_ids_json) DO UPDATE SET
         familiarity = relationship_checkpoints.familiarity + excluded.familiarity,
         warmth = relationship_checkpoints.warmth + excluded.warmth,
         trust = relationship_checkpoints.trust + excluded.trust,
         respect = relationship_checkpoints.respect + excluded.respect,
         friction = relationship_checkpoints.friction + excluded.friction,
         spent_familiarity = relationship_checkpoints.spent_familiarity + excluded.spent_familiarity,
         spent_warmth = relationship_checkpoints.spent_warmth + excluded.spent_warmth,
         spent_trust = relationship_checkpoints.spent_trust + excluded.spent_trust,
         spent_respect = relationship_checkpoints.spent_respect + excluded.spent_respect,
         spent_friction = relationship_checkpoints.spent_friction + excluded.spent_friction,
         through_at = MAX(relationship_checkpoints.through_at, excluded.through_at),
         updated_at = excluded.updated_at`,
    );
    const remove = this.#database.prepare(
      `DELETE FROM relationship_changes
       WHERE event_id = ? AND owner_id = ? AND subject_id = ?`,
    );
    let checkpointed = 0;
    for (const aggregate of aggregates.values()) {
      upsert.run(
        `relationship-checkpoint-${stableHash({
          ownerId: aggregate.ownerId,
          subjectId: aggregate.subjectId,
          origin: aggregate.origin,
          dayKey: aggregate.dayKey,
          participantIds: aggregate.participantIds,
        }).slice(0, 32)}`,
        aggregate.ownerId,
        aggregate.subjectId,
        aggregate.origin,
        aggregate.dayKey,
        JSON.stringify(aggregate.participantIds),
        aggregate.familiarity,
        aggregate.warmth,
        aggregate.trust,
        aggregate.respect,
        aggregate.friction,
        aggregate.spent.familiarity,
        aggregate.spent.warmth,
        aggregate.spent.trust,
        aggregate.spent.respect,
        aggregate.spent.friction,
        aggregate.throughAt,
        checkpointedAt,
      );
      for (const row of aggregate.rows) {
        checkpointed += Number(remove.run(...row).changes);
      }
    }
    return checkpointed;
  }

  #pruneRelationshipCheckpoints(now: number): number {
    const remove = this.#database.prepare("DELETE FROM relationship_checkpoints WHERE id = ?");
    let pruned = Number(this.#database.prepare(
      "DELETE FROM relationship_checkpoints WHERE through_at <= ?",
    ).run(now - SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.relationshipCheckpointRetentionMs).changes);

    // One unusually social pair must not consume the entire global provenance
    // budget. Human-origin relationship evidence is considered before
    // autonomous 24/7 chatter, then the newest exact participant-set
    // aggregates are retained within each origin class.
    const perPairRows = this.#database.prepare(
      `SELECT id, owner_id, subject_id FROM relationship_checkpoints
       ORDER BY owner_id ASC, subject_id ASC,
                CASE WHEN origin = 'human' THEN 0 ELSE 1 END,
                through_at DESC, updated_at DESC, id DESC`,
    ).all() as Record<string, unknown>[];
    const pairCounts = new Map<string, number>();
    for (const row of perPairRows) {
      const pair = `${rowString(row, "owner_id")}\u0000${rowString(row, "subject_id")}`;
      const kept = pairCounts.get(pair) ?? 0;
      if (kept >= SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxRelationshipCheckpointsPerPair) {
        pruned += Number(remove.run(rowString(row, "id")).changes);
      } else {
        pairCounts.set(pair, kept + 1);
      }
    }

    const globalRows = this.#database.prepare(
      `SELECT id FROM relationship_checkpoints
       ORDER BY CASE WHEN origin = 'autonomous' THEN 0 ELSE 1 END,
                through_at ASC, updated_at ASC, id ASC`,
    ).all() as Record<string, unknown>[];
    const globalExcess = Math.max(
      0,
      globalRows.length - SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxRelationshipCheckpoints,
    );
    for (const row of globalRows.slice(0, globalExcess)) {
      pruned += Number(remove.run(rowString(row, "id")).changes);
    }
    return pruned;
  }

  /**
   * Daily spend watermarks are deliberately separate from relationship
   * provenance. Checkpoint pruning or third-party erasure may remove the
   * signed contribution, but must never make the same pair/day allowance
   * spendable a second time. The watermark contains no witness identities and
   * is itself bounded by both age and deterministic count limits.
   */
  #pruneRelationshipDailyBudgets(now: number): number {
    let pruned = Number(this.#database.prepare(
      "DELETE FROM relationship_daily_budgets WHERE through_at <= ?",
    ).run(now - SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.relationshipCheckpointRetentionMs).changes);

    const perPairOverflow = this.#database.prepare(
      `DELETE FROM relationship_daily_budgets WHERE rowid IN (
         SELECT rowid FROM (
           SELECT rowid, ROW_NUMBER() OVER (
             PARTITION BY owner_id, subject_id, origin
             ORDER BY through_at DESC, updated_at DESC, day_key DESC
           ) AS budget_rank
           FROM relationship_daily_budgets
         ) WHERE budget_rank > ?
       )`,
    ).run(SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxRelationshipDailyBudgetsPerPair);
    pruned += Number(perPairOverflow.changes);

    const budgetCount = rowNumber(this.#database.prepare(
      "SELECT COUNT(*) AS count FROM relationship_daily_budgets",
    ).get() as Record<string, unknown>, "count");
    const globalExcess = Math.max(
      0,
      budgetCount - SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxRelationshipDailyBudgets,
    );
    if (globalExcess > 0) {
      pruned += Number(this.#database.prepare(
        `DELETE FROM relationship_daily_budgets WHERE rowid IN (
           SELECT rowid FROM relationship_daily_budgets
           ORDER BY CASE WHEN origin = 'autonomous' THEN 0 ELSE 1 END,
                    through_at ASC, updated_at ASC, owner_id ASC,
                    subject_id ASC, origin ASC, day_key ASC LIMIT ?
         )`,
      ).run(globalExcess).changes);
    }
    return pruned;
  }

  #recomputeAllRelationshipEdges(): void {
    const rows = this.#database.prepare(
      `WITH history AS (
         SELECT c.owner_id, c.subject_id, c.origin, c.familiarity, c.warmth, c.trust,
                c.respect, c.friction, e.occurred_at AS updated_at
         FROM relationship_changes c JOIN social_events e ON e.id = c.event_id
         UNION ALL
         SELECT owner_id, subject_id, origin, familiarity, warmth, trust, respect,
                friction, through_at AS updated_at
         FROM relationship_checkpoints
       )
       SELECT owner_id, subject_id,
              SUM(CASE WHEN origin = 'human' THEN familiarity ELSE 0 END) AS human_familiarity,
              SUM(CASE WHEN origin = 'human' THEN warmth ELSE 0 END) AS human_warmth,
              SUM(CASE WHEN origin = 'human' THEN trust ELSE 0 END) AS human_trust,
              SUM(CASE WHEN origin = 'human' THEN respect ELSE 0 END) AS human_respect,
              SUM(CASE WHEN origin = 'human' THEN friction ELSE 0 END) AS human_friction,
              SUM(CASE WHEN origin = 'autonomous' THEN familiarity ELSE 0 END) AS autonomous_familiarity,
              SUM(CASE WHEN origin = 'autonomous' THEN warmth ELSE 0 END) AS autonomous_warmth,
              SUM(CASE WHEN origin = 'autonomous' THEN trust ELSE 0 END) AS autonomous_trust,
              SUM(CASE WHEN origin = 'autonomous' THEN respect ELSE 0 END) AS autonomous_respect,
              SUM(CASE WHEN origin = 'autonomous' THEN friction ELSE 0 END) AS autonomous_friction,
              MAX(updated_at) AS updated_at
       FROM history GROUP BY owner_id, subject_id`,
    ).all() as Record<string, unknown>[];
    this.#database.exec("DELETE FROM relationship_edges");
    const insert = this.#database.prepare(
      `INSERT INTO relationship_edges
       (owner_id, subject_id, familiarity, warmth, trust, respect, friction, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      const recomputed = (dimension: RelationshipDimension): number => {
        const human = rowNumber(row, `human_${dimension}`);
        const autonomous = clamp(
          rowNumber(row, `autonomous_${dimension}`),
          -AUTONOMOUS_LIFETIME_ENVELOPES[dimension],
          AUTONOMOUS_LIFETIME_ENVELOPES[dimension],
        );
        return clamp(human + autonomous, ...dimensionRange(dimension));
      };
      insert.run(
        rowString(row, "owner_id"),
        rowString(row, "subject_id"),
        recomputed("familiarity"),
        recomputed("warmth"),
        recomputed("trust"),
        recomputed("respect"),
        recomputed("friction"),
        rowNumber(row, "updated_at"),
      );
    }
  }

  #recomputeOpenLoop(loopId: string): void {
    const loop = this.#database.prepare(
      `SELECT id, initial_summary, summary, created_at, updated_at
       FROM open_loops WHERE id = ?`,
    ).get(loopId) as Record<string, unknown> | undefined;
    if (!loop) return;

    type ReplayOperation =
      | {
          kind: "source";
          createdAt: number;
          sequence: number;
          rowId: number;
          state: OpenLoopState;
          summaryOverride?: string;
        }
      | {
          kind: "admin";
          createdAt: number;
          sequence: number;
          state: OpenLoopState;
        };
    const sourceRows = this.#database.prepare(
      `SELECT u.rowid AS update_rowid, u.next_state, u.summary_override, u.created_at
       FROM open_loop_updates u
       JOIN social_events e ON e.id = u.event_id
       WHERE u.loop_id = ?
       ORDER BY u.created_at ASC, u.rowid ASC`,
    ).all(loopId) as Record<string, unknown>[];
    const operations: ReplayOperation[] = sourceRows.map((row) => ({
      kind: "source",
      createdAt: rowNumber(row, "created_at"),
      sequence: rowNumber(row, "update_rowid"),
      rowId: rowNumber(row, "update_rowid"),
      state: rowString(row, "next_state") as OpenLoopState,
      ...(row.summary_override === null
        ? {}
        : { summaryOverride: rowString(row, "summary_override") }),
    }));
    const auditRows = this.#database.prepare(
      `SELECT id, metadata_json, created_at FROM audit_entries
       WHERE target_type = 'open_loop' AND target_id = ? AND action = 'loop.state'
       ORDER BY created_at ASC, id ASC`,
    ).all(loopId) as Record<string, unknown>[];
    for (const row of auditRows) {
      const metadata = JSON.parse(rowString(row, "metadata_json")) as Record<string, unknown>;
      if (typeof metadata.to !== "string" || !LOOP_STATES.has(metadata.to as OpenLoopState)) continue;
      operations.push({
        kind: "admin",
        createdAt: rowNumber(row, "created_at"),
        sequence: rowNumber(row, "id"),
        state: metadata.to as OpenLoopState,
      });
    }
    operations.sort((left, right) =>
      left.createdAt - right.createdAt ||
      (left.kind === right.kind ? left.sequence - right.sequence : left.kind === "source" ? -1 : 1),
    );

    let state: OpenLoopState = "open";
    let summary = loop.initial_summary === null
      ? rowString(loop, "summary")
      : rowString(loop, "initial_summary");
    let updatedAt = rowNumber(loop, "created_at");
    const rewrite = this.#database.prepare(
      `UPDATE open_loop_updates
       SET previous_state = ?, previous_summary = ?, next_summary = ?
       WHERE rowid = ?`,
    );
    for (const operation of operations) {
      updatedAt = Math.max(updatedAt, operation.createdAt);
      if (operation.kind === "admin") {
        state = operation.state;
        continue;
      }
      const nextSummary = operation.summaryOverride ?? summary;
      rewrite.run(state, summary, nextSummary, operation.rowId);
      state = operation.state;
      summary = nextSummary;
    }
    this.#database.prepare(
      "UPDATE open_loops SET state = ?, summary = ?, updated_at = ? WHERE id = ?",
    ).run(state, summary, updatedAt, loopId);
  }

  #insertIds(table: "event_sources" | "event_actors" | "event_subjects" | "event_witnesses", column: string, eventId: string, ids: string[]): void {
    const statement = this.#database.prepare(`INSERT INTO ${table} (event_id, ${column}) VALUES (?, ?)`);
    for (const id of ids) statement.run(eventId, id);
  }

  #idsFor(table: "event_sources" | "event_actors" | "event_subjects" | "event_witnesses", column: string, eventId: string): string[] {
    const rows = this.#database
      .prepare(`SELECT ${column} AS id FROM ${table} WHERE event_id = ? ORDER BY ${column}`)
      .all(eventId) as Record<string, unknown>[];
    return rows.map((row) => rowString(row, "id"));
  }

  #scopeFromRow(row: Record<string, unknown>): SocialMemoryScope {
    const kind = rowString(row, "scope_kind");
    const id = rowString(row, "scope_id");
    const participants = JSON.parse(rowString(row, "scope_participants_json")) as string[];
    if (kind === "public") return { kind, channelId: id };
    if (kind === "dm") return { kind, threadId: id, participantIds: participants };
    return { kind: "voice", roomId: id, participantIds: participants };
  }

  #eventFromRow(row: Record<string, unknown>): SocialEvent {
    const id = rowString(row, "id");
    return {
      id,
      kind: rowString(row, "kind") as SocialEventKind,
      origin: rowString(row, "origin") as SocialEventOrigin,
      scope: this.#scopeFromRow(row),
      sourceMessageIds: this.#idsFor("event_sources", "message_id", id),
      actorIds: this.#idsFor("event_actors", "actor_id", id),
      subjectIds: this.#idsFor("event_subjects", "subject_id", id),
      witnessIds: this.#idsFor("event_witnesses", "witness_id", id),
      occurredAt: rowNumber(row, "occurred_at"),
      summary: rowString(row, "summary"),
      salience: rowNumber(row, "salience"),
      confidence: rowNumber(row, "confidence"),
      createdAt: rowNumber(row, "created_at"),
    };
  }

  #requireEvent(eventId: string): SocialEvent {
    const event = this.getEvent(eventId);
    if (!event) throw new Error(`social event ${eventId} disappeared during transaction`);
    return event;
  }

  #episodeReceiptFromRow(row: Record<string, unknown>): SocialEpisodeReceipt {
    const eventIds = JSON.parse(rowString(row, "event_ids_json")) as unknown;
    const participantIds = JSON.parse(rowString(row, "participant_ids_json")) as unknown;
    if (!Array.isArray(eventIds) || eventIds.some((id) => typeof id !== "string")) {
      throw new Error("social episode receipt contains invalid event ids");
    }
    if (!Array.isArray(participantIds) || participantIds.some((id) => typeof id !== "string")) {
      throw new Error("social episode receipt contains invalid participant ids");
    }
    const status = rowString(row, "status") as SocialEpisodeReceipt["status"];
    if (!new Set(["recorded", "no_events", "erased"]).has(status)) {
      throw new Error("social episode receipt contains an invalid status");
    }
    return {
      episodeId: rowString(row, "episode_id"),
      fingerprint: rowString(row, "fingerprint"),
      status,
      participantIds,
      eventIds,
      createdAt: rowNumber(row, "created_at"),
    };
  }

  #allMemoryRows(): Record<string, unknown>[] {
    return this.#database.prepare(
      `SELECT m.*, e.kind AS event_kind, e.origin AS event_origin,
              e.scope_kind, e.scope_id, e.scope_participants_json,
              e.summary AS event_summary, e.occurred_at
       FROM memory_views m JOIN social_events e ON e.id = m.event_id
       ORDER BY m.id`,
    ).all() as Record<string, unknown>[];
  }

  #getMemoryRow(memoryId: string): Record<string, unknown> | undefined {
    return this.#database.prepare(
      `SELECT m.*, e.kind AS event_kind, e.origin AS event_origin,
              e.scope_kind, e.scope_id, e.scope_participants_json,
              e.summary AS event_summary, e.occurred_at
       FROM memory_views m JOIN social_events e ON e.id = m.event_id
       WHERE m.id = ?`,
    ).get(memoryId) as Record<string, unknown> | undefined;
  }

  #unresolvedLoopBackedMemoryIds(): Set<string> {
    const rows = this.#database.prepare(
      `SELECT DISTINCT m.id
       FROM memory_views m
       JOIN open_loops l ON l.state = 'open' AND (
         l.event_id = m.event_id OR EXISTS (
           SELECT 1 FROM memory_provenance p
           WHERE p.memory_id = m.id AND p.source_event_id = l.event_id
         )
       )`,
    ).all() as Record<string, unknown>[];
    return new Set(rows.map((row) => rowString(row, "id")));
  }

  #isMemoryActiveRow(
    row: Record<string, unknown>,
    at: number,
    unresolvedLoopBacked: Set<string>,
  ): boolean {
    if (row.superseded_by !== null) return false;
    if (rowNumber(row, "pinned") === 1 || unresolvedLoopBacked.has(rowString(row, "id"))) return true;
    return row.expires_at === null || rowNumber(row, "expires_at") > at;
  }

  #compareMemoryRecallRank(
    left: Record<string, unknown>,
    right: Record<string, unknown>,
    now: number,
  ): number {
    const recentlyRecalled = (row: Record<string, unknown>): boolean =>
      row.last_recalled_at !== null &&
      now - rowNumber(row, "last_recalled_at") < SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.recallCooldownMs;
    const leftRecent = recentlyRecalled(left);
    const rightRecent = recentlyRecalled(right);
    if (leftRecent !== rightRecent) return leftRecent ? 1 : -1;
    const pinDifference = rowNumber(right, "pinned") - rowNumber(left, "pinned");
    if (pinDifference !== 0) return pinDifference;
    const score = (row: Record<string, unknown>): number => {
      const reinforcedAge = Math.max(0, now - rowNumber(row, "reinforced_at"));
      const freshness = Math.max(0, 1 - reinforcedAge / SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.highSalienceExpiryMs);
      const noveltyPenalty = Math.min(0.08, Math.log1p(rowNumber(row, "recall_count")) * 0.02);
      return (
        rowNumber(row, "salience") * 0.55 +
        rowNumber(row, "confidence") * 0.15 +
        freshness * 0.2 +
        (rowString(row, "tier") === "consolidated" ? 0.05 : 0) -
        noveltyPenalty
      );
    };
    const scoreDifference = score(right) - score(left);
    if (Math.abs(scoreDifference) > 1e-12) return scoreDifference;
    const leftRecall = left.last_recalled_at === null ? -1 : rowNumber(left, "last_recalled_at");
    const rightRecall = right.last_recalled_at === null ? -1 : rowNumber(right, "last_recalled_at");
    return leftRecall - rightRecall ||
      rowNumber(right, "reinforced_at") - rowNumber(left, "reinforced_at") ||
      rowString(left, "id").localeCompare(rowString(right, "id"));
  }

  #memoryFromRow(row: Record<string, unknown>): SocialMemoryView {
    const id = rowString(row, "id");
    const eventId = rowString(row, "event_id");
    const provenanceRows = this.#database.prepare(
      `SELECT source_event_id, source_message_ids_json
       FROM memory_provenance WHERE memory_id = ? ORDER BY source_event_id`,
    ).all(id) as Record<string, unknown>[];
    const sourceEventIds = provenanceRows.length === 0
      ? [eventId]
      : provenanceRows.map((source) => rowString(source, "source_event_id"));
    const sourceMessageIds = provenanceRows.length === 0
      ? this.#idsFor("event_sources", "message_id", eventId)
      : [...new Set(provenanceRows.flatMap((source) => {
          const parsed = JSON.parse(rowString(source, "source_message_ids_json")) as unknown;
          if (!Array.isArray(parsed) || parsed.some((message) => typeof message !== "string")) {
            throw new Error("memory provenance contains invalid source message ids");
          }
          return parsed as string[];
        }))].sort();
    const subjects = this.#database
      .prepare("SELECT subject_id FROM memory_subjects WHERE memory_id = ? ORDER BY subject_id")
      .all(id) as Record<string, unknown>[];
    return {
      id,
      eventId,
      ownerId: rowString(row, "owner_id"),
      subjectIds: subjects.map((subject) => rowString(subject, "subject_id")),
      perspective: rowString(row, "perspective"),
      salience: rowNumber(row, "salience"),
      confidence: rowNumber(row, "confidence"),
      pinned: rowNumber(row, "pinned") === 1,
      tier: rowString(row, "tier") as SocialMemoryView["tier"],
      sourceEventIds,
      recallCount: rowNumber(row, "recall_count"),
      ...(row.last_recalled_at === null ? {} : { lastRecalledAt: rowNumber(row, "last_recalled_at") }),
      reinforcedAt: rowNumber(row, "reinforced_at"),
      ...(row.expires_at === null ? {} : { expiresAt: rowNumber(row, "expires_at") }),
      ...(row.superseded_by === null ? {} : { supersededBy: rowString(row, "superseded_by") }),
      createdAt: rowNumber(row, "created_at"),
      updatedAt: rowNumber(row, "updated_at"),
      event: {
        kind: rowString(row, "event_kind") as SocialEventKind,
        origin: rowString(row, "event_origin") as SocialEventOrigin,
        scope: this.#scopeFromRow(row),
        sourceMessageIds,
        summary: rowString(row, "event_summary"),
        occurredAt: rowNumber(row, "occurred_at"),
      },
    };
  }

  #relationshipFromRow(row: Record<string, unknown>): RelationshipEdge {
    return {
      ownerId: rowString(row, "owner_id"),
      subjectId: rowString(row, "subject_id"),
      familiarity: rowNumber(row, "familiarity"),
      warmth: rowNumber(row, "warmth"),
      trust: rowNumber(row, "trust"),
      respect: rowNumber(row, "respect"),
      friction: rowNumber(row, "friction"),
      updatedAt: rowNumber(row, "updated_at"),
    };
  }

  #openLoopFromRow(row: Record<string, unknown>): OpenLoop {
    const id = rowString(row, "id");
    const subjects = this.#database
      .prepare("SELECT subject_id FROM open_loop_subjects WHERE loop_id = ? ORDER BY subject_id")
      .all(id) as Record<string, unknown>[];
    return {
      id,
      eventId: rowString(row, "event_id"),
      ownerId: rowString(row, "owner_id"),
      subjectIds: subjects.map((subject) => rowString(subject, "subject_id")),
      kind: rowString(row, "kind") as OpenLoopKind,
      summary: rowString(row, "summary"),
      state: rowString(row, "state") as OpenLoopState,
      ...(row.due_at === null ? {} : { dueAt: rowNumber(row, "due_at") }),
      pinned: rowNumber(row, "pinned") === 1,
      createdAt: rowNumber(row, "created_at"),
      updatedAt: rowNumber(row, "updated_at"),
    };
  }

  #applyRelationshipDelta(
    event: NormalizedRecordInput,
    requested: RelationshipDeltaInput & RelationshipVector,
    createdAt: number,
  ): AppliedRelationshipDelta {
    const dayKey = new Date(event.occurredAt).toISOString().slice(0, 10);
    const existing = this.getRelationship(requested.ownerId, requested.subjectId) ?? {
      ownerId: requested.ownerId,
      subjectId: requested.subjectId,
      familiarity: 0,
      warmth: 0,
      trust: 0,
      respect: 0,
      friction: 0,
      updatedAt: createdAt,
    };
    const caps = event.origin === "human" ? this.#humanCaps : this.#autonomousCaps;
    const spentRow = this.#database
      .prepare(
        `SELECT spent_familiarity AS familiarity, spent_warmth AS warmth,
                spent_trust AS trust, spent_respect AS respect,
                spent_friction AS friction
         FROM relationship_daily_budgets
         WHERE owner_id = ? AND subject_id = ? AND origin = ? AND day_key = ?`,
      )
      .get(
        requested.ownerId,
        requested.subjectId,
        event.origin,
        dayKey,
      ) as Record<string, unknown> | undefined;
    const legacyWatermarkRow = this.#database.prepare(
      `SELECT MAX(through_at) AS through_at FROM relationship_checkpoints
       WHERE owner_id = ? AND subject_id = ? AND origin = ? AND day_key = 'legacy'`,
    ).get(requested.ownerId, requested.subjectId, event.origin) as Record<string, unknown>;
    const legacyBackdatedQuarantine = legacyWatermarkRow.through_at !== null &&
      event.occurredAt <= rowNumber(legacyWatermarkRow, "through_at");
    const autonomousLifetimeRow = event.origin === "autonomous"
      ? this.#database.prepare(
        `WITH autonomous_history AS (
           SELECT familiarity, warmth, trust, respect, friction
           FROM relationship_changes
           WHERE owner_id = ? AND subject_id = ? AND origin = 'autonomous'
           UNION ALL
           SELECT familiarity, warmth, trust, respect, friction
           FROM relationship_checkpoints
           WHERE owner_id = ? AND subject_id = ? AND origin = 'autonomous'
         )
         SELECT COALESCE(SUM(familiarity), 0) AS familiarity,
                COALESCE(SUM(warmth), 0) AS warmth,
                COALESCE(SUM(trust), 0) AS trust,
                COALESCE(SUM(respect), 0) AS respect,
                COALESCE(SUM(friction), 0) AS friction
         FROM autonomous_history`,
      ).get(
        requested.ownerId,
        requested.subjectId,
        requested.ownerId,
        requested.subjectId,
      ) as Record<string, unknown>
      : undefined;

    const applied = {} as RelationshipVector;
    const next = { ...existing };
    for (const dimension of DIMENSIONS) {
      const remaining = legacyBackdatedQuarantine
        ? 0
        : Math.max(0, caps[dimension] - (spentRow ? rowNumber(spentRow, dimension) : 0));
      const budgeted = Math.sign(requested[dimension]) * Math.min(Math.abs(requested[dimension]), remaining);
      let lifetimeBounded = budgeted;
      if (autonomousLifetimeRow) {
        const history = rowNumber(autonomousLifetimeRow, dimension);
        const envelope = AUTONOMOUS_LIFETIME_ENVELOPES[dimension];
        // Actor erasure can remove only one side of an old positive/negative
        // sequence, leaving surviving provenance outside the lifetime envelope.
        // Never "correct" that with one oversized opposite turn: movement back
        // toward the envelope remains daily-bounded, and movement farther away
        // is held at zero until history naturally returns inside it.
        if ((history >= envelope && budgeted > 0) || (history <= -envelope && budgeted < 0)) {
          lifetimeBounded = 0;
        } else if ((history > envelope && budgeted < 0) || (history < -envelope && budgeted > 0)) {
          lifetimeBounded = budgeted;
        } else {
          lifetimeBounded = clamp(history + budgeted, -envelope, envelope) - history;
        }
      }
      const [minimum, maximum] = dimensionRange(dimension);
      const nextValue = clamp(existing[dimension] + lifetimeBounded, minimum, maximum);
      applied[dimension] = nextValue - existing[dimension];
      next[dimension] = nextValue;
    }

    this.#database
      .prepare(
        `INSERT INTO relationship_edges
         (owner_id, subject_id, familiarity, warmth, trust, respect, friction, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_id, subject_id) DO UPDATE SET
           familiarity = excluded.familiarity,
           warmth = excluded.warmth,
           trust = excluded.trust,
           respect = excluded.respect,
           friction = excluded.friction,
           updated_at = excluded.updated_at`,
      )
      .run(
        requested.ownerId,
        requested.subjectId,
        next.familiarity,
        next.warmth,
        next.trust,
        next.respect,
        next.friction,
        event.occurredAt,
      );
    this.#database
      .prepare(
        `INSERT INTO relationship_changes
         (event_id, owner_id, subject_id, origin, day_key,
          familiarity, warmth, trust, respect, friction, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        requested.ownerId,
        requested.subjectId,
        event.origin,
        dayKey,
        applied.familiarity,
        applied.warmth,
        applied.trust,
        applied.respect,
        applied.friction,
        createdAt,
      );
    if (DIMENSIONS.some((dimension) => Math.abs(applied[dimension]) > 0)) {
      this.#database.prepare(
        `INSERT INTO relationship_daily_budgets
         (owner_id, subject_id, origin, day_key,
          spent_familiarity, spent_warmth, spent_trust, spent_respect, spent_friction,
          through_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_id, subject_id, origin, day_key) DO UPDATE SET
           spent_familiarity = relationship_daily_budgets.spent_familiarity + excluded.spent_familiarity,
           spent_warmth = relationship_daily_budgets.spent_warmth + excluded.spent_warmth,
           spent_trust = relationship_daily_budgets.spent_trust + excluded.spent_trust,
           spent_respect = relationship_daily_budgets.spent_respect + excluded.spent_respect,
           spent_friction = relationship_daily_budgets.spent_friction + excluded.spent_friction,
           through_at = MAX(relationship_daily_budgets.through_at, excluded.through_at),
           updated_at = MAX(relationship_daily_budgets.updated_at, excluded.updated_at)`,
      ).run(
        requested.ownerId,
        requested.subjectId,
        event.origin,
        dayKey,
        Math.abs(applied.familiarity),
        Math.abs(applied.warmth),
        Math.abs(applied.trust),
        Math.abs(applied.respect),
        Math.abs(applied.friction),
        event.occurredAt,
        createdAt,
      );
    }
    return {
      eventId: event.id,
      ownerId: requested.ownerId,
      subjectId: requested.subjectId,
      origin: event.origin,
      dayKey,
      ...applied,
    };
  }

  #listAppliedDeltas(eventId: string): AppliedRelationshipDelta[] {
    const rows = this.#database
      .prepare("SELECT * FROM relationship_changes WHERE event_id = ? ORDER BY owner_id, subject_id")
      .all(eventId) as Record<string, unknown>[];
    return rows.map((row) => ({
      eventId: rowString(row, "event_id"),
      ownerId: rowString(row, "owner_id"),
      subjectId: rowString(row, "subject_id"),
      origin: rowString(row, "origin") as SocialEventOrigin,
      dayKey: rowString(row, "day_key"),
      familiarity: rowNumber(row, "familiarity"),
      warmth: rowNumber(row, "warmth"),
      trust: rowNumber(row, "trust"),
      respect: rowNumber(row, "respect"),
      friction: rowNumber(row, "friction"),
    }));
  }

  #applyOpenLoopUpdate(
    event: NormalizedRecordInput,
    update: OpenLoopUpdateInput,
    createdAt: number,
  ): OpenLoop {
    const row = this.#database
      .prepare(
        `SELECT l.*, e.scope_kind, e.scope_id, e.scope_participants_json
         FROM open_loops l JOIN social_events e ON e.id = l.event_id WHERE l.id = ?`,
      )
      .get(update.id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`open loop ${update.id} does not exist`);
    const currentScope = scopeParts(event.scope);
    const rememberedKind = rowString(row, "scope_kind");
    const rememberedParticipants = rowString(row, "scope_participants_json");
    const exactParticipants = rememberedParticipants === JSON.stringify(currentScope.participants);
    // Public commitments may continue in another public room, and a voice
    // commitment may survive a new ephemeral room ID only for the exact same
    // audience. DMs remain tied to their canonical thread and audience. No
    // private episode may ever mutate a public loop.
    const mutableInCurrentScope = currentScope.kind === "public"
      ? rememberedKind === "public"
      : currentScope.kind === "voice"
        ? rememberedKind === "voice" && exactParticipants
        : rememberedKind === "dm" &&
          rowString(row, "scope_id") === currentScope.id &&
          exactParticipants;
    if (!mutableInCurrentScope) {
      throw new Error(`open loop ${update.id} belongs to a different scope`);
    }
    const observerIds = new Set([...event.actorIds, ...event.witnessIds]);
    if (!observerIds.has(rowString(row, "owner_id"))) {
      throw new Error(`open loop ${update.id} owner did not witness the updating event`);
    }
    const previousState = rowString(row, "state") as OpenLoopState;
    if (previousState !== "open") throw new Error(`open loop ${update.id} is no longer open`);
    const updateCount = rowNumber(this.#database.prepare(
      "SELECT COUNT(*) AS count FROM open_loop_updates WHERE loop_id = ?",
    ).get(update.id) as Record<string, unknown>, "count");
    if (updateCount >= SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxUpdatesPerOpenLoop) {
      throw new Error(`open loop ${update.id} reached its update limit`);
    }
    const previousSummary = rowString(row, "summary");
    const nextSummary = update.summary ?? previousSummary;
    const nextState: OpenLoopState =
      update.state === "open" && updateCount + 1 >= SOCIAL_MEMORY_LIFECYCLE_DEFAULTS.maxUpdatesPerOpenLoop
        ? "dismissed"
        : update.state;
    this.#database
      .prepare("UPDATE open_loops SET state = ?, summary = ?, updated_at = ? WHERE id = ?")
      .run(nextState, nextSummary, event.occurredAt, update.id);
    this.#database
      .prepare(
        `INSERT INTO open_loop_updates
         (event_id, loop_id, previous_state, next_state, previous_summary, next_summary,
          summary_override, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        update.id,
        previousState,
        nextState,
        previousSummary,
        nextSummary,
        update.summary ?? null,
        createdAt,
      );
    const result = this.getOpenLoop(update.id);
    if (!result) throw new Error(`open loop ${update.id} disappeared during transaction`);
    return result;
  }

  #listEventUpdatedLoops(eventId: string): OpenLoop[] {
    const rows = this.#database
      .prepare("SELECT loop_id FROM open_loop_updates WHERE event_id = ? ORDER BY loop_id")
      .all(eventId) as Record<string, unknown>[];
    return rows.flatMap((row) => {
      const loop = this.getOpenLoop(rowString(row, "loop_id"));
      return loop ? [loop] : [];
    });
  }

  #audit(
    adminId: string,
    action: AuditAction,
    targetType: AuditEntry["targetType"],
    targetId: string,
    reason: string | undefined,
    metadata: AuditEntry["metadata"],
  ): void {
    this.#database
      .prepare(
        `INSERT INTO audit_entries
         (admin_id, action, target_type, target_id, reason, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        adminId,
        action,
        targetType,
        targetId,
        reason ?? null,
        JSON.stringify(metadata),
        this.#nowTimestamp(),
      );
  }
}
