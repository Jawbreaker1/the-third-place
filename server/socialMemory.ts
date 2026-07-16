import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const SCHEMA_VERSION = 2;

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
} as const;

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
  scope?: SocialMemoryScope;
  limit?: number;
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
  scope?: SocialMemoryScope;
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

const cleanLimit = (value: unknown): number => {
  if (value === undefined) return 20;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("limit must be a positive integer");
  }
  return Math.min(value, LIMITS.retrieval);
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
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (event_id, owner_id)
  ) STRICT;
  CREATE TABLE memory_subjects (
    memory_id TEXT NOT NULL REFERENCES memory_views(id) ON DELETE CASCADE,
    subject_id TEXT NOT NULL,
    PRIMARY KEY (memory_id, subject_id)
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
  CREATE INDEX memory_owner_recency ON memory_views(owner_id, pinned DESC, updated_at DESC);
  CREATE INDEX memory_subject_lookup ON memory_subjects(subject_id, memory_id);
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

  overview(): SocialMemoryOverview {
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
      const memories = countWhereActor("memory_views", "owner_id", "memory_subjects", "memory_id");
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
             (id, event_id, owner_id, perspective, salience, confidence, pinned, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          )
          .run(
            view.id,
            normalized.id,
            view.ownerId,
            view.perspective,
            view.salience,
            view.confidence,
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
    const limit = cleanLimit(query.limit);
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
    parameters.push(limit);
    const rows = this.#database
      .prepare(
        `SELECT m.*, e.kind AS event_kind, e.origin AS event_origin,
                e.scope_kind, e.scope_id, e.scope_participants_json,
                e.summary AS event_summary, e.occurred_at
         FROM memory_views m
         JOIN social_events e ON e.id = m.event_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY m.pinned DESC, m.salience DESC, e.occurred_at DESC, m.id ASC
         LIMIT ?`,
      )
      .all(...parameters) as Record<string, unknown>[];
    return rows.map((row) => this.#memoryFromRow(row));
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
        .prepare("SELECT owner_id, event_id FROM memory_views WHERE id = ?")
        .get(id) as Record<string, unknown> | undefined;
      if (!memory) return false;
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
        .prepare("SELECT owner_id, event_id FROM open_loops WHERE id = ?")
        .get(id) as Record<string, unknown> | undefined;
      if (!loop) return false;
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
    if (version < 2) {
      this.#transaction(() => {
        this.#database.exec(migrationTwo);
        this.#database.exec("PRAGMA user_version = 2");
      });
    }
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

  #recomputeAllRelationshipEdges(): void {
    const rows = this.#database.prepare(
      `SELECT c.owner_id, c.subject_id,
              SUM(c.familiarity) AS familiarity,
              SUM(c.warmth) AS warmth,
              SUM(c.trust) AS trust,
              SUM(c.respect) AS respect,
              SUM(c.friction) AS friction,
              MAX(e.occurred_at) AS updated_at
       FROM relationship_changes c
       JOIN social_events e ON e.id = c.event_id
       GROUP BY c.owner_id, c.subject_id`,
    ).all() as Record<string, unknown>[];
    this.#database.exec("DELETE FROM relationship_edges");
    const insert = this.#database.prepare(
      `INSERT INTO relationship_edges
       (owner_id, subject_id, familiarity, warmth, trust, respect, friction, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      insert.run(
        rowString(row, "owner_id"),
        rowString(row, "subject_id"),
        clamp(rowNumber(row, "familiarity"), ...dimensionRange("familiarity")),
        clamp(rowNumber(row, "warmth"), ...dimensionRange("warmth")),
        clamp(rowNumber(row, "trust"), ...dimensionRange("trust")),
        clamp(rowNumber(row, "respect"), ...dimensionRange("respect")),
        clamp(rowNumber(row, "friction"), ...dimensionRange("friction")),
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

  #memoryFromRow(row: Record<string, unknown>): SocialMemoryView {
    const id = rowString(row, "id");
    const sourceMessageIds = this.#idsFor("event_sources", "message_id", rowString(row, "event_id"));
    const subjects = this.#database
      .prepare("SELECT subject_id FROM memory_subjects WHERE memory_id = ? ORDER BY subject_id")
      .all(id) as Record<string, unknown>[];
    return {
      id,
      eventId: rowString(row, "event_id"),
      ownerId: rowString(row, "owner_id"),
      subjectIds: subjects.map((subject) => rowString(subject, "subject_id")),
      perspective: rowString(row, "perspective"),
      salience: rowNumber(row, "salience"),
      confidence: rowNumber(row, "confidence"),
      pinned: rowNumber(row, "pinned") === 1,
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
        `SELECT
           COALESCE(SUM(ABS(familiarity)), 0) AS familiarity,
           COALESCE(SUM(ABS(warmth)), 0) AS warmth,
           COALESCE(SUM(ABS(trust)), 0) AS trust,
           COALESCE(SUM(ABS(respect)), 0) AS respect,
           COALESCE(SUM(ABS(friction)), 0) AS friction
         FROM relationship_changes
         WHERE owner_id = ? AND subject_id = ? AND origin = ? AND day_key = ?`,
      )
      .get(requested.ownerId, requested.subjectId, event.origin, dayKey) as Record<string, unknown>;
    const autonomousLifetimeRow = event.origin === "autonomous"
      ? this.#database.prepare(
        `SELECT
           COALESCE(SUM(familiarity), 0) AS familiarity,
           COALESCE(SUM(warmth), 0) AS warmth,
           COALESCE(SUM(trust), 0) AS trust,
           COALESCE(SUM(respect), 0) AS respect,
           COALESCE(SUM(friction), 0) AS friction
         FROM relationship_changes
         WHERE owner_id = ? AND subject_id = ? AND origin = 'autonomous'`,
      ).get(requested.ownerId, requested.subjectId) as Record<string, unknown>
      : undefined;

    const applied = {} as RelationshipVector;
    const next = { ...existing };
    for (const dimension of DIMENSIONS) {
      const remaining = Math.max(0, caps[dimension] - rowNumber(spentRow, dimension));
      const budgeted = Math.sign(requested[dimension]) * Math.min(Math.abs(requested[dimension]), remaining);
      const lifetimeBounded = autonomousLifetimeRow
        ? clamp(
          rowNumber(autonomousLifetimeRow, dimension) + budgeted,
          -AUTONOMOUS_LIFETIME_ENVELOPES[dimension],
          AUTONOMOUS_LIFETIME_ENVELOPES[dimension],
        ) - rowNumber(autonomousLifetimeRow, dimension)
        : budgeted;
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
    if (
      rowString(row, "scope_kind") !== currentScope.kind ||
      rowString(row, "scope_id") !== currentScope.id ||
      (currentScope.kind !== "public" &&
        rowString(row, "scope_participants_json") !== JSON.stringify(currentScope.participants))
    ) {
      throw new Error(`open loop ${update.id} belongs to a different scope`);
    }
    const observerIds = new Set([...event.actorIds, ...event.witnessIds]);
    if (!observerIds.has(rowString(row, "owner_id"))) {
      throw new Error(`open loop ${update.id} owner did not witness the updating event`);
    }
    const previousState = rowString(row, "state") as OpenLoopState;
    const previousSummary = rowString(row, "summary");
    const nextSummary = update.summary ?? previousSummary;
    this.#database
      .prepare("UPDATE open_loops SET state = ?, summary = ?, updated_at = ? WHERE id = ?")
      .run(update.state, nextSummary, event.occurredAt, update.id);
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
        update.state,
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
