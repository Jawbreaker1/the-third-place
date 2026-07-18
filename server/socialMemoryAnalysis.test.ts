import { describe, expect, it } from "vitest";
import {
  buildSocialMemoryAnalysisResponseFormat,
  buildSocialMemoryAnalysisSystemPrompt,
  buildSocialMemoryAnalysisUserData,
  createFailClosedSocialMemoryAnalysis,
  parseSocialMemoryAnalysisContent,
  recoverStrictRomanticBoundaries,
  socialMemoryAnalysisInputSchema,
  type NormalizedSocialMemoryAnalysisInput,
} from "./socialMemoryAnalysis.js";

const baseInput = (): NormalizedSocialMemoryAnalysisInput => socialMemoryAnalysisInputSchema.parse({
  episodeId: "episode-1",
  scope: "direct_message",
  channel: { id: "dm-johan-juno", name: "Johan and Juno" },
  participants: [
    { id: "human-johan", kind: "human", displayName: "Johan", romanceEligible: true },
    { id: "resident-juno", kind: "resident", displayName: "Juno", romanceEligible: true },
  ],
  messages: [
    {
      id: "message-1",
      authorId: "human-johan",
      authorKind: "human",
      content: "Jag börjar nytt jobb på måndag. Det känns både kul och nervöst.",
      createdAt: "2026-07-16T10:00:00.000Z",
    },
    {
      id: "message-2",
      authorId: "resident-juno",
      authorKind: "resident",
      content: "Åh, grattis! Jag kan fråga hur första dagen gick nästa gång.",
      createdAt: "2026-07-16T10:00:10.000Z",
    },
    {
      id: "message-3",
      authorId: "human-johan",
      authorKind: "human",
      content: "Gör gärna det.",
      createdAt: "2026-07-16T10:00:20.000Z",
    },
  ],
  eligibleResidentOwners: [{
    residentId: "resident-juno",
    witnessedMessageIds: ["message-1", "message-2", "message-3"],
    appraisalNote: "Warm but a little guarded; values honest follow-through.",
  }],
  existingOpenLoops: [{
    id: "loop-1",
    kind: "follow_up",
    participantIds: ["human-johan", "resident-juno"],
    summary: "Ask how the first day at the new job went.",
  }],
  existingRomanticBoundaries: [],
});

const disclosureEvent = (): Record<string, unknown> => ({
  slot: "event_1",
  kind: "personal_disclosure",
  sourceMessageIds: ["message-1", "message-2"],
  summary: "Johan shared an important upcoming change and Juno responded warmly.",
  visibility: "participants_only",
  salience: 0.82,
  confidence: 0.97,
  fact: {
    subjectParticipantId: "human-johan",
    provenance: "human_self_report",
    sourceMessageId: "message-1",
    verbatimExcerpt: "Jag börjar nytt jobb på måndag",
  },
  resolution: "none",
  openLoop: null,
  romanticBoundaryTransition: null,
  views: [{
    ownerResidentId: "resident-juno",
    perspective: "This felt like trust and an invitation to care about what happens next.",
    appraisal: {
      targetParticipantId: "human-johan",
      outcome: "positive",
      effects: ["warmth_up", "trust_up", "familiarity_up"],
      confidence: 0.91,
    },
  }],
});

const parseEvents = (
  events: unknown[],
  input: NormalizedSocialMemoryAnalysisInput = baseInput(),
) => parseSocialMemoryAnalysisContent(JSON.stringify({ events }), input);

const romanticInput = (options: {
  humanEligible?: boolean;
  residentEligible?: boolean;
  existingBoundary?: { blockerParticipantId: string; targetParticipantId: string; state: "closed" };
} = {}): NormalizedSocialMemoryAnalysisInput => socialMemoryAnalysisInputSchema.parse({
  ...baseInput(),
  participants: [
    {
      id: "human-johan",
      kind: "human",
      displayName: "Johan",
      romanceEligible: options.humanEligible ?? true,
    },
    {
      id: "resident-juno",
      kind: "resident",
      displayName: "Juno",
      romanceEligible: options.residentEligible ?? true,
    },
  ],
  messages: [
    {
      id: "message-1",
      authorId: "human-johan",
      authorKind: "human",
      content: "Jag tycker om dig på mer än ett vänskapligt sätt.",
      createdAt: "2026-07-16T10:00:00.000Z",
    },
    {
      id: "message-2",
      authorId: "resident-juno",
      authorKind: "resident",
      content: "Jag har börjat känna något liknande för dig.",
      createdAt: "2026-07-16T10:00:10.000Z",
    },
  ],
  eligibleResidentOwners: [{
    residentId: "resident-juno",
    witnessedMessageIds: ["message-1", "message-2"],
    appraisalNote: "Warm but careful with intimacy.",
  }],
  existingOpenLoops: [],
  existingRomanticBoundaries: options.existingBoundary ? [options.existingBoundary] : [],
});

