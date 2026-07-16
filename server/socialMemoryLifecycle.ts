import { createHash } from "node:crypto";
import type { SocialModelClient } from "./switchableModel.js";
import {
  socialMemoryConsolidationInputSchema,
  type NormalizedSocialMemoryConsolidationInput,
} from "./socialMemoryConsolidation.js";
import {
  SocialMemoryStore,
  type ConsolidationBatch,
  type LifecycleMaintenanceResult,
} from "./socialMemory.js";

const MAX_CONSOLIDATION_CANDIDATES = 12;
const DEFAULT_MIN_CONSOLIDATION_CANDIDATES = 8;
const DEFAULT_INTERVAL_MS = 30 * 60_000;
const DEFAULT_CHANGE_DELAY_MS = 5_000;
const FAILED_BATCH_RETRY_MS = 2 * 60 * 60_000;
const NO_ACTION_BATCH_RETRY_MS = 24 * 60 * 60_000;
const MAX_DEFERRED_BATCHES = 512;

type ConsolidationModel = Pick<SocialModelClient, "consolidateSocialMemories">;

export interface SocialMemoryLifecycleOptions {
  intervalMs?: number;
  changeDelayMs?: number;
  minimumConsolidationCandidates?: number;
  now?: () => number;
  onError?: (error: unknown) => void;
  onStateChanged?: () => void;
}

export interface SocialMemoryLifecycleRunResult {
  batchId?: string;
  consideredMemories: number;
  proposedActions: number;
  appliedConsolidations: number;
  maintenance: LifecycleMaintenanceResult;
  failureReason?: string;
}

const boundedDuration = (value: number | undefined, fallback: number, minimum: number, maximum: number): number =>
  Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value!)))
    : fallback;

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();

const batchFingerprint = (batch: ConsolidationBatch): string => {
  const canonical = JSON.stringify({
    ownerId: batch.ownerId,
    subjectIds: sortedUnique(batch.subjectIds),
    scope: batch.scope.kind === "public"
      ? batch.scope
      : { ...batch.scope, participantIds: sortedUnique(batch.scope.participantIds) },
    memories: batch.memories.map((memory) => ({
      id: memory.id,
      sourceEventIds: sortedUnique(memory.sourceEventIds),
      perspective: memory.perspective,
      salience: memory.salience,
      confidence: memory.confidence,
      tier: memory.tier,
      occurredAt: memory.event.occurredAt,
      pinned: memory.pinned,
    })),
  });
  return createHash("sha256").update(canonical).digest("hex");
};

const consolidationId = (batchId: string, sourceMemoryIds: readonly string[]): string =>
  `social_consolidation_${createHash("sha256")
    .update(`${batchId}:${sortedUnique(sourceMemoryIds).join(":")}`)
    .digest("hex")
    .slice(0, 24)}`;

const modelInputFor = (batch: ConsolidationBatch): NormalizedSocialMemoryConsolidationInput | undefined => {
  const fingerprint = batchFingerprint(batch);
  const parsed = socialMemoryConsolidationInputSchema.safeParse({
    batchId: `memory_batch_${fingerprint.slice(0, 24)}`,
    candidates: batch.memories.map((memory) => ({
      id: memory.id,
      ownerId: memory.ownerId,
      subjectIds: memory.subjectIds,
      scope: memory.event.scope,
      sourceEventIds: memory.sourceEventIds,
      perspective: memory.perspective,
      confidence: memory.confidence,
      salience: memory.salience,
      tier: memory.tier,
      occurredAt: memory.event.occurredAt,
      pinned: memory.pinned,
    })),
  });
  return parsed.success ? parsed.data : undefined;
};

/**
 * Runs deterministic pruning regardless of model availability and, when one
 * exact privacy bucket has enough active memories, asks the multilingual model
 * only which existing source-bound wording may safely subsume duplicates.
 * Generated prose never enters durable memory through this path.
 */
export class SocialMemoryLifecycleManager {
  readonly #model: ConsolidationModel;
  readonly #store: SocialMemoryStore;
  readonly #intervalMs: number;
  readonly #changeDelayMs: number;
  readonly #minimumConsolidationCandidates: number;
  readonly #now: () => number;
  readonly #onError?: SocialMemoryLifecycleOptions["onError"];
  readonly #onStateChanged?: SocialMemoryLifecycleOptions["onStateChanged"];
  readonly #deferredBatches = new Map<string, number>();
  #tail: Promise<void> = Promise.resolve();
  #scheduled?: ReturnType<typeof setTimeout>;
  #interval?: ReturnType<typeof setInterval>;
  #accepting = true;

