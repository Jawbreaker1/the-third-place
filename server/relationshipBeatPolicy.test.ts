import { describe, expect, it, vi } from "vitest";
import type { RelationshipBehaviorProjection } from "./relationshipBehavior.js";
import {
  isHumanRomanticTurnSuitable,
  shouldSurfaceRareRomanticPromptCue,
  type HumanRomanticTurnGate,
  type RareRomanticPromptCueGateInput,
} from "./relationshipBeatPolicy.js";

const projection = (overrides: {
  romanticInterest?: RelationshipBehaviorProjection["bands"]["romanticInterest"];
  boundary?: RelationshipBehaviorProjection["romanticBoundary"]["state"];
} = {}): RelationshipBehaviorProjection => ({
  bands: {
    familiarity: "close",
    warmth: "positive",
    trust: "positive",
    respect: "positive",
    friction: "low",
    romanticInterest: overrides.romanticInterest ?? "established",
  },
  romanticBoundary: {
    state: overrides.boundary ?? "unspecified",
    blockerActorIds: overrides.boundary === "closed" ? ["server-private-blocker"] : [],
  },
  decisionBiases: {
    ordinaryPublicReply: 0,
    conflictChallengeReply: 0,
    welcome: 0,
    ambientContinuation: 0,
    voiceTieBreak: 0,
  },
  promptCue: { rapport: "close", stance: "warm", friction: "low" },
});

const turn = (
  overrides: Partial<HumanRomanticTurnGate> = {},
): HumanRomanticTurnGate => ({
  semanticTrusted: true,
  semanticKind: "romantic_disclosure",
  addressedToResident: true,
  socialTrusted: true,
  hostility: 0,
  urgency: 0,
  interactionTrusted: true,
  interactionKind: "ordinary",
  moderationTrusted: true,
  moderationRisk: "none",
  moderationAction: "none",
  moderationCategories: [],
  ...overrides,
});

const humanGate = (
  overrides: Partial<Extract<RareRomanticPromptCueGateInput, { audience: "resident-human" }>> = {},
): Extract<RareRomanticPromptCueGateInput, { audience: "resident-human" }> => ({
  audience: "resident-human",
  accountEligible: true,
  residentEligible: true,
  turn: turn(),
  forward: projection(),
  now: 100_000,
  cooldownMs: 10_000,
  chance: 1,
  rng: () => 0.5,
  ...overrides,
});

