import type { RelationshipEdge } from "./socialMemory.js";

export type FamiliarityBand = "new" | "known" | "familiar" | "close";
export type SignedRelationshipBand = "negative" | "neutral" | "positive";
export type FrictionBand = "low" | "present" | "high";
export type RomanticInterestBand = "none" | "emerging" | "established";
export type RomanticBoundaryBand = "unspecified" | "closed";
export type RelationshipStance =
  | "neutral"
  | "comfortable"
  | "warm"
  | "wary"
  | "strained"
  | "warm_but_tense";

/**
 * These are deliberately small additions to an existing director score.
 * Exact address, moderation, expertise, cooldown and the persona's stable
 * traits remain policies owned by the caller and must keep precedence.
 */
export const RELATIONSHIP_DECISION_BIAS_LIMITS = Object.freeze({
  ordinaryPublicReply: 0.1,
  conflictChallengeReply: 0.12,
  welcome: 0.1,
  ambientContinuation: 0.12,
  voiceTieBreak: 0.08,
});

export interface RelationshipDecisionBiases {
  ordinaryPublicReply: number;
  conflictChallengeReply: number;
  welcome: number;
  ambientContinuation: number;
  voiceTieBreak: number;
}

export interface RelationshipBehaviorBands {
  familiarity: FamiliarityBand;
  warmth: SignedRelationshipBand;
  trust: SignedRelationshipBand;
  respect: SignedRelationshipBand;
  friction: FrictionBand;
  romanticInterest: RomanticInterestBand;
}

/**
 * Prompt-safe, coarse orientation. It contains no relationship measurements,
 * participant labels or boundary-owner IDs. Romantic interest is absent unless
 * the caller explicitly authorizes that surface for this exact scene.
 */
export interface RelationshipPromptCue {
  rapport: FamiliarityBand;
  stance: RelationshipStance;
  friction: FrictionBand;
  /** Prompt-safe veto only. It contains neither the blocker nor internal IDs. */
  romanticBoundary?: "closed";
  romanticInterest?: Exclude<RomanticInterestBand, "none">;
}

export interface RelationshipBehaviorProjection {
  bands: RelationshipBehaviorBands;
  romanticBoundary: {
    /** Unspecified is an absence of a recorded veto, never affirmative consent. */
    state: RomanticBoundaryBand;
    /** Server-only structural IDs. These must never be copied into a model prompt. */
    blockerActorIds: string[];
  };
  decisionBiases: RelationshipDecisionBiases;
  promptCue: RelationshipPromptCue;
}

export interface RelationshipBehaviorProjectionOptions {
  /** Explicit scene-level permission; false by default and still subordinate to a recorded boundary. */
  allowRomanticSurface?: boolean;
  /**
   * Trusted endpoint eligibility for this exact scene. Missing is fail-closed
   * for romantic surface; ineligible additionally becomes a generation veto.
   */
  romanticSceneEligibility?: "eligible" | "ineligible";
}

const clamp = (value: number, minimum: number, maximum: number): number =>
  Math.min(maximum, Math.max(minimum, value));

const finite = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const unit = (value: number | undefined): number => clamp(finite(value), 0, 1);
const signedUnit = (value: number | undefined): number => clamp(finite(value), -1, 1);

const familiarityBand = (value: number): FamiliarityBand => {
  if (value < 0.12) return "new";
  if (value < 0.4) return "known";
  if (value < 0.72) return "familiar";
  return "close";
};

const signedBand = (value: number): SignedRelationshipBand => {
  if (value <= -0.35) return "negative";
  if (value >= 0.35) return "positive";
  return "neutral";
};

const frictionBand = (value: number): FrictionBand => {
  if (value < 0.2) return "low";
  if (value < 0.55) return "present";
  return "high";
};

const romanticInterestBand = (value: number): RomanticInterestBand => {
  if (value < 0.2) return "none";
  if (value < 0.6) return "emerging";
  return "established";
};

const stanceFor = (bands: RelationshipBehaviorBands): RelationshipStance => {
  if (bands.friction === "high") {
    return bands.warmth === "positive" ? "warm_but_tense" : "strained";
  }
  if (bands.friction === "present" && bands.warmth === "positive") return "warm_but_tense";
  if (bands.warmth === "negative" || bands.trust === "negative") return "wary";
  if (bands.warmth === "positive") return "warm";
  if (bands.trust === "positive" || bands.respect === "positive") return "comfortable";
  return "neutral";
};

const boundedBias = (value: number, maximum: number): number => {
  // Stable short decimals are useful for deterministic server scoring while
  // the prompt receives only the categorical projection above.
  const bounded = clamp(value, -maximum, maximum);
  return Math.round(bounded * 10_000) / 10_000;
};