  constructor(model: ConsolidationModel, store: SocialMemoryStore, options: SocialMemoryLifecycleOptions = {}) {
    this.#model = model;
    this.#store = store;
    this.#intervalMs = boundedDuration(options.intervalMs, DEFAULT_INTERVAL_MS, 60_000, 24 * 60 * 60_000);
    this.#changeDelayMs = boundedDuration(options.changeDelayMs, DEFAULT_CHANGE_DELAY_MS, 0, 60_000);
    this.#minimumConsolidationCandidates = boundedDuration(
      options.minimumConsolidationCandidates,
      DEFAULT_MIN_CONSOLIDATION_CANDIDATES,
      2,
      MAX_CONSOLIDATION_CANDIDATES,
    );
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError;
    this.#onStateChanged = options.onStateChanged;
  }

  start(): void {
    if (!this.#accepting || this.#interval) return;
    this.schedule(0);
    this.#interval = setInterval(() => this.schedule(0), this.#intervalMs);
    this.#interval.unref?.();
  }

  notifyMemoryChanged(): void {
    this.schedule(this.#changeDelayMs);
  }

  schedule(delayMs = 0): void {
    if (!this.#accepting || this.#scheduled) return;
    this.#scheduled = setTimeout(() => {
      this.#scheduled = undefined;
      void this.runNow().catch(() => undefined);
    }, Math.max(0, delayMs));
    this.#scheduled.unref?.();
  }

  runNow(): Promise<SocialMemoryLifecycleRunResult> {
    if (!this.#accepting) return Promise.reject(new Error("social-memory lifecycle is closed"));
    let resolveResult!: (value: SocialMemoryLifecycleRunResult) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<SocialMemoryLifecycleRunResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const run = async () => {
      try {
        resolveResult(await this.#performRun());
      } catch (error) {
        try {
          this.#onError?.(error);
        } catch {
          // Diagnostics must never break the lifecycle queue.
        }
        rejectResult(error);
      }
    };
    this.#tail = this.#tail.then(run, run);
    return result;
  }

  async drain(): Promise<void> {
    while (true) {
      const observed = this.#tail;
      await observed;
      if (observed === this.#tail) return;
    }
  }

  async close(): Promise<void> {
    this.#accepting = false;
    if (this.#scheduled) clearTimeout(this.#scheduled);
    if (this.#interval) clearInterval(this.#interval);
    this.#scheduled = undefined;
    this.#interval = undefined;
    await this.drain();
  }

  async #performRun(): Promise<SocialMemoryLifecycleRunResult> {
    const runAt = this.#now();
    // Enforce deterministic bounds before enumerating work. This guarantees
    // the complete eligible-bucket list is itself bounded even after a long
    // pause or an older database migration.
    const maintenance = this.#store.runLifecycleMaintenance({ now: runAt });
    let batch: ConsolidationBatch | undefined;
    let input: NormalizedSocialMemoryConsolidationInput | undefined;
    let skippedFailureReason: string | undefined;
    const batches = this.#store.listConsolidationBatches({
      limit: MAX_CONSOLIDATION_CANDIDATES,
      minimum: this.#minimumConsolidationCandidates,
    });
    const persistedCursor = this.#store.getConsolidationCursor();
    const cursorIndex = persistedCursor === undefined
      ? -1
      : batches.findIndex((candidate) => candidate.bucketId === persistedCursor);
    const orderedBatches = cursorIndex < 0
      ? batches
      : [...batches.slice(cursorIndex + 1), ...batches.slice(0, cursorIndex + 1)];
    // A valid no-op, transient failure, or malformed legacy bucket must not
    // become a head-of-line lock for any other resident/scope. The durable
    // bucket cursor continues fairly after restart, while each bucket's own
    // bounded window advances so memories beyond the first twelve are seen.
    for (const candidate of orderedBatches) {
      const candidateInput = modelInputFor(candidate);
      if (!candidateInput) {
        skippedFailureReason ??= "invalid_consolidation_batch";
        continue;
      }
      const deferredUntil = this.#deferredBatches.get(candidateInput.batchId);
      if (deferredUntil !== undefined && deferredUntil > runAt) {
        skippedFailureReason ??= "consolidation_batch_cooling_down";
        continue;
      }
      batch = candidate;
      input = candidateInput;
      break;
    }
    let proposedActions = 0;
    let appliedConsolidations = 0;
    let failureReason: string | undefined = input ? undefined : skippedFailureReason;

    if (batch && input) {
      this.#store.setConsolidationCursor(batch.bucketId, runAt);
      this.#store.advanceConsolidationWindow(batch, runAt);
      let analysisFailure = false;
      try {
        const analysis = await this.#model.consolidateSocialMemories(input);
        proposedActions = analysis.actions.length;
        failureReason = analysis.failureReason ?? undefined;
        analysisFailure = analysis.failureReason !== null;
        if (analysis.source === "lm" && analysis.failureReason === null) {
          for (const action of analysis.actions) {
            const applied = this.#store.applyMemoryConsolidation({
              id: consolidationId(input.batchId, action.sourceMemoryIds),
              ownerId: batch.ownerId,
              subjectIds: batch.subjectIds,
              scope: batch.scope,
              sourceMemoryIds: action.sourceMemoryIds,
              perspective: action.perspective,
              salience: action.salience,
              confidence: action.confidence,
              at: runAt,
            });
            if (applied.created) appliedConsolidations += 1;
          }
        }
      } catch (error) {
        analysisFailure = true;
        failureReason = error instanceof Error ? error.message : "consolidation_model_failed";
      }
      if (appliedConsolidations === 0) {
        this.#deferredBatches.delete(input.batchId);
        this.#deferredBatches.set(
          input.batchId,
          runAt + (analysisFailure ? FAILED_BATCH_RETRY_MS : NO_ACTION_BATCH_RETRY_MS),
        );
        while (this.#deferredBatches.size > MAX_DEFERRED_BATCHES) {
          const oldest = this.#deferredBatches.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.#deferredBatches.delete(oldest);
        }
      } else {
        this.#deferredBatches.delete(input.batchId);
      }
    }

    if (
      appliedConsolidations > 0 ||
      maintenance.expiredMemories > 0 ||
      maintenance.deletedMemories > 0 ||
      maintenance.dismissedOpenLoopOverflow > 0 ||
      maintenance.prunedRelationshipCheckpoints > 0
    ) {
      try {
        this.#onStateChanged?.();
      } catch {
        // Cache invalidation/diagnostics cannot roll back durable maintenance.
      }
    }
    return {
      ...(input ? { batchId: input.batchId } : {}),
      consideredMemories: input?.candidates.length ?? 0,
      proposedActions,
      appliedConsolidations,
      maintenance,
      ...(failureReason ? { failureReason } : {}),
    };
  }
}
