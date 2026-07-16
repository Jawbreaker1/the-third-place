import type {
  AdminMemoryActorDetail,
  AdminMemoryActorSummary,
  AdminMemoryAuditEntry,
  AdminMemoryItem,
  AdminMemoryOpenLoop,
  AdminMemoryOverview,
  AdminMemoryRelationship,
} from "../shared/adminTypes.js";
import {
  SocialMemoryStore,
  type AuditEntry,
  type OpenLoop,
  type RelationshipEdge,
  type SocialMemoryScope,
  type SocialMemoryView,
} from "./socialMemory.js";

const ADMIN_ACTOR_ID = "local-admin";
const MAX_CATALOG_ACTORS = 200;
const MAX_ROWS_PER_ACTOR = 50;
const MAX_AUDIT_ROWS = 50;
const SAFE_ID = /^[\p{L}\p{N}_.:@/+\-=]{1,120}$/u;
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

export interface SocialMemoryAdminActor {
  id: string;
  name: string;
  kind: "resident" | "human";
}

export interface SocialMemoryAdminOptions {
  store: SocialMemoryStore;
  getActors: () => readonly SocialMemoryAdminActor[];
}

interface ActorProjection {
  actor: SocialMemoryAdminActor;
  memories: SocialMemoryView[];
  outgoing: RelationshipEdge[];
  incoming: RelationshipEdge[];
  loops: OpenLoop[];
}

const boundedText = (value: unknown, maximum: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maximum || CONTROL_CHARACTERS.test(normalized)) return undefined;
  return normalized;
};

const boundedId = (value: unknown): string | undefined => {
  const id = boundedText(value, 120);
  return id && SAFE_ID.test(id) ? id : undefined;
};

const asIso = (epochMilliseconds: number): string => new Date(epochMilliseconds).toISOString();

const scopeLabel = (scope: SocialMemoryScope): string => {
  if (scope.kind === "public") return `public:${scope.channelId}`;
  if (scope.kind === "dm") return `dm:${scope.threadId}`;
  return `voice:${scope.roomId}`;
};

const maximum = (values: number[]): number | undefined => {
  const finite = values.filter(Number.isFinite);
  return finite.length ? Math.max(...finite) : undefined;
};

/**
 * Read-only DTO projection plus narrowly scoped admin mutations for social memory.
 * It deliberately exposes neither SQLite rows nor model-analysis payloads.
 */
export class SocialMemoryAdmin {
  readonly #store: SocialMemoryStore;
  readonly #getActors: () => readonly SocialMemoryAdminActor[];

  constructor(options: SocialMemoryAdminOptions) {
    this.#store = options.store;
    this.#getActors = options.getActors;
  }