const relationshipValues = (edge: RelationshipEdge | undefined) => ({
  familiarity: unit(edge?.familiarity),
  warmth: signedUnit(edge?.warmth),
  trust: signedUnit(edge?.trust),
  respect: signedUnit(edge?.respect),
  friction: unit(edge?.friction),
  romanticInterest: unit(edge?.romanticInterest),
});

const uniqueBlockerIds = (edge: RelationshipEdge | undefined): string[] =>
  [...new Set((edge?.romanticBoundaryBlockerIds ?? []).filter((id) => id.length > 0))].sort();

export function projectRelationshipBehavior(
  edge: RelationshipEdge | undefined,
  options: RelationshipBehaviorProjectionOptions = {},
): RelationshipBehaviorProjection {
  const values = relationshipValues(edge);
  const bands: RelationshipBehaviorBands = {
    familiarity: familiarityBand(values.familiarity),
    warmth: signedBand(values.warmth),
    trust: signedBand(values.trust),
    respect: signedBand(values.respect),
    friction: frictionBand(values.friction),
    romanticInterest: romanticInterestBand(values.romanticInterest),
  };
  const blockerActorIds = uniqueBlockerIds(edge);
  // Treat inconsistent persisted input fail-closed. The store normally keeps
  // the boolean and blockers aligned, but a pure boundary must be safe for
  // migrations and hand-constructed test data as well.
  const romanticBoundaryClosed = Boolean(edge?.romanticBoundaryClosed || blockerActorIds.length > 0);

  // Romance is intentionally absent from all ordinary social scores. Warmth,
  // tension and familiarity can affect interaction; attraction cannot silently
  // manufacture attention, intimacy or a DM-like beat.
  const ordinaryPublicReply =
    values.familiarity * 0.035 +
    values.warmth * 0.04 +
    values.trust * 0.02 +
    values.respect * 0.012 -
    values.friction * 0.055;
  const conflictChallengeReply =
    values.familiarity * 0.01 -
    values.warmth * 0.022 -
    values.trust * 0.005 +
    values.respect * 0.025 +
    values.friction * 0.09;
  const welcome =
    values.familiarity * 0.03 +
    values.warmth * 0.05 +
    values.trust * 0.025 +
    values.respect * 0.012 -
    values.friction * 0.06;
  // A little friction can sustain a real discussion, while severe friction
  // eventually reduces voluntary continuation. This keeps warm-but-tense
  // relationships distinct from both uncomplicated warmth and hostility.
  const ambientFriction = values.friction <= 0.55
    ? values.friction * 0.03
    : 0.0165 - (values.friction - 0.55) * 0.1;
  const ambientContinuation =
    values.familiarity * 0.035 +
    values.warmth * 0.035 +
    values.trust * 0.018 +
    values.respect * 0.018 +
    ambientFriction;
  const voiceTieBreak =
    values.familiarity * 0.025 +
    values.warmth * 0.03 +
    values.trust * 0.018 +
    values.respect * 0.007 -
    values.friction * 0.04;

  const promptCue: RelationshipPromptCue = {
    rapport: bands.familiarity,
    stance: stanceFor(bands),
    friction: bands.friction,
    ...(romanticBoundaryClosed ? { romanticBoundary: "closed" as const } : {}),
    ...(
      options.allowRomanticSurface === true &&
      options.romanticSceneEligibility === "eligible" &&
      !romanticBoundaryClosed &&
      bands.romanticInterest !== "none"
        ? { romanticInterest: bands.romanticInterest }
        : {}
    ),
  };

  return {
    bands,
    romanticBoundary: {
      state: romanticBoundaryClosed ? "closed" : "unspecified",
      blockerActorIds,
    },
    decisionBiases: {
      ordinaryPublicReply: boundedBias(
        ordinaryPublicReply,
        RELATIONSHIP_DECISION_BIAS_LIMITS.ordinaryPublicReply,
      ),
      conflictChallengeReply: boundedBias(
        conflictChallengeReply,
        RELATIONSHIP_DECISION_BIAS_LIMITS.conflictChallengeReply,
      ),
      welcome: boundedBias(welcome, RELATIONSHIP_DECISION_BIAS_LIMITS.welcome),
      ambientContinuation: boundedBias(
        ambientContinuation,
        RELATIONSHIP_DECISION_BIAS_LIMITS.ambientContinuation,
      ),
      voiceTieBreak: boundedBias(
        voiceTieBreak,
        RELATIONSHIP_DECISION_BIAS_LIMITS.voiceTieBreak,
      ),
    },
    promptCue,
  };
}
