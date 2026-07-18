import { describe, expect, it } from "vitest";
import {
  analyzeSocialSignals,
  humanRomanticTurnGate,
  selectAmbientLead,
  selectResponders,
} from "./director.js";
import { PERSONAS, type Persona } from "./personas.js";
import { projectRelationshipBehavior } from "./relationshipBehavior.js";
import type { RelationshipEdge } from "./socialMemory.js";
import { createFailClosedTurnAnalysis } from "./semanticRouter.js";

const persona = (id: string, name: string): Persona => ({
  ...PERSONAS.find((candidate) => candidate.id === "ai-mira")!,
  id,
  name,
  talkativeness: 0.3,
});

const relationship = (overrides: Partial<RelationshipEdge> = {}): RelationshipEdge => ({
  ownerId: "ai-a",
  subjectId: "human-one",
  familiarity: 0,
  warmth: 0,
  trust: 0,
  respect: 0,
  friction: 0,
  romanticInterest: 0,
  romanticBoundaryClosed: false,
  romanticBoundaryBlockerIds: [],
  updatedAt: Date.now(),
  ...overrides,
});

describe("relationship-aware director selection", () => {
  it("allows a bounded relationship nudge to choose between otherwise optional peers", () => {
    const a = persona("ai-a", "A");
    const b = persona("ai-b", "B");
    const selected = selectResponders(
      [a, b],
      analyzeSocialSignals("opaque ordinary turn"),
      new Map(),
      1_000_000,
      () => 0.7,
      new Map([[a.id, 0], [b.id, 0]]),
      new Map([[a.id, 0.12], [b.id, -0.12]]),
    );

    expect(selected.map((candidate) => candidate.id)).toEqual([a.id]);
  });

  it("keeps direct address above even the strongest negative relationship nudge", () => {
    const a = persona("ai-a", "A");
    const b = persona("ai-b", "B");
    const signals = {
      ...analyzeSocialSignals("opaque direct turn"),
      mentionedIds: [b.id],
    };
    const selected = selectResponders(
      [a, b],
      signals,
      new Map([[b.id, 1_000_000]]),
      1_000_001,
      () => 0,
      new Map([[a.id, 0], [b.id, 0]]),
      new Map([[a.id, 0.12], [b.id, -0.12]]),
    );

    expect(selected[0]?.id).toBe(b.id);
  });

  it("keeps semantic relevance above relationship preference", () => {
    const relevant = persona("ai-relevant", "Relevant");
    const familiar = persona("ai-familiar", "Familiar");
    const signals = {
      ...analyzeSocialSignals("opaque specialist question"),
      relevantIds: [relevant.id],
    };
    const selected = selectResponders(
      [relevant, familiar],
      signals,
      new Map(),
      1_000_000,
      () => 0.7,
      new Map([[relevant.id, 0], [familiar.id, 0]]),
      new Map([[relevant.id, -0.12], [familiar.id, 0.12]]),
    );

    expect(selected[0]?.id).toBe(relevant.id);
  });

  it("never lets relationship bias reactivate an optional cooling resident", () => {
    const cooling = { ...persona("ai-cooling", "Cooling"), talkativeness: 0.9 };
    const signals = {
      ...analyzeSocialSignals("opaque relevant turn"),
      relevantIds: [cooling.id],
    };
    const withoutRelationship = selectResponders(
      [cooling],
      signals,
      new Map([[cooling.id, 999_999]]),
      1_000_000,
      () => 0.9,
      new Map([[cooling.id, 0]]),
      new Map(),
    );
    const withMaximumRelationship = selectResponders(
      [cooling],
      signals,
      new Map([[cooling.id, 999_999]]),
      1_000_000,
      () => 0.9,
      new Map([[cooling.id, 0]]),
      new Map([[cooling.id, 0.12]]),
    );

    expect(withoutRelationship).toEqual([]);
    expect(withMaximumRelationship).toEqual(withoutRelationship);
  });

  it("uses a directed relationship only for the active ambient continuation", () => {
    const a = persona("ai-a", "A");
    const b = persona("ai-b", "B");
    expect(selectAmbientLead([a, b], () => 0.5, () => 0, "discussion")?.id).toBe(a.id);
    expect(selectAmbientLead(
      [a, b],
      () => 0.5,
      () => 0,
      "discussion",
      (id) => id === b.id ? 0.12 : -0.12,
    )?.id).toBe(b.id);
  });

  it("does not turn a romantic boundary into ordinary social avoidance", () => {
    const projection = projectRelationshipBehavior(relationship({
      romanticInterest: 0.9,
      romanticBoundaryClosed: true,
      romanticBoundaryBlockerIds: ["human-one"],
    }), { allowRomanticSurface: true, romanticSceneEligibility: "eligible" });

    expect(projection.promptCue).not.toHaveProperty("romanticInterest");
    expect(projection.decisionBiases.ordinaryPublicReply).toBe(0);
    expect(projection.decisionBiases.voiceTieBreak).toBe(0);
  });

  it("maps only trusted structured turn semantics into the human romance gate", () => {
    const fallback = createFailClosedTurnAnalysis("timeout");
    expect(humanRomanticTurnGate(fallback, "ai-a", ["ai-a"])).toMatchObject({
      semanticTrusted: false,
      semanticKind: "unclear",
      addressedToResident: true,
      socialTrusted: false,
      interactionTrusted: false,
      moderationTrusted: false,
    });

    const trusted = {
      ...fallback,
      source: "lm" as const,
      failureReason: null,
      relationshipSurface: { kind: "romantic_disclosure" as const, confidence: 0.96 },
      social: {
        ...fallback.social,
        warmth: 0.8,
        hostility: 0.02,
        urgency: 0.1,
        confidence: 0.95,
      },
      interaction: {
        kind: "ordinary" as const,
        targetScope: "named_participant" as const,
        reactionNeed: "optional" as const,
        coarseness: 0,
        mutualBanterConfidence: 0,
        confidence: 0.95,
      },
      moderation: { risk: "none" as const, action: "none" as const, categories: [], confidence: 0.98 },
    };
    expect(humanRomanticTurnGate(trusted, "ai-a", ["ai-a"])).toMatchObject({
      semanticTrusted: true,
      semanticKind: "romantic_disclosure",
      addressedToResident: true,
      socialTrusted: true,
      interactionTrusted: true,
      moderationTrusted: true,
    });
  });
});