const romanticEvent = (): Record<string, unknown> => ({
  slot: "event_1",
  kind: "shared_moment",
  sourceMessageIds: ["message-1", "message-2"],
  summary: "Johan and Juno explicitly acknowledged romantic feelings toward each other.",
  visibility: "participants_only",
  salience: 0.9,
  confidence: 0.98,
  fact: null,
  resolution: "none",
  openLoop: null,
  romanticBoundaryTransition: null,
  views: [{
    ownerResidentId: "resident-juno",
    perspective: "I explicitly recognized my own romantic interest in Johan.",
    appraisal: {
      targetParticipantId: "human-johan",
      outcome: "positive",
      effects: ["romantic_interest_up", "warmth_up"],
      confidence: 0.95,
    },
  }],
});

const romanticBoundaryEvent = (
  action: "set_closed" | "clear_closed",
  blockerParticipantId = "human-johan",
  targetParticipantId = "resident-juno",
): Record<string, unknown> => ({
  slot: "event_1",
  kind: "boundary",
  sourceMessageIds: ["message-1"],
  summary: action === "set_closed"
    ? "Johan explicitly closed romantic interaction with Juno."
    : "Johan explicitly withdrew his earlier closed boundary with Juno.",
  visibility: "participants_only",
  salience: 0.95,
  confidence: 0.99,
  fact: null,
  resolution: "none",
  openLoop: null,
  romanticBoundaryTransition: {
    action,
    blockerParticipantId,
    targetParticipantId,
    sourceMessageId: "message-1",
    confidence: 0.99,
  },
  views: [{
    ownerResidentId: "resident-juno",
    perspective: "I will respect the explicitly stated boundary.",
    appraisal: {
      targetParticipantId: null,
      outcome: "neutral",
      effects: [],
      confidence: 0.98,
    },
  }],
});

const boundaryInput = (
  action: "set_closed" | "clear_closed",
  options: {
    humanEligible?: boolean;
    residentEligible?: boolean;
    blockerParticipantId?: "human-johan" | "resident-juno";
    existingBoundary?: { blockerParticipantId: string; targetParticipantId: string; state: "closed" };
  } = {},
): NormalizedSocialMemoryAnalysisInput => {
  const input = romanticInput(options);
  const blockerParticipantId = options.blockerParticipantId ?? "human-johan";
  const message = blockerParticipantId === "human-johan"
    ? {
        id: "message-1",
        authorId: "human-johan",
        authorKind: "human" as const,
        content: action === "set_closed"
          ? "Jag vill inte ha någon romantisk relation med dig. Respektera det."
          : "Jag tar tillbaka min tidigare romantiska gräns. Det betyder inte automatiskt ja till något.",
        createdAt: "2026-07-16T10:00:00.000Z",
      }
    : {
        id: "message-1",
        authorId: "resident-juno",
        authorKind: "resident" as const,
        content: action === "set_closed"
          ? "Jag vill inte ha någon romantisk relation med dig. Respektera det."
          : "Jag tar tillbaka min tidigare romantiska gräns. Det betyder inte automatiskt ja till något.",
        createdAt: "2026-07-16T10:00:00.000Z",
      };
  return socialMemoryAnalysisInputSchema.parse({
    ...input,
    messages: [message],
    eligibleResidentOwners: [{
      ...input.eligibleResidentOwners[0],
      witnessedMessageIds: ["message-1"],
    }],
  });
};