  getOverview(): AdminMemoryOverview {
    const actors = this.#catalog();
    const eventCache = new Map<string, ReturnType<SocialMemoryStore["getEvent"]>>();
    const projections = actors.map((actor) => this.#projectActor(actor));
    const storeOverview = this.#store.overview();
    return {
      stats: {
        actors: actors.length,
        memories: storeOverview.stats.memories,
        relationships: storeOverview.stats.relationships,
        openLoops: storeOverview.stats.openLoops,
        auditEntries: storeOverview.stats.auditEntries,
      },
      actors: projections
        .map((projection) => this.#actorSummary(projection, eventCache))
        .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
    };
  }

  getActorDetail(actorId: string): AdminMemoryActorDetail | undefined {
    const requestedId = boundedId(actorId);
    if (!requestedId) return undefined;
    const actors = this.#catalog();
    const actor = actors.find((candidate) => candidate.id === requestedId);
    if (!actor) return undefined;

    const names = new Map(actors.map((candidate) => [candidate.id, candidate.name]));
    const eventCache = new Map<string, ReturnType<SocialMemoryStore["getEvent"]>>();
    const projection = this.#projectActor(actor);
    const memorySources = new Map(
      projection.memories.map((memory) => [
        memory.id,
        { eventId: memory.eventId, messageIds: [...memory.event.sourceMessageIds] },
      ]),
    );
    const loopSources = new Map(
      projection.loops.map((loop) => {
        const event = this.#event(loop.eventId, eventCache);
        return [
          loop.id,
          { eventId: loop.eventId, messageIds: event ? [...event.sourceMessageIds] : [] },
        ];
      }),
    );

    return {
      actor: this.#actorSummary(projection, eventCache),
      ownedMemories: projection.memories.map((memory) => this.#memoryItem(memory)),
      outgoingRelationships: projection.outgoing.map((relationship) =>
        this.#relationshipItem(relationship, names),
      ),
      incomingRelationships: projection.incoming.map((relationship) =>
        this.#relationshipItem(relationship, names),
      ),
      openLoops: projection.loops.map((loop) => this.#loopItem(loop, eventCache)),
      audit: this.#store
        .listAudit({ limit: MAX_AUDIT_ROWS })
        .filter((entry) => this.#auditBelongsToActor(entry, actor.id, memorySources, loopSources))
        .map((entry) => this.#auditItem(entry, actor.id, memorySources, loopSources, eventCache)),
    };
  }

  setMemoryPinned(memoryId: string, pinned: boolean): boolean {
    if (!boundedId(memoryId) || typeof pinned !== "boolean") return false;
    return this.#store.setMemoryPinned(memoryId, pinned, ADMIN_ACTOR_ID);
  }

  deleteMemory(memoryId: string): boolean {
    if (!boundedId(memoryId)) return false;
    return this.#store.deleteMemory(memoryId, ADMIN_ACTOR_ID);
  }

  resetRelationship(ownerId: string, subjectId: string): boolean {
    const owner = boundedId(ownerId);
    const subject = boundedId(subjectId);
    if (!owner || !subject) return false;
    return this.#store.resetRelationship(owner, subject, ADMIN_ACTOR_ID);
  }

  #catalog(): SocialMemoryAdminActor[] {
    const result: SocialMemoryAdminActor[] = [];
    const seen = new Set<string>();
    for (const candidate of this.#getActors().slice(0, MAX_CATALOG_ACTORS)) {
      if (!candidate || (candidate.kind !== "resident" && candidate.kind !== "human")) continue;
      const id = boundedId(candidate.id);
      const name = boundedText(candidate.name, 160);
      if (!id || !name || seen.has(id)) continue;
      seen.add(id);
      result.push({ id, name, kind: candidate.kind });
    }
    // A human can leave, or a resident can be removed, while their directed
    // relationship edges remain useful historical state. Keep those actors
    // inspectable even when the live catalog no longer knows their display name.
    for (const id of this.#store.overview().actorIds) {
      if (result.length >= MAX_CATALOG_ACTORS) break;
      if (seen.has(id)) continue;
      seen.add(id);
      result.push({
        id,
        name: id,
        kind: id.startsWith("ai-") || id.startsWith("resident-") ? "resident" : "human",
      });
    }
    return result;
  }

  #projectActor(actor: SocialMemoryAdminActor): ActorProjection {
    return {
      actor,
      memories: this.#store.listMemories({ ownerId: actor.id, limit: MAX_ROWS_PER_ACTOR }),
      outgoing: this.#store.listRelationships({ ownerId: actor.id, limit: MAX_ROWS_PER_ACTOR }),
      incoming: this.#store.listRelationships({ subjectId: actor.id, limit: MAX_ROWS_PER_ACTOR }),
      loops: this.#store.listOpenLoops({ ownerId: actor.id, limit: MAX_ROWS_PER_ACTOR }),
    };
  }

  #actorSummary(
    projection: ActorProjection,
    eventCache: Map<string, ReturnType<SocialMemoryStore["getEvent"]>>,
  ): AdminMemoryActorSummary {
    const memoryActivity = projection.memories.map((memory) => memory.event.occurredAt);
    const relationshipActivity = [...projection.outgoing, ...projection.incoming].map(
      (relationship) => relationship.updatedAt,
    );
    const loopActivity = projection.loops.map((loop) =>
      this.#event(loop.eventId, eventCache)?.occurredAt ?? loop.createdAt,
    );
    const lastActivityAt = maximum([...memoryActivity, ...relationshipActivity, ...loopActivity]);
    return {
      ...projection.actor,
      memoryCount: projection.memories.length,
      outgoingRelationshipCount: projection.outgoing.length,
      incomingRelationshipCount: projection.incoming.length,
      openLoopCount: projection.loops.filter((loop) => loop.state === "open").length,
      ...(lastActivityAt === undefined ? {} : { lastActivityAt: asIso(lastActivityAt) }),
    };
  }

  #memoryItem(memory: SocialMemoryView): AdminMemoryItem {
    return {
      id: memory.id,
      ownerId: memory.ownerId,
      kind: memory.event.kind,
      scope: scopeLabel(memory.event.scope),
      perspective: memory.perspective,
      summary: memory.event.summary,
      confidence: memory.confidence,
      salience: memory.salience,
      pinned: memory.pinned,
      sourceEventIds: [memory.eventId],
      sourceMessageIds: [...memory.event.sourceMessageIds],
      createdAt: asIso(memory.createdAt),
      updatedAt: asIso(memory.updatedAt),
    };
  }

  #relationshipItem(
    relationship: RelationshipEdge,
    names: ReadonlyMap<string, string>,
  ): AdminMemoryRelationship {
    return {
      ownerId: relationship.ownerId,
      subjectId: relationship.subjectId,
      ownerName: names.get(relationship.ownerId) ?? relationship.ownerId,
      subjectName: names.get(relationship.subjectId) ?? relationship.subjectId,
      familiarity: relationship.familiarity,
      warmth: relationship.warmth,
      trust: relationship.trust,
      respect: relationship.respect,
      friction: relationship.friction,
      updatedAt: asIso(relationship.updatedAt),
    };
  }

  #loopItem(
    loop: OpenLoop,
    eventCache: Map<string, ReturnType<SocialMemoryStore["getEvent"]>>,
  ): AdminMemoryOpenLoop {
    const event = this.#event(loop.eventId, eventCache);
    return {
      id: loop.id,
      ownerId: loop.ownerId,
      kind: loop.kind,
      summary: loop.summary,
      status: loop.state,
      subjectIds: [...loop.subjectIds],
      sourceEventIds: [loop.eventId],
      sourceMessageIds: event ? [...event.sourceMessageIds] : [],
      createdAt: asIso(loop.createdAt),
      updatedAt: asIso(loop.updatedAt),
    };
  }