describe("rare romantic prompt-cue policy", () => {
  it("requires account eligibility without consuming randomness", () => {
    const rng = vi.fn(() => 0);
    expect(shouldSurfaceRareRomanticPromptCue(humanGate({ accountEligible: false, rng }))).toBe(false);
    expect(rng).not.toHaveBeenCalled();
  });

  it("requires the exact resident adult assertion without consuming randomness", () => {
    const rng = vi.fn(() => 0);
    expect(shouldSurfaceRareRomanticPromptCue(humanGate({ residentEligible: false, rng }))).toBe(false);
    expect(rng).not.toHaveBeenCalled();
  });

  it.each([
    ["missing semantic trust", { semanticTrusted: false }],
    ["ordinary friendliness", { semanticKind: "nonromantic_affection" as const }],
    ["explicit boundary", { semanticKind: "boundary" as const }],
    ["unsafe context", { semanticKind: "unsafe" as const }],
    ["unclear context", { semanticKind: "unclear" as const }],
    ["wrong addressee", { addressedToResident: false }],
    ["untrusted social signal", { socialTrusted: false }],
    ["hostility", { hostility: 0.26 }],
    ["crisis urgency", { urgency: 0.66 }],
    ["untrusted interaction", { interactionTrusted: false }],
    ["harassment", { interactionKind: "harassment" as const }],
    ["moderation watch", { moderationRisk: "low" as const, moderationAction: "watch" as const }],
    ["crisis category", { moderationCategories: ["self_harm"] }],
  ])("fails closed for %s", (_label, overrides) => {
    const rng = vi.fn(() => 0);
    expect(shouldSurfaceRareRomanticPromptCue(humanGate({
      turn: turn(overrides as Partial<HumanRomanticTurnGate>),
      rng,
    }))).toBe(false);
    expect(rng).not.toHaveBeenCalled();
  });

  it("accepts only the trusted semantic suitability tuple", () => {
    expect(isHumanRomanticTurnSuitable(turn())).toBe(true);
    expect(isHumanRomanticTurnSuitable(turn({ interactionKind: "playful_banter" }))).toBe(true);
  });

  it.each(["none", "emerging"] as const)(
    "rejects %s forward interest",
    (romanticInterest) => {
      expect(shouldSurfaceRareRomanticPromptCue(humanGate({
        forward: projection({ romanticInterest }),
      }))).toBe(false);
    },
  );

  it("requires established open projections in both directions for two residents", () => {
    const base: Extract<RareRomanticPromptCueGateInput, { audience: "resident-resident" }> = {
      audience: "resident-resident",
      ownerEligible: true,
      subjectEligible: true,
      forward: projection(),
      reciprocal: projection(),
      now: 100_000,
      cooldownMs: 10_000,
      chance: 1,
      rng: () => 0.5,
    };
    expect(shouldSurfaceRareRomanticPromptCue(base)).toBe(true);
    expect(shouldSurfaceRareRomanticPromptCue({ ...base, ownerEligible: false })).toBe(false);
    expect(shouldSurfaceRareRomanticPromptCue({ ...base, subjectEligible: false })).toBe(false);
    expect(shouldSurfaceRareRomanticPromptCue({ ...base, reciprocal: undefined })).toBe(false);
    expect(shouldSurfaceRareRomanticPromptCue({
      ...base,
      reciprocal: projection({ romanticInterest: "emerging" }),
    })).toBe(false);
  });

  it("treats a boundary in either resident direction as a veto", () => {
    const base: Extract<RareRomanticPromptCueGateInput, { audience: "resident-resident" }> = {
      audience: "resident-resident",
      ownerEligible: true,
      subjectEligible: true,
      forward: projection(),
      reciprocal: projection(),
      now: 100_000,
      cooldownMs: 10_000,
      chance: 1,
      rng: () => 0.5,
    };
    expect(shouldSurfaceRareRomanticPromptCue({
      ...base,
      forward: projection({ boundary: "closed" }),
    })).toBe(false);
    expect(shouldSurfaceRareRomanticPromptCue({
      ...base,
      reciprocal: projection({ boundary: "closed" }),
    })).toBe(false);
  });

  it("requires the complete last-surface cooldown and rejects future timestamps", () => {
    expect(shouldSurfaceRareRomanticPromptCue(humanGate({ lastSurfaceAt: 90_001 }))).toBe(false);
    expect(shouldSurfaceRareRomanticPromptCue(humanGate({ lastSurfaceAt: 90_000 }))).toBe(true);
    expect(shouldSurfaceRareRomanticPromptCue(humanGate({ lastSurfaceAt: 100_001, cooldownMs: 0 }))).toBe(false);
  });

  it("bounds chance and handles exact zero and one deterministically", () => {
    expect(shouldSurfaceRareRomanticPromptCue(humanGate({ chance: 0, rng: () => 0 }))).toBe(false);
    expect(shouldSurfaceRareRomanticPromptCue(humanGate({ chance: 1, rng: () => 1 }))).toBe(true);
    expect(shouldSurfaceRareRomanticPromptCue(humanGate({ chance: -5, rng: () => 0 }))).toBe(false);
    expect(shouldSurfaceRareRomanticPromptCue(humanGate({ chance: 5, rng: () => 1 }))).toBe(true);
    expect(shouldSurfaceRareRomanticPromptCue(humanGate({ chance: 0.25, rng: () => 0.249 }))).toBe(true);
    expect(shouldSurfaceRareRomanticPromptCue(humanGate({ chance: 0.25, rng: () => 0.25 }))).toBe(false);
  });

  it.each([
    { label: "NaN now", overrides: { now: Number.NaN } },
    { label: "infinite now", overrides: { now: Number.POSITIVE_INFINITY } },
    { label: "NaN cooldown", overrides: { cooldownMs: Number.NaN } },
    { label: "infinite cooldown", overrides: { cooldownMs: Number.POSITIVE_INFINITY } },
    { label: "negative cooldown", overrides: { cooldownMs: -1 } },
    { label: "NaN last surface", overrides: { lastSurfaceAt: Number.NaN } },
    { label: "infinite last surface", overrides: { lastSurfaceAt: Number.POSITIVE_INFINITY } },
    { label: "NaN chance", overrides: { chance: Number.NaN } },
    { label: "infinite chance", overrides: { chance: Number.POSITIVE_INFINITY } },
    { label: "NaN roll", overrides: { rng: () => Number.NaN } },
    { label: "infinite roll", overrides: { rng: () => Number.POSITIVE_INFINITY } },
    { label: "negative roll", overrides: { rng: () => -0.01 } },
    { label: "oversized roll", overrides: { rng: () => 1.01 } },
    { label: "throwing RNG", overrides: { rng: () => { throw new Error("rng unavailable"); } } },
  ] as const)("fails closed for $label", ({ overrides }) => {
    expect(shouldSurfaceRareRomanticPromptCue(humanGate(overrides))).toBe(false);
  });

  it("fails closed for malformed runtime audience or projection input", () => {
    expect(shouldSurfaceRareRomanticPromptCue(humanGate({
      audience: "public-room" as RareRomanticPromptCueGateInput["audience"],
    } as never))).toBe(false);
    expect(shouldSurfaceRareRomanticPromptCue(humanGate({
      forward: {} as RelationshipBehaviorProjection,
    }))).toBe(false);
  });
});
