import { describe, expect, it } from "vitest";
import type { RelationshipEdge } from "./socialMemory.js";
import {
  RELATIONSHIP_DECISION_BIAS_LIMITS,
  projectRelationshipBehavior,
} from "./relationshipBehavior.js";

const edge = (overrides: Partial<RelationshipEdge> = {}): RelationshipEdge => ({
  ownerId: "ai-mira",
  subjectId: "human-johan",
  familiarity: 0,
  warmth: 0,
  trust: 0,
  respect: 0,
  friction: 0,
  romanticInterest: 0,
  romanticBoundaryClosed: false,
  romanticBoundaryBlockerIds: [],
  updatedAt: 1_800_000_000_000,
  ...overrides,
});

describe("relationship behavior projection", () => {
  it("returns a coarse neutral projection for an absent relationship", () => {
    expect(projectRelationshipBehavior(undefined)).toEqual({
      bands: {
        familiarity: "new",
        warmth: "neutral",
        trust: "neutral",
        respect: "neutral",
        friction: "low",
        romanticInterest: "none",
      },
      romanticBoundary: { state: "unspecified", blockerActorIds: [] },
      decisionBiases: {
        ordinaryPublicReply: 0,
        conflictChallengeReply: 0,
        welcome: 0,
        ambientContinuation: 0,
        voiceTieBreak: 0,
      },
      promptCue: { rapport: "new", stance: "neutral", friction: "low" },
    });
  });

  it("keeps every decision nudge inside its exported limit", () => {
    const extremes = [
      edge({ familiarity: 1, warmth: 1, trust: 1, respect: 1 }),
      edge({ warmth: -1, trust: -1, respect: -1, friction: 1 }),
    ];
    for (const candidate of extremes) {
      const biases = projectRelationshipBehavior(candidate).decisionBiases;
      for (const key of Object.keys(RELATIONSHIP_DECISION_BIAS_LIMITS) as Array<
        keyof typeof RELATIONSHIP_DECISION_BIAS_LIMITS
      >) {
        expect(Math.abs(biases[key])).toBeLessThanOrEqual(RELATIONSHIP_DECISION_BIAS_LIMITS[key]);
      }
    }
  });

  it("represents mixed warmth and friction without collapsing either axis", () => {
    const projection = projectRelationshipBehavior(edge({
      familiarity: 0.65,
      warmth: 0.8,
      trust: 0.55,
      respect: 0.7,
      friction: 0.72,
    }));

    expect(projection.bands).toMatchObject({
      familiarity: "familiar",
      warmth: "positive",
      trust: "positive",
      respect: "positive",
      friction: "high",
    });
    expect(projection.promptCue.stance).toBe("warm_but_tense");
    expect(projection.decisionBiases.conflictChallengeReply).toBeGreaterThan(0);
    expect(projection.decisionBiases.ordinaryPublicReply)
      .toBeLessThan(projectRelationshipBehavior(edge({
        familiarity: 0.65,
        warmth: 0.8,
        trust: 0.55,
        respect: 0.7,
        friction: 0,
      })).decisionBiases.ordinaryPublicReply);
  });

  it.each([
    {
      label: "familiarity",
      values: { familiarity: 0.8 },
      band: ["familiarity", "close"],
      positive: ["ordinaryPublicReply", "welcome", "ambientContinuation", "voiceTieBreak"],
    },
    {
      label: "warmth",
      values: { warmth: 0.8 },
      band: ["warmth", "positive"],
      positive: ["ordinaryPublicReply", "welcome", "ambientContinuation", "voiceTieBreak"],
    },
    {
      label: "trust",
      values: { trust: 0.8 },
      band: ["trust", "positive"],
      positive: ["ordinaryPublicReply", "welcome", "ambientContinuation", "voiceTieBreak"],
    },
    {
      label: "respect",
      values: { respect: 0.8 },
      band: ["respect", "positive"],
      positive: ["ordinaryPublicReply", "conflictChallengeReply", "welcome", "ambientContinuation", "voiceTieBreak"],
    },
    {
      label: "friction",
      values: { friction: 0.8 },
      band: ["friction", "high"],
      positive: ["conflictChallengeReply"],
      negative: ["ordinaryPublicReply", "welcome", "ambientContinuation", "voiceTieBreak"],
    },
  ])("keeps the $label-only scenario causally narrow", ({ values, band, positive, negative = [] }) => {
    const projection = projectRelationshipBehavior(edge(values));
    expect(projection.bands[band[0] as keyof typeof projection.bands]).toBe(band[1]);
    for (const key of positive as Array<keyof typeof projection.decisionBiases>) {
      expect(projection.decisionBiases[key]).toBeGreaterThan(0);
    }
    for (const key of negative as Array<keyof typeof projection.decisionBiases>) {
      expect(projection.decisionBiases[key]).toBeLessThan(0);
    }
  });

  it("keeps romantic interest independent from ordinary selection biases", () => {
    const hidden = projectRelationshipBehavior(edge({ romanticInterest: 0.85 }));
    expect(hidden.bands.romanticInterest).toBe("established");
    expect(hidden.decisionBiases).toEqual({
      ordinaryPublicReply: 0,
      conflictChallengeReply: 0,
      welcome: 0,
      ambientContinuation: 0,
      voiceTieBreak: 0,
    });
    expect(hidden.promptCue).not.toHaveProperty("romanticInterest");

    const explicitlyAllowed = projectRelationshipBehavior(
      edge({ romanticInterest: 0.85 }),
      { allowRomanticSurface: true, romanticSceneEligibility: "eligible" },
    );
    expect(explicitlyAllowed.promptCue.romanticInterest).toBe("established");

    const eligibilityMissing = projectRelationshipBehavior(
      edge({ romanticInterest: 0.85 }),
      { allowRomanticSurface: true },
    );
    const eligibilityVetoed = projectRelationshipBehavior(
      edge({ romanticInterest: 0.85 }),
      { allowRomanticSurface: true, romanticSceneEligibility: "ineligible" },
    );
    expect(eligibilityMissing.promptCue).not.toHaveProperty("romanticInterest");
    expect(eligibilityVetoed.promptCue).not.toHaveProperty("romanticInterest");
  });

  it("treats a romantic boundary as a veto only, not consent or general hostility", () => {
    const closed = projectRelationshipBehavior(edge({
      romanticInterest: 1,
      romanticBoundaryClosed: true,
      romanticBoundaryBlockerIds: ["human-johan", "ai-mira", "human-johan"],
    }), { allowRomanticSurface: true, romanticSceneEligibility: "eligible" });

    expect(closed.romanticBoundary).toEqual({
      state: "closed",
      blockerActorIds: ["ai-mira", "human-johan"],
    });
    expect(closed.promptCue).not.toHaveProperty("romanticInterest");
    expect(closed.promptCue.romanticBoundary).toBe("closed");
    expect(JSON.stringify(closed.promptCue)).not.toContain("human-johan");
    expect(JSON.stringify(closed.promptCue)).not.toContain("ai-mira");
    expect(closed.decisionBiases).toEqual({
      ordinaryPublicReply: 0,
      conflictChallengeReply: 0,
      welcome: 0,
      ambientContinuation: 0,
      voiceTieBreak: 0,
    });

    const unspecified = projectRelationshipBehavior(edge({ romanticInterest: 1 }));
    expect(unspecified.romanticBoundary.state).toBe("unspecified");
    expect(unspecified.promptCue).not.toHaveProperty("romanticBoundary");
    expect(unspecified.promptCue).not.toHaveProperty("romanticInterest");
  });

  it("fails closed when boundary blockers and the stored boolean disagree", () => {
    const projection = projectRelationshipBehavior(edge({
      romanticInterest: 0.9,
      romanticBoundaryClosed: false,
      romanticBoundaryBlockerIds: ["human-johan"],
    }), { allowRomanticSurface: true, romanticSceneEligibility: "eligible" });
    expect(projection.romanticBoundary.state).toBe("closed");
    expect(projection.promptCue.romanticBoundary).toBe("closed");
    expect(projection.promptCue).not.toHaveProperty("romanticInterest");
  });

  it("contains only coarse strings in the prompt cue", () => {
    const cue = projectRelationshipBehavior(edge({
      familiarity: 0.67891,
      warmth: 0.45678,
      trust: -0.45678,
      respect: 0.87654,
      friction: 0.34567,
      romanticInterest: 0.71234,
    }), { allowRomanticSurface: true, romanticSceneEligibility: "eligible" }).promptCue;
    expect(JSON.stringify(cue)).not.toMatch(/\d/u);
    expect(Object.values(cue).every((value) => typeof value === "string")).toBe(true);
  });
});
