import type { AdminBehaviorTuning } from "../shared/adminTypes.js";

/**
 * Called without a channel for the global tuning and with a channel for a
 * complete room override. Returning undefined from the room call inherits the
 * global tuning. Providers own storage, authorization and revision handling.
 */
export type BehaviorTuningProvider = (channelId?: string) => AdminBehaviorTuning | undefined;

export const DEFAULT_RUNTIME_BEHAVIOR_TUNING: AdminBehaviorTuning = {
  activity: 50,
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

export const ambientRoomSelectionWeight = (score: number, activity: number): number => {
  const level = percent(activity, DEFAULT_RUNTIME_BEHAVIOR_TUNING.activity);
  if (level === 0) return Number.NEGATIVE_INFINITY;
  // Fifty is deliberately neutral. Low-but-nonzero rooms remain possible;
  // high-activity rooms are preferred without becoming a permanent monopoly.
  return score * (0.25 + level * 0.015);
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
  balanced: "Allow direct pushback, dry friction and clear disagreement when socially relevant.",
  high: "Allow blunt, combative disagreement aimed at claims, choices or behavior when it fits the actor and room.",
  maximum: "Allow very forceful, terse confrontation of a claim or behavior, but never turn intensity into abuse or a pile-on.",
};

const explicitnessDirection: Record<BehaviorBand, string> = {
  minimum: "Avoid adding adult profanity; still understand and answer coarse human language directly without moralizing about vocabulary.",
  low: "Usually avoid adult profanity, except a proportionate natural reaction may be retained when removing it would distort the exchange.",
  balanced: "Adult profanity is optional when proportionate to the room, actor and turn; it is never a required style marker.",
  high: "Permit proportionate adult profanity more freely when it sounds natural, but never insert it merely to demonstrate this setting.",
  maximum: "Permit strong proportionate adult profanity when the specific exchange earns it; never force it or make it a recurring verbal tic.",
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
- These settings never override evidence grounding, safety or moderation, the actor's persona and assigned expertise, the room contract, the required language, or hard message limits. Aggression never permits harassment, threats, protected-class slurs, dehumanization, sexualized abuse or coordinated pile-ons. Explicitness never forces profanity and never permits those excluded forms.`;
};