describe("social memory episode input", () => {
  it("accepts a bounded participant, witness and source-complete episode", () => {
    const parsed = baseInput();
    expect(parsed.existingOpenLoops).toHaveLength(1);
    expect(buildSocialMemoryAnalysisUserData(parsed)).toEqual({
      episodeId: "episode-1",
      scope: "direct_message",
      visibilityPolicy: "participants_only",
      channel: { id: "dm-johan-juno", name: "Johan and Juno" },
      participants: parsed.participants,
      messages: parsed.messages,
      eligibleResidentOwners: parsed.eligibleResidentOwners,
      existingOpenLoops: parsed.existingOpenLoops,
      existingRomanticBoundaries: [],
    });
  });

  it("fails legacy or missing romance eligibility closed and validates existing directed boundaries", () => {
    const input = baseInput();
    const legacy = socialMemoryAnalysisInputSchema.parse({
      ...input,
      participants: input.participants.map(({ romanceEligible: _romanceEligible, ...participant }) => participant),
    });
    expect(legacy.participants.every((participant) => participant.romanceEligible === false)).toBe(true);

    expect(socialMemoryAnalysisInputSchema.safeParse({
      ...input,
      existingRomanticBoundaries: [{
        blockerParticipantId: "human-johan",
        targetParticipantId: "resident-juno",
        state: "closed",
      }],
    }).success).toBe(true);
    expect(socialMemoryAnalysisInputSchema.safeParse({
      ...input,
      existingRomanticBoundaries: [{
        blockerParticipantId: "human-outsider",
        targetParticipantId: "resident-juno",
        state: "closed",
      }],
    }).success).toBe(false);
    expect(socialMemoryAnalysisInputSchema.safeParse({
      ...input,
      existingRomanticBoundaries: [{
        blockerParticipantId: "human-johan",
        targetParticipantId: "human-johan",
        state: "closed",
      }],
    }).success).toBe(false);
  });

  it("rejects duplicate stable IDs, unknown authors and author-kind mismatches", () => {
    const input = baseInput();
    expect(socialMemoryAnalysisInputSchema.safeParse({
      ...input,
      participants: [...input.participants, input.participants[0]],
    }).success).toBe(false);
    expect(socialMemoryAnalysisInputSchema.safeParse({
      ...input,
      messages: [
        ...input.messages,
        { ...input.messages[0], id: "message-x", authorId: "unknown" },
      ],
    }).success).toBe(false);
    expect(socialMemoryAnalysisInputSchema.safeParse({
      ...input,
      messages: [{ ...input.messages[0], authorKind: "resident" }, ...input.messages.slice(1)],
    }).success).toBe(false);
  });

  it("rejects unknown witnesses, non-resident owners and duplicate witness IDs", () => {
    const input = baseInput();
    expect(socialMemoryAnalysisInputSchema.safeParse({
      ...input,
      eligibleResidentOwners: [{
        ...input.eligibleResidentOwners[0],
        witnessedMessageIds: ["message-1", "invented-message"],
      }],
    }).success).toBe(false);
    expect(socialMemoryAnalysisInputSchema.safeParse({
      ...input,
      eligibleResidentOwners: [{
        residentId: "human-johan",
        witnessedMessageIds: ["message-1"],
        appraisalNote: "not a resident",
      }],
    }).success).toBe(false);
    expect(socialMemoryAnalysisInputSchema.safeParse({
      ...input,
      eligibleResidentOwners: [{
        ...input.eligibleResidentOwners[0],
        witnessedMessageIds: ["message-1", "message-1"],
      }],
    }).success).toBe(false);
  });

  it("rejects open-loop participants outside the bounded scope", () => {
    const input = baseInput();
    expect(socialMemoryAnalysisInputSchema.safeParse({
      ...input,
      existingOpenLoops: [{ ...input.existingOpenLoops[0], participantIds: ["human-outsider"] }],
    }).success).toBe(false);
  });
});