  #auditItem(
    entry: AuditEntry,
    actorId: string,
    memorySources: ReadonlyMap<string, { eventId: string; messageIds: string[] }>,
    loopSources: ReadonlyMap<string, { eventId: string; messageIds: string[] }>,
    eventCache: Map<string, ReturnType<SocialMemoryStore["getEvent"]>>,
  ): AdminMemoryAuditEntry {
    const indexedSource = entry.targetType === "memory"
      ? memorySources.get(entry.targetId)
      : entry.targetType === "open_loop"
        ? loopSources.get(entry.targetId)
        : undefined;
    const metadataEventId = boundedId(entry.metadata.eventId);
    const metadataEvent = !indexedSource && metadataEventId
      ? this.#event(metadataEventId, eventCache)
      : undefined;
    const source = indexedSource ?? (metadataEventId
      ? { eventId: metadataEventId, messageIds: metadataEvent?.sourceMessageIds ?? [] }
      : undefined);
    return {
      id: String(entry.id),
      actorId,
      action: entry.action,
      entityType: entry.targetType,
      entityId: entry.targetId,
      summary: entry.reason ?? entry.action.replaceAll(".", " "),
      sourceEventIds: source ? [source.eventId] : [],
      sourceMessageIds: source ? [...source.messageIds] : [],
      createdAt: asIso(entry.createdAt),
    };
  }

  #auditBelongsToActor(
    entry: AuditEntry,
    actorId: string,
    memorySources: ReadonlyMap<string, { eventId: string; messageIds: string[] }>,
    loopSources: ReadonlyMap<string, { eventId: string; messageIds: string[] }>,
  ): boolean {
    if (entry.targetType === "memory") {
      return memorySources.has(entry.targetId) || entry.metadata.ownerId === actorId;
    }
    if (entry.targetType === "open_loop") {
      return loopSources.has(entry.targetId) || entry.metadata.ownerId === actorId;
    }
    return entry.metadata.ownerId === actorId || entry.metadata.subjectId === actorId ||
      entry.targetId.startsWith(`${actorId}->`) || entry.targetId.endsWith(`->${actorId}`);
  }

  #event(
    eventId: string,
    cache: Map<string, ReturnType<SocialMemoryStore["getEvent"]>>,
  ): ReturnType<SocialMemoryStore["getEvent"]> {
    if (!cache.has(eventId)) cache.set(eventId, this.#store.getEvent(eventId));
    return cache.get(eventId);
  }
}
