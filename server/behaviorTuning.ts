import type { AdminBehaviorTuning } from "../shared/adminTypes.js";

/**
 * Called without a channel for the global tuning and with a channel for a
 * complete room override. Returning undefined from the room call inherits the
 * global tuning. Providers own storage, authorization and revision handling.
 */
export type BehaviorTuningProvider = (channelId?: string) => AdminBehaviorTuning | undefined;

export const DEFAULT_RUNTIME_BEHAVIOR_TUNING: AdminBehaviorTuning = {
  activity: 50,
  autonomousLinkFrequency: 60,
  competence: 50,
  aggression: 25,
  explicitness: 50,
};

const percent = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.max(0, Math.min(100, value)))
    : fallback;

export const normalizeBehaviorTuning = (
  value: AdminBehaviorTuning | undefined,
  fallback: AdminBehaviorTuning = DEFAULT_RUNTIME_BEHAVIOR_TUNING,
): AdminBehaviorTuning => ({
  activity: percent(value?.activity, fallback.activity),
  autonomousLinkFrequency: percent(value?.autonomousLinkFrequency, fallback.autonomousLinkFrequency),
  competence: percent(value?.competence, fallback.competence),
  aggression: percent(value?.aggression, fallback.aggression),
  explicitness: percent(value?.explicitness, fallback.explicitness),
});

export const readBehaviorTuning = (
  provider: BehaviorTuningProvider | undefined,
  channelId?: string,
  fallback: AdminBehaviorTuning = DEFAULT_RUNTIME_BEHAVIOR_TUNING,
): AdminBehaviorTuning => {
  if (!provider) return normalizeBehaviorTuning(undefined, fallback);
  try {
    return normalizeBehaviorTuning(provider(channelId), fallback);
  } catch (error) {
    console.warn("Behavior tuning provider failed safely:", error instanceof Error ? error.message : error);
    return normalizeBehaviorTuning(undefined, fallback);
  }
};

export interface ResolvedBehaviorTuning {
  global: AdminBehaviorTuning;
  effective: AdminBehaviorTuning;
}

export const resolveBehaviorTuning = (
  provider: BehaviorTuningProvider | undefined,
  channelId?: string,
  knownGlobal?: AdminBehaviorTuning,
): ResolvedBehaviorTuning => {
  const global = knownGlobal
    ? normalizeBehaviorTuning(knownGlobal)
    : readBehaviorTuning(provider);
  return {
    global,
    effective: channelId ? readBehaviorTuning(provider, channelId, global) : global,
  };
};

export const autonomousActivityLimits = (
  basePerMinute: number,
  activity: number,
): { perMinute: number; perTwelveSeconds: number } => {
  const level = percent(activity, DEFAULT_RUNTIME_BEHAVIOR_TUNING.activity);
  if (level === 0) return { perMinute: 0, perTwelveSeconds: 0 };
  const scale = level / 50;
  return {
    perMinute: Math.max(1, Math.min(20, Math.round(basePerMinute * scale))),
    perTwelveSeconds: Math.max(1, Math.min(5, Math.round(3 * scale))),
  };
};

export const scaleAmbientDelay = (delayMs: number, activity: number): number => {
  const level = percent(activity, DEFAULT_RUNTIME_BEHAVIOR_TUNING.activity);
  const factor = level === 0 ? 3 : Math.max(0.6, Math.min(2.9, 75 / (level + 25)));
  return Math.max(1_000, Math.round(delayMs * factor));
};

export interface UnattendedAmbientPolicy {
  enabled: boolean;
  /** Minimum distance between successful autonomous publications, across the server. */
  minimumGapMs: number;
  /** Minimum distance between unattended work attempts, including rejected generations. */
  attemptCooldownMs: number;
  hourlyCap: number;
  dailyCap: number;
}

const interpolateAnchored = (
  level: number,
  low: number,
  middle: number,
  high: number,
): number => level <= 50
  ? interpolate(low, middle, (level - 1) / 49)
  : interpolate(middle, high, (level - 50) / 50);

/**
 * Maps the existing Activity control onto a deliberately slower, server-wide
 * zero-human budget. It is content- and language-blind: the ambient planner
 * still decides what happens, while this policy only bounds unattended cost
 * and publication volume.
 */
export const unattendedAmbientPolicy = (activity: number): UnattendedAmbientPolicy => {
  const level = percent(activity, DEFAULT_RUNTIME_BEHAVIOR_TUNING.activity);
  if (level === 0) {
    return {
      enabled: false,
      minimumGapMs: 20 * 60_000,
      attemptCooldownMs: 10 * 60_000,
      hourlyCap: 0,
      dailyCap: 0,
    };
  }
  const minimumGapMs = Math.round(interpolateAnchored(level, 20, 6, 3) * 60_000);
  const hourlyCap = Math.max(1, Math.round(interpolateAnchored(level, 1, 3, 6)));
  return {
    enabled: true,
    minimumGapMs,
    attemptCooldownMs: Math.max(minimumGapMs, Math.round(60 * 60_000 / (hourlyCap * 2))),
    hourlyCap,
    // Match the sustained hourly rate so a healthy 24/7 room never spends the
    // final hours of a day behind a prematurely exhausted daily bucket.
    dailyCap: hourlyCap * 24,
  };
};