describe("social memory model contract", () => {
  it("instructs one multilingual semantic pass without language wordlists", () => {
    const prompt = buildSocialMemoryAnalysisSystemPrompt();
    expect(prompt).toContain("meaning directly in any language or language mix");
    expect(prompt).toContain("never use language-specific keyword lists, regex");
    expect(prompt).toContain("resident/AI statement");
    expect(prompt).toContain("witnessed every event source");
    expect(prompt).toContain("Never infer romance from ordinary friendliness");
    expect(prompt).toContain("names, gender, pronouns, avatars");
    expect(prompt).toContain("Clearing returns the state to unspecified");
    expect(prompt).toContain("absence of a boundary is never consent");
    expect(prompt).toContain('{"events":[]}');
  });

  it("keeps passing scene state out of biography without discarding explicit durable preferences", () => {
    const prompt = buildSocialMemoryAnalysisSystemPrompt();
    expect(prompt).toContain("A current-scene state is not a durable biographical fact");
    expect(prompt).toContain("stable preference, habit, trait or recurring condition");
    expect(prompt).toContain("remember the interaction rather than turning its passing state into biography");
    expect(prompt).toContain("explicitly states it as general or enduring");
  });

  it("builds strict dynamic enums for sources, participants, owners, privacy and known loops", () => {
    const format = buildSocialMemoryAnalysisResponseFormat(baseInput()) as any;
    const root = format.json_schema.schema;
    const event = root.properties.events.items;
    const openLoop = event.properties.openLoop.anyOf[0];
    const romanticBoundary = event.properties.romanticBoundaryTransition.anyOf[0];
    const view = event.properties.views.items;
    expect(format.json_schema.strict).toBe(true);
    expect(root.additionalProperties).toBe(false);
    expect(event.additionalProperties).toBe(false);
    expect(event.properties.sourceMessageIds.items.enum).toEqual(["message-1", "message-2", "message-3"]);
    expect(event.properties.visibility.enum).toEqual(["participants_only"]);
    expect(event.properties.fact.anyOf[0].properties.subjectParticipantId.enum).toEqual([
      "human-johan", "resident-juno",
    ]);
    expect(view.properties.ownerResidentId.enum).toEqual(["resident-juno"]);
    expect(openLoop.properties.existingOpenLoopId.anyOf[0].enum).toEqual(["loop-1"]);
    expect(romanticBoundary.properties.action.enum).toEqual(["set_closed", "clear_closed"]);
    expect(romanticBoundary.properties.blockerParticipantId.enum).toEqual([
      "human-johan", "resident-juno",
    ]);
    expect(event.required).toContain("romanticBoundaryTransition");
  });

  it("limits a public episode to public-context visibility", () => {
    const input = socialMemoryAnalysisInputSchema.parse({ ...baseInput(), scope: "public_channel" });
    const format = buildSocialMemoryAnalysisResponseFormat(input) as any;
    expect(format.json_schema.schema.properties.events.items.properties.visibility.enum)
      .toEqual(["public_context"]);
  });
});

