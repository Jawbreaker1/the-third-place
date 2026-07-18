import type { RelationshipBehaviorProjection } from "./relationshipBehavior.js";

export type RelationshipBeatAudience = "resident-human" | "resident-resident";
export type RomanticSurfaceSemanticKind =
  | "romantic_disclosure"
  | "romantic_invitation"
  | "reciprocal_flirt"
  | "nonromantic_affection"
  | "irrelevant"
  | "boundary"
  | "unsafe"
  | "unclear";

export interface HumanRomanticTurnGate {
  /** True only for a successful, trusted current-turn semantic classification. */
  semanticTrusted: boolean;
  semanticKind: RomanticSurfaceSemanticKind;
  /** Exact mention, reply target or the sole resident in a DM. */
  addressedToResident: boolean;
  socialTrusted: boolean;
  hostility: number;
  urgency: number;
  interactionTrusted: boolean;
  interactionKind:
    | "ordinary"
    | "ambient_profanity"
    | "playful_banter"
    | "directed_insult"
    | "harassment"
    | "threat"
    | "hateful_or_dehumanizing_slur";
  moderationTrusted: boolean;
  moderationRisk: "none" | "uncertain" | "low" | "medium" | "high";
  moderationAction: "none" | "watch" | "deescalate" | "report" | "block";
  moderationCategories: readonly string[];
}

interface RareRomanticPromptCueGateCommon {
  /** Directed projection from the resident who may receive the prompt cue. */
  forward?: RelationshipBehaviorProjection;
  /** Trusted server clock in milliseconds. */
  now: number;
  /** Last time this exact rare surface was delivered for the pair/scope. */
  lastSurfaceAt?: number;
  cooldownMs: number;
  /** Finite probability; values outside [0, 1] are clamped to that interval. */
  chance: number;
  /** Injected unit-interval RNG keeps this policy deterministic in tests. */
  rng: () => number;
}

export type RareRomanticPromptCueGateInput = RareRomanticPromptCueGateCommon & (
  | {
      audience: "resident-human";
      /** Account-level adult opt-in is eligibility only, never consent. */
      accountEligible: boolean;
      /** Trusted server assertion that the exact fictional resident is an adult. */
      residentEligible: boolean;
      /** The exact current human turn must independently authorize the cue. */
      turn: HumanRomanticTurnGate;
    }
  | {
      audience: "resident-resident";
      ownerEligible: boolean;
      subjectEligible: boolean;
      /** Required reversed directed projection for the same resident pair. */
      reciprocal?: RelationshipBehaviorProjection;
    }
);

const establishedWithoutBoundary = (
  projection: RelationshipBehaviorProjection | undefined,
): boolean => projection?.bands?.romanticInterest === "established" &&
  projection?.romanticBoundary?.state === "unspecified";

const finiteUnitRoll = (rng: (() => number) | undefined): number | undefined => {
  if (typeof rng !== "function") return undefined;
  try {
    const roll = rng();
    return Number.isFinite(roll) && roll >= 0 && roll <= 1 ? roll : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The current turn is a veto gate, not a score. Missing/uncertain analysis,
 * ordinary warmth, boundaries, hostility, moderation and crisis all fail
 * closed. No chat text or language-specific logic enters this policy.
 */
export function isHumanRomanticTurnSuitable(turn: HumanRomanticTurnGate): boolean {
  const explicitlyRomantic = [
    "romantic_disclosure",
    "romantic_invitation",
    "reciprocal_flirt",
  ].includes(turn.semanticKind);
  if (
    turn.semanticTrusted !== true ||
    !explicitlyRomantic ||
    turn.addressedToResident !== true ||
    turn.socialTrusted !== true ||
    turn.interactionTrusted !== true ||
    turn.moderationTrusted !== true
  ) return false;
  if (!Number.isFinite(turn.hostility) || !Number.isFinite(turn.urgency)) return false;
  if (turn.hostility > 0.25 || turn.urgency > 0.65) return false;
  if (!["ordinary", "playful_banter"].includes(turn.interactionKind)) return false;
  if (turn.moderationRisk !== "none" || turn.moderationAction !== "none") return false;
  if (turn.moderationCategories.length > 0) return false;
  return true;
}

/**
 * Pure authorization for one rare romantic prompt cue. It never selects a
 * speaker, starts a DM, changes ordinary attention, generates content or
 * treats missing boundaries as affirmative consent.
 */
export function shouldSurfaceRareRomanticPromptCue(
  input: RareRomanticPromptCueGateInput,
): boolean {
  if (input.audience !== "resident-human" && input.audience !== "resident-resident") return false;
  if (
    input.audience === "resident-human" &&
    (
      input.accountEligible !== true ||
      input.residentEligible !== true ||
      !isHumanRomanticTurnSuitable(input.turn)
    )
  ) return false;
  if (!establishedWithoutBoundary(input.forward)) return false;
  if (
    input.audience === "resident-resident" &&
    (
      input.ownerEligible !== true ||
      input.subjectEligible !== true ||
      !establishedWithoutBoundary(input.reciprocal)
    )
  ) return false;

  if (!Number.isFinite(input.now)) return false;
  if (!Number.isFinite(input.cooldownMs) || input.cooldownMs < 0) return false;
  if (input.lastSurfaceAt !== undefined) {
    if (!Number.isFinite(input.lastSurfaceAt)) return false;
    if (input.now - input.lastSurfaceAt < input.cooldownMs) return false;
  }
  if (!Number.isFinite(input.chance)) return false;

  const roll = finiteUnitRoll(input.rng);
  if (roll === undefined) return false;
  const chance = Math.max(0, Math.min(1, input.chance));
  if (chance === 0) return false;
  if (chance === 1) return true;
  return roll < chance;
}