export interface UnattendedAmbientCapacityGate {
  now: number;
  policy: UnattendedAmbientPolicy;
  /** Latest successful autonomous text publication, attended or unattended. */
  lastAutonomousPublicationAt?: number;
  /** Successful unattended publication timestamps retained by the room store. */
  unattendedPublicationTimestamps: readonly number[];
}

/** Pure rolling-window gate used both before work and immediately before commit. */
export const hasUnattendedAmbientCapacity = (gate: UnattendedAmbientCapacityGate): boolean => {
  if (!gate.policy.enabled) return false;
  if (
    gate.lastAutonomousPublicationAt !== undefined &&
    gate.now - gate.lastAutonomousPublicationAt < gate.policy.minimumGapMs
  ) return false;
  const inDay = gate.unattendedPublicationTimestamps.filter(
    (timestamp) => timestamp <= gate.now && gate.now - timestamp < 24 * 60 * 60_000,
  );
  if (inDay.length >= gate.policy.dailyCap) return false;
  return inDay.filter((timestamp) => gate.now - timestamp < 60 * 60_000).length < gate.policy.hourlyCap;
};

export const ambientRoomSelectionWeight = (score: number, activity: number): number => {
  const level = percent(activity, DEFAULT_RUNTIME_BEHAVIOR_TUNING.activity);
  if (level === 0) return Number.NEGATIVE_INFINITY;
  // Fifty is deliberately neutral. Low-but-nonzero rooms remain possible;
  // high-activity rooms are preferred without becoming a permanent monopoly.
  return score * (0.25 + level * 0.015);
};

const MAX_AMBIENT_DEBATE_CHANCE = 0.70;

/**
 * Calibrates how often a newly seeded ambient thread gets a genuine
 * counter-position. Aggression 25 is the historical neutral point, so existing
 * room profiles keep their exact cadence at the default setting. Lower values
 * retain some calm disagreement; higher values add at most 35 percentage
 * points and remain hard-capped to avoid turning a lively room into a pile-on.
 *
 * This is deliberately language- and content-blind. It only schedules a
 * disagreement beat; the existing semantic generation and review contracts
 * still own wording, targets and safety.
 */
export const ambientDebateChance = (baseChance: number, aggression: number): number => {
  const baseline = typeof baseChance === "number" && Number.isFinite(baseChance)
    ? Math.max(0, Math.min(MAX_AMBIENT_DEBATE_CHANCE, baseChance))
    : 0;
  const level = percent(aggression, DEFAULT_RUNTIME_BEHAVIOR_TUNING.aggression);

  if (level <= DEFAULT_RUNTIME_BEHAVIOR_TUNING.aggression) {
    const position = level / DEFAULT_RUNTIME_BEHAVIOR_TUNING.aggression;
    return baseline * interpolate(0.5, 1, position);
  }

  const position = (level - DEFAULT_RUNTIME_BEHAVIOR_TUNING.aggression)
    / (100 - DEFAULT_RUNTIME_BEHAVIOR_TUNING.aggression);
  return Math.min(MAX_AMBIENT_DEBATE_CHANCE, baseline + 0.35 * position);
};

export interface AutonomousLinkPolicy {
  enabled: boolean;
  chance: number;
  globalCooldownMs: number;
  channelCooldownMs: number;
  humanQuietMs: number;
  dailyCap: number;
}

const interpolate = (minimum: number, maximum: number, position: number): number =>
  minimum + (maximum - minimum) * position;

/**
 * Maps the admin's simple 0–100 control onto bounded transport policy. The
 * scheduler remains topic- and language-blind: source subjects still come
 * exclusively from trusted room profiles, while these limits only decide how
 * often an eligible sourced thread may begin.
 */