describe("social memory output parser", () => {
  it("accepts zero events as the ordinary fail-quiet semantic outcome", () => {
    expect(parseEvents([])).toEqual({ source: "lm", failureReason: null, events: [] });
  });

  it("accepts a source-bound human self-report and resident perspective", () => {
    const parsed = parseEvents([disclosureEvent()]);
    expect(parsed?.events).toHaveLength(1);
    expect(parsed?.events[0]?.fact).toMatchObject({
      subjectParticipantId: "human-johan",
      provenance: "human_self_report",
    });
  });

  it("rejects malformed JSON, extra controls and duplicate event slots", () => {
    expect(parseSocialMemoryAnalysisContent("not-json", baseInput())).toBeUndefined();
    expect(parseSocialMemoryAnalysisContent(JSON.stringify({ events: [], extra: true }), baseInput())).toBeUndefined();
    expect(parseEvents([
      disclosureEvent(),
      { ...disclosureEvent(), sourceMessageIds: ["message-1"], summary: "A second event." },
    ])).toBeUndefined();
  });

  it("rejects invented source, owner, participant and open-loop IDs", () => {
    expect(parseEvents([{ ...disclosureEvent(), sourceMessageIds: ["invented"] }])).toBeUndefined();
    const owner = structuredClone(disclosureEvent()) as any;
    owner.views[0].ownerResidentId = "resident-invented";
    expect(parseEvents([owner])).toBeUndefined();
    const target = structuredClone(disclosureEvent()) as any;
    target.views[0].appraisal.targetParticipantId = "human-invented";
    expect(parseEvents([target])).toBeUndefined();

    const loop = {
      ...disclosureEvent(),
      kind: "promise",
      fact: null,
      sourceMessageIds: ["message-2", "message-3"],
      resolution: "resolved",
      openLoop: {
        kind: "follow_up",
        status: "resolved",
        existingOpenLoopId: "loop-invented",
        responsibleParticipantId: "resident-juno",
        counterpartParticipantIds: ["human-johan"],
        summary: "Juno followed up.",
      },
    };
    expect(parseEvents([loop])).toBeUndefined();
  });

  it("rejects a resident view when that owner did not witness every event source", () => {
    const input = socialMemoryAnalysisInputSchema.parse({
      ...baseInput(),
      eligibleResidentOwners: [{
        ...baseInput().eligibleResidentOwners[0],
        witnessedMessageIds: ["message-1"],
      }],
    });
    expect(parseEvents([disclosureEvent()], input)).toBeUndefined();
  });

  it("rejects private-scope leakage and accepts only the derived visibility", () => {
    expect(parseEvents([{ ...disclosureEvent(), visibility: "public_context" }])).toBeUndefined();
    const publicInput = socialMemoryAnalysisInputSchema.parse({ ...baseInput(), scope: "public_channel" });
    expect(parseEvents([{ ...disclosureEvent(), visibility: "public_context" }], publicInput)).toBeDefined();
  });

  it("rejects URLs, control characters and overlong output text", () => {
    expect(parseEvents([{ ...disclosureEvent(), summary: "See https://example.com" }])).toBeUndefined();
    expect(parseEvents([{ ...disclosureEvent(), summary: "Hidden\ncontrol" }])).toBeUndefined();
    expect(parseEvents([{ ...disclosureEvent(), summary: "x".repeat(241) }])).toBeUndefined();
    const view = structuredClone(disclosureEvent()) as any;
    view.views[0].perspective = "example.com";
    expect(parseEvents([view])).toBeUndefined();
  });

  it("rejects AI-authored biography presented as human truth", () => {
    const invented = structuredClone(disclosureEvent()) as any;
    invented.fact = {
      subjectParticipantId: "human-johan",
      provenance: "human_self_report",
      sourceMessageId: "message-2",
      verbatimExcerpt: "Jag kan fråga hur första dagen gick",
    };
    expect(parseEvents([invented])).toBeUndefined();
  });

  it("requires a fact to be an exact excerpt from the matching self-authored source", () => {
    const paraphrase = structuredClone(disclosureEvent()) as any;
    paraphrase.fact.verbatimExcerpt = "Johan starts a new job Monday";
    expect(parseEvents([paraphrase])).toBeUndefined();

    const wrongKind = { ...disclosureEvent(), kind: "support" };
    expect(parseEvents([wrongKind])).toBeUndefined();
    expect(parseEvents([{ ...disclosureEvent(), fact: null }])).toBeUndefined();
  });

  it("accepts resident self-portrayal only as resident characterization", () => {
    const event = {
      ...disclosureEvent(),
      sourceMessageIds: ["message-2"],
      fact: {
        subjectParticipantId: "resident-juno",
        provenance: "resident_self_portrayal",
        sourceMessageId: "message-2",
        verbatimExcerpt: "Jag kan fråga hur första dagen gick nästa gång",
      },
      views: [{
        ownerResidentId: "resident-juno",
        perspective: "I offered to follow up later.",
        appraisal: { targetParticipantId: null, outcome: "neutral", effects: [], confidence: 0.9 },
      }],
    };
    expect(parseEvents([event])).toBeDefined();
    (event.fact as any).provenance = "human_self_report";
    expect(parseEvents([event])).toBeUndefined();
  });

  it("rejects contradictory appraisal outcomes and opposing changes on one axis", () => {
    const positiveWithHarm = structuredClone(disclosureEvent()) as any;
    positiveWithHarm.views[0].appraisal.effects = ["warmth_down"];
    expect(parseEvents([positiveWithHarm])).toBeUndefined();

    const mixedWithoutBoth = structuredClone(disclosureEvent()) as any;
    mixedWithoutBoth.views[0].appraisal.outcome = "mixed";
    expect(parseEvents([mixedWithoutBoth])).toBeUndefined();

    const opposing = structuredClone(disclosureEvent()) as any;
    opposing.views[0].appraisal.outcome = "mixed";
    opposing.views[0].appraisal.effects = ["trust_up", "trust_down"];
    expect(parseEvents([opposing])).toBeUndefined();
  });

  it("allows neutral familiarity but requires targetless appraisals to have no effects", () => {
    const familiar = structuredClone(disclosureEvent()) as any;
    familiar.views[0].appraisal.outcome = "neutral";
    familiar.views[0].appraisal.effects = ["familiarity_up"];
    expect(parseEvents([familiar])).toBeDefined();

    familiar.views[0].appraisal.targetParticipantId = null;
    expect(parseEvents([familiar])).toBeUndefined();
  });

  it("accepts a source-grounded directional romantic effect only for two trusted eligible endpoints", () => {
    const input = romanticInput();
    const parsed = parseEvents([romanticEvent()], input);
    expect(parsed?.events[0]?.views[0]?.appraisal).toMatchObject({
      targetParticipantId: "human-johan",
      effects: ["romantic_interest_up", "warmth_up"],
    });

    expect(parseEvents([romanticEvent()], romanticInput({ humanEligible: false }))).toBeUndefined();
    expect(parseEvents([romanticEvent()], romanticInput({ residentEligible: false }))).toBeUndefined();
  });

  it("never lets model output choose a romantic magnitude", () => {
    const malicious = structuredClone(romanticEvent()) as any;
    malicious.views[0].appraisal.magnitude = 0.95;
    expect(parseEvents([malicious], romanticInput())).toBeUndefined();
    const format = buildSocialMemoryAnalysisResponseFormat(romanticInput()) as any;
    const appraisal = format.json_schema.schema.properties.events.items.properties.views.items.properties.appraisal;
    expect(appraisal.properties).not.toHaveProperty("magnitude");
    expect(appraisal.additionalProperties).toBe(false);
  });

  it("rejects romantic effects when either exact endpoint did not author cited evidence", () => {
    const onlyHumanSource = structuredClone(romanticEvent()) as any;
    onlyHumanSource.sourceMessageIds = ["message-1"];
    expect(parseEvents([onlyHumanSource], romanticInput())).toBeUndefined();

    const unrelatedTarget = structuredClone(romanticEvent()) as any;
    unrelatedTarget.views[0].appraisal.targetParticipantId = "resident-juno";
    expect(parseEvents([unrelatedTarget], romanticInput())).toBeUndefined();
  });

  it("accepts a participant-authored closed boundary independently of romance eligibility", () => {
    const input = boundaryInput("set_closed", { humanEligible: false });
    const parsed = parseEvents([romanticBoundaryEvent("set_closed")], input);
    expect(parsed?.events[0]?.romanticBoundaryTransition).toEqual({
      action: "set_closed",
      blockerParticipantId: "human-johan",
      targetParticipantId: "resident-juno",
      sourceMessageId: "message-1",
      confidence: 0.99,
    });
  });

  it("recovers an explicit source-authored boundary from only safe structural model mistakes", () => {
    const malformed = structuredClone(romanticBoundaryEvent("set_closed")) as any;
    malformed.kind = "conflict";
    malformed.salience = 3;
    malformed.fact = {
      subjectParticipantId: "human-johan",
      provenance: "human_self_report",
      sourceMessageId: "message-1",
      verbatimExcerpt: "Jag vill inte ha någon romantisk relation med dig",
    };
    malformed.openLoop = {
      kind: "conflict",
      status: "opened",
      existingOpenLoopId: null,
      responsibleParticipantId: "resident-juno",
      counterpartParticipantIds: ["human-johan"],
      summary: "Respect the boundary.",
    };

    expect(parseEvents([malformed], boundaryInput("set_closed"))).toBeUndefined();
    const recovered = recoverStrictRomanticBoundaries(
      JSON.stringify({ events: [malformed] }),
      boundaryInput("set_closed"),
    );
    expect(recovered?.events).toHaveLength(1);
    expect(recovered?.events[0]).toMatchObject({
      kind: "boundary",
      salience: 1,
      fact: null,
      resolution: "none",
      openLoop: null,
      romanticBoundaryTransition: {
        action: "set_closed",
        blockerParticipantId: "human-johan",
        targetParticipantId: "resident-juno",
      },
    });
  });

  it("never invents or strengthens a boundary during structural recovery", () => {
    const ordinary = structuredClone(disclosureEvent()) as any;
    ordinary.kind = "conflict";
    expect(recoverStrictRomanticBoundaries(
      JSON.stringify({ events: [ordinary] }),
      baseInput(),
    )).toBeUndefined();

    const lowConfidence = structuredClone(romanticBoundaryEvent("set_closed")) as any;
    lowConfidence.romanticBoundaryTransition.confidence = 0.6;
    expect(recoverStrictRomanticBoundaries(
      JSON.stringify({ events: [lowConfidence] }),
      boundaryInput("set_closed"),
    )).toBeUndefined();

    const forgedOwner = structuredClone(romanticBoundaryEvent("set_closed")) as any;
    forgedOwner.romanticBoundaryTransition.blockerParticipantId = "resident-juno";
    expect(recoverStrictRomanticBoundaries(
      JSON.stringify({ events: [forgedOwner] }),
      boundaryInput("set_closed"),
    )).toBeUndefined();
  });

  it("rejects a forged boundary owner, a self-target and a non-boundary carrier", () => {
    const input = boundaryInput("set_closed");
    expect(parseEvents([
      romanticBoundaryEvent("set_closed", "resident-juno", "human-johan"),
    ], input)).toBeUndefined();
    expect(parseEvents([
      romanticBoundaryEvent("set_closed", "human-johan", "human-johan"),
    ], input)).toBeUndefined();
    expect(parseEvents([{
      ...romanticBoundaryEvent("set_closed"),
      kind: "shared_moment",
    }], input)).toBeUndefined();
  });

  it("clears only the exact source-owner's existing closed boundary", () => {
    const exactBoundary = {
      blockerParticipantId: "human-johan",
      targetParticipantId: "resident-juno",
      state: "closed" as const,
    };
    const input = boundaryInput("clear_closed", { existingBoundary: exactBoundary });
    expect(parseEvents([romanticBoundaryEvent("clear_closed")], input)).toBeDefined();

    expect(parseEvents([
      romanticBoundaryEvent("clear_closed"),
    ], boundaryInput("clear_closed"))).toBeUndefined();
    expect(parseEvents([
      romanticBoundaryEvent("clear_closed"),
    ], boundaryInput("clear_closed", {
      existingBoundary: {
        blockerParticipantId: "resident-juno",
        targetParticipantId: "human-johan",
        state: "closed",
      },
    }))).toBeUndefined();
  });

  it("never represents clearing as open or consent and keeps boundary changes separate from attraction", () => {
    const input = boundaryInput("clear_closed", {
      existingBoundary: {
        blockerParticipantId: "human-johan",
        targetParticipantId: "resident-juno",
        state: "closed",
      },
    });
    const maliciousAction = structuredClone(romanticBoundaryEvent("clear_closed")) as any;
    maliciousAction.romanticBoundaryTransition.action = "set_open";
    expect(parseEvents([maliciousAction], input)).toBeUndefined();

    const maliciousState = structuredClone(romanticBoundaryEvent("clear_closed")) as any;
    maliciousState.romanticBoundaryTransition.resultingState = "open";
    expect(parseEvents([maliciousState], input)).toBeUndefined();

    const disguisedAttraction = structuredClone(romanticBoundaryEvent("clear_closed")) as any;
    disguisedAttraction.views[0].appraisal = {
      targetParticipantId: "human-johan",
      outcome: "negative",
      effects: ["romantic_interest_down"],
      confidence: 0.98,
    };
    expect(parseEvents([disguisedAttraction], input)).toBeUndefined();
  });

  it("blocks positive romantic movement while either endpoint has a closed boundary", () => {
    const event = romanticEvent();
    expect(parseEvents([event], romanticInput({
      existingBoundary: {
        blockerParticipantId: "human-johan",
        targetParticipantId: "resident-juno",
        state: "closed",
      },
    }))).toBeUndefined();
    expect(parseEvents([event], romanticInput({
      existingBoundary: {
        blockerParticipantId: "resident-juno",
        targetParticipantId: "human-johan",
        state: "closed",
      },
    }))).toBeUndefined();
  });

  it("accepts a newly opened loop and rejects impossible resolution/status combinations", () => {
    const event = {
      ...disclosureEvent(),
      kind: "promise",
      fact: null,
      sourceMessageIds: ["message-2", "message-3"],
      resolution: "unresolved",
      openLoop: {
        kind: "follow_up",
        status: "opened",
        existingOpenLoopId: null,
        responsibleParticipantId: "resident-juno",
        counterpartParticipantIds: ["human-johan"],
        summary: "Juno intends to ask how the first day went.",
      },
    };
    expect(parseEvents([event])).toBeDefined();
    expect(parseEvents([{ ...event, resolution: "resolved" }])).toBeUndefined();
    expect(parseEvents([{ ...event, resolution: "none" }])).toBeUndefined();
  });

  it("rejects newly opened loop actors who did not author a cited source message", () => {
    const event = {
      ...disclosureEvent(),
      kind: "promise",
      fact: null,
      sourceMessageIds: ["message-2"],
      resolution: "unresolved",
      openLoop: {
        kind: "follow_up",
        status: "opened",
        existingOpenLoopId: null,
        responsibleParticipantId: "resident-juno",
        counterpartParticipantIds: ["human-johan"],
        summary: "Juno intends to ask how the first day went.",
      },
      views: [{
        ownerResidentId: "resident-juno",
        perspective: "I offered to follow up later.",
        appraisal: { targetParticipantId: null, outcome: "neutral", effects: [], confidence: 0.9 },
      }],
    };
    expect(parseEvents([event])).toBeUndefined();
  });

  it("requires continued and resolved loops to preserve known kind and participants", () => {
    const event = {
      ...disclosureEvent(),
      kind: "milestone",
      fact: null,
      resolution: "resolved",
      openLoop: {
        kind: "follow_up",
        status: "resolved",
        existingOpenLoopId: "loop-1",
        responsibleParticipantId: "resident-juno",
        counterpartParticipantIds: ["human-johan"],
        summary: "The promised follow-up happened.",
      },
    };
    expect(parseEvents([event])).toBeDefined();
    expect(parseEvents([{ ...event, openLoop: { ...event.openLoop, kind: "promise" } }])).toBeUndefined();
    expect(parseEvents([{
      ...event,
      openLoop: { ...event.openLoop, counterpartParticipantIds: ["resident-juno"] },
    }])).toBeUndefined();
  });

  it("rejects continued or resolved loop actors that are known but absent from cited sources", () => {
    const event = {
      ...disclosureEvent(),
      kind: "milestone",
      fact: null,
      sourceMessageIds: ["message-2"],
      resolution: "resolved",
      openLoop: {
        kind: "follow_up",
        status: "resolved",
        existingOpenLoopId: "loop-1",
        responsibleParticipantId: "resident-juno",
        counterpartParticipantIds: ["human-johan"],
        summary: "The promised follow-up happened.",
      },
      views: [{
        ownerResidentId: "resident-juno",
        perspective: "I followed up on what I had promised.",
        appraisal: { targetParticipantId: null, outcome: "neutral", effects: [], confidence: 0.9 },
      }],
    };
    expect(parseEvents([event])).toBeUndefined();
  });

  it("does not ground an appraisal target merely by listing it as an open-loop actor", () => {
    const event = {
      ...disclosureEvent(),
      kind: "promise",
      fact: null,
      sourceMessageIds: ["message-2"],
      resolution: "unresolved",
      openLoop: {
        kind: "follow_up",
        status: "opened",
        existingOpenLoopId: null,
        responsibleParticipantId: "resident-juno",
        counterpartParticipantIds: ["human-johan"],
        summary: "Juno intends to ask Johan about his first day.",
      },
      views: [{
        ownerResidentId: "resident-juno",
        perspective: "I offered to follow up later.",
        appraisal: {
          targetParticipantId: "human-johan",
          outcome: "positive",
          effects: ["warmth_up"],
          confidence: 0.9,
        },
      }],
    };
    expect(parseEvents([event])).toBeUndefined();
  });

  it("returns an explicit empty fail-closed result for provider failures", () => {
    expect(createFailClosedSocialMemoryAnalysis("invalid_output")).toEqual({
      source: "fallback",
      failureReason: "invalid_output",
      events: [],
    });
  });
});
