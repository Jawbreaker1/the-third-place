import type { ServerHealth } from "../shared/types.js";
import { DEFAULT_RUNTIME_BEHAVIOR_TUNING, scaleAmbientDelay } from "./behaviorTuning.js";

export type AmbientPace = "calm" | "lively" | "party";
export type AmbientCapacitySnapshot = Pick<ServerHealth["model"],
  | "connected"
  | "queueDepth"
  | "activePredictions"
  | "activeBackgroundPredictions"
  | "maxConcurrentPredictions"
  | "maxBackgroundPredictions"
  | "effectiveMaxBackgroundPredictions"
  | "foregroundDemandCount"
>;

export interface AmbientSchedulingDecision {
  allowed: boolean;
  reason: "off" | "offline" | "worker-limit" | "legacy-busy" | "queued"
    | "prediction-full" | "background-full" | "available";
  /** Next opportunity, not a promise that a resident will speak. */
  delayMs: number;
  /** Configured workers bounded by the model scheduler's current background reservation. */
  workerLimit: number;
}

const PACE_RANGES: Record<AmbientPace, readonly [number, number]> = {
  calm: [5_000, 10_000],
  lively: [2_000, 5_000],
  party: [1_000, 3_000],
};

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Language/content-blind pacing against our scheduler's observable demand.
 * Human presence is deliberately not an input: an empty community still lives.
 * Queue counters are not GPU utilization, and this policy does not infer it
 * from model health pings or replace the LM queue's final atomic admission.
 */
export function ambientSchedulingPolicy(input: {
  health: AmbientCapacitySnapshot;
  pace?: AmbientPace;
  activity: number;
  configuredWorkers: number;
  workerId: number;
  random: number;
  ownedAmbientGenerations?: number;
}): AmbientSchedulingDecision {
  const { health } = input;
  const activity = finite(input.activity)
    ? Math.round(Math.max(0, Math.min(100, input.activity)))
    : DEFAULT_RUNTIME_BEHAVIOR_TUNING.activity;
  const configuredWorkers = finite(input.configuredWorkers)
    ? Math.max(0, Math.min(8, Math.trunc(input.configuredWorkers)))
    : 1;
  const completeCapacity = [
    health.activePredictions,
    health.activeBackgroundPredictions,
    health.maxConcurrentPredictions,
    health.maxBackgroundPredictions,
  ].every(finite);
  const active = completeCapacity ? Math.max(0, Math.trunc(health.activePredictions!)) : 0;
  const background = completeCapacity ? Math.max(0, Math.trunc(health.activeBackgroundPredictions!)) : 0;
  const maximum = completeCapacity ? Math.max(0, Math.trunc(health.maxConcurrentPredictions!)) : 0;
  const backgroundMaximum = completeCapacity
    ? Math.max(0, Math.trunc(Math.min(
      health.maxBackgroundPredictions!,
      finite(health.effectiveMaxBackgroundPredictions)
        ? health.effectiveMaxBackgroundPredictions
        : health.maxBackgroundPredictions!,
    )))
    : 0;
  const workerLimit = activity === 0 ? 0 : completeCapacity
    ? Math.min(configuredWorkers, maximum, backgroundMaximum)
    : configuredWorkers;
  const queue = finite(health.queueDepth) ? Math.max(0, Math.trunc(health.queueDepth)) : Infinity;
  const owned = finite(input.ownedAmbientGenerations)
    ? Math.max(0, Math.trunc(input.ownedAmbientGenerations))
    : 0;

  let reason: AmbientSchedulingDecision["reason"] = "available";
  if (activity === 0) reason = "off";
  else if (!health.connected) reason = "offline";
  else if (!Number.isInteger(input.workerId) || input.workerId < 0 || input.workerId >= workerLimit) {
    reason = "worker-limit";
  } else if (!completeCapacity && queue > owned) reason = "legacy-busy";
  else if (completeCapacity && queue > active) reason = "queued";
  else if (completeCapacity && active >= maximum) reason = "prediction-full";
  else if (completeCapacity && background >= backgroundMaximum) reason = "background-full";

  const foregroundDemand = finite(health.foregroundDemandCount) && health.foregroundDemandCount > 0;
  const blockedByCapacity = reason !== "available" && reason !== "worker-limit" && reason !== "off";
  // Spare slots are useful even while other requests are running. Only real
  // foreground demand adds a courtesy pause; full capacity is retried below.
  const loadFactor = foregroundDemand ? 2 : 1;
  const [minimum, maximumDelay] = PACE_RANGES[input.pace ?? "lively"];
  const random = finite(input.random) ? Math.max(0, Math.min(1, input.random)) : 0.5;
  const pacedDelayMs = scaleAmbientDelay(
    (minimum + random * (maximumDelay - minimum)) * loadFactor,
    activity,
  );
  // Avoid a hot polling loop at a full/disconnected provider, including at
  // maximum activity. This floor does not delay work when a slot is free.
  const delayMs = blockedByCapacity
    ? Math.max(pacedDelayMs, 4_000 + random * 4_000)
    : pacedDelayMs;
  return { allowed: reason === "available", reason, delayMs, workerLimit };
}

/** Room-level breathing space, separate from the capacity-aware worker tick. */
export function ambientConversationTimingPolicy(input: {
  activity: number;
  random: number;
}): { activeConversationDelayMs: number; closedConversationCooldownMs: number } {
  const random = finite(input.random) ? Math.max(0, Math.min(1, input.random)) : 0.5;
  return {
    activeConversationDelayMs: scaleAmbientDelay(3_000 + random * 5_000, input.activity),
    closedConversationCooldownMs: scaleAmbientDelay(45_000 + random * 45_000, input.activity),
  };
}