export const autonomousLinkPolicy = (frequency: number): AutonomousLinkPolicy => {
  const level = percent(frequency, DEFAULT_RUNTIME_BEHAVIOR_TUNING.autonomousLinkFrequency);
  if (level === 0) {
    return {
      enabled: false,
      chance: 0,
      globalCooldownMs: 40 * 60_000,
      channelCooldownMs: 3 * 60 * 60_000,
      humanQuietMs: 3 * 60_000,
      dailyCap: 0,
    };
  }
  const anchors = level <= 50
    ? {
        position: (level - 1) / 49,
        from: { globalMinutes: 360, channelMinutes: 720, quietSeconds: 300 },
        to: { globalMinutes: 90, channelMinutes: 180, quietSeconds: 120 },
      }
    : level <= 60
      ? {
          position: (level - 50) / 10,
          from: { globalMinutes: 90, channelMinutes: 180, quietSeconds: 120 },
          to: { globalMinutes: 60, channelMinutes: 120, quietSeconds: 90 },
        }
      : {
          position: (level - 60) / 40,
          from: { globalMinutes: 60, channelMinutes: 120, quietSeconds: 90 },
          to: { globalMinutes: 12, channelMinutes: 40, quietSeconds: 40 },
        };
  const globalMinutes = interpolate(
    anchors.from.globalMinutes,
    anchors.to.globalMinutes,
    anchors.position,
  );
  const globalCooldownMs = Math.round(globalMinutes * 60_000);
  return {
    enabled: true,
    // Cadence, rather than a Bernoulli lottery, owns frequency. This makes the
    // rolling cap refill at the same rate instead of producing bursts followed
    // by a long quota cliff.
    chance: 1,
    globalCooldownMs,
    channelCooldownMs: Math.round(interpolate(
      anchors.from.channelMinutes,
      anchors.to.channelMinutes,
      anchors.position,
    ) * 60_000),
    humanQuietMs: Math.round(interpolate(
      anchors.from.quietSeconds,
      anchors.to.quietSeconds,
      anchors.position,
    ) * 1_000),
    dailyCap: Math.ceil(24 * 60 * 60_000 / globalCooldownMs),
  };
};

type BehaviorBand = "minimum" | "low" | "balanced" | "high" | "maximum";

const band = (value: number): BehaviorBand =>
  value <= 10 ? "minimum" : value <= 35 ? "low" : value <= 65 ? "balanced" : value <= 90 ? "high" : "maximum";

const competenceDirection: Record<BehaviorBand, string> = {
  minimum: "Stay openly tentative outside obvious basics; prefer a sincere question, narrow observation or uncertainty over bluffing.",
  low: "Use modest domain confidence and limited depth; make one grounded point and acknowledge uncertainty naturally.",
  balanced: "Use ordinary informed-peer confidence and enough concrete depth to be useful without turning the message into a lecture.",
  high: "Use strong domain confidence and specific mechanisms or trade-offs where the actor's assigned expertise supports them.",
  maximum: "Use the deepest concise domain reasoning the actor's assigned expertise and supplied evidence support; remain fallible and chat-sized.",
};

const aggressionDirection: Record<BehaviorBand, string> = {
  minimum: "Prefer calm disagreement and soft edges, while still answering a conflict directly instead of reflexively agreeing.",
  low: "Disagree plainly but gently when there is a real point of friction.",
  balanced: "Use direct pushback, dry friction and clear disagreement when socially relevant.",
  high: "The server may assign one actor a blunt disagreement target aimed at a claim, taste, choice or behavior; realize it without manufacturing personal hostility.",
  maximum: "The server assigns one actor a very forceful, terse stance target whenever that actor has a real disagreement, ranking, complaint or boundary; make it unmistakable without turning intensity into abuse or a pile-on.",
};

const explicitnessDirection: Record<BehaviorBand, string> = {
  minimum: "Avoid adding adult profanity; still understand and answer coarse human language directly without moralizing about vocabulary.",
  low: "Usually avoid adult profanity, except a proportionate natural reaction may be retained when removing it would distort the exchange.",
  balanced: "Adult profanity is optional when proportionate to the room, actor and turn; it is never a required style marker.",
  high: "The server may assign at most one actor a bounded coarse-language target; realize it naturally when the message can bear it, never as targeted abuse.",
  maximum: "The server assigns at most one actor a strong-language target per scene. Make one natural non-targeted adult expression audible in that actor's line unless it would distort a direct factual answer or calm serious boundary.",
};

export const behaviorTuningPrompt = (value: AdminBehaviorTuning): string => {
  const tuning = normalizeBehaviorTuning(value);
  const competence = band(tuning.competence);
  const aggression = band(tuning.aggression);
  const explicitness = band(tuning.explicitness);
  return `
Trusted live behavior tuning (server-authored style calibration):
- Competence ${tuning.competence}/100 (${competence}): ${competenceDirection[competence]}
- Aggression ${tuning.aggression}/100 (${aggression}): ${aggressionDirection[aggression]}
- Explicitness ${tuning.explicitness}/100 (${explicitness}): ${explicitnessDirection[explicitness]}
- Apply these as semantic depth and intensity in whatever response language is already required; never turn a level into language-specific canned wording.
- These settings never override evidence grounding, safety or moderation, the actor's persona and assigned expertise, the room contract, the required language, or hard message limits. Aggression never permits harassment, threats, protected-class slurs, dehumanization, sexualized abuse or coordinated pile-ons. An explicitness target is bounded to one actor, never requires targeted abuse or every actor to swear, and never permits those excluded forms.`;
};
