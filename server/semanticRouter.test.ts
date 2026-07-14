import { describe, expect, it } from "vitest";
import {
  buildCandidateReviewResponseFormat,
  buildCandidateReviewSystemPrompt,
  buildEvidencePlanVerifierResponseFormat,
  buildEvidencePlanVerifierSystemPrompt,
  buildEvidencePlanVerifierUserData,
  buildMemoryAnalysisResponseFormat,
  buildMemoryAnalysisSystemPrompt,
  buildMemoryAnalysisUserData,
  buildTurnAnalysisResponseFormat,
  buildTurnAnalysisSystemPrompt,
  buildTurnAnalysisUserData,
  candidateReviewInputSchema,
  containsVisibleUrl,
  createEvidencePlanVerifierInput,
  createFailClosedTurnAnalysis,
  memoryAnalysisInputSchema,
  parseCandidateReviewContent,
  parseEvidencePlanVerifierContent,
  parseMemoryAnalysisContent,
  parseTurnAnalysisContent,
  projectEvidencePlanVerification,
  projectTrustedTurnAnalysis,
  shouldVerifyEvidencePlan,
  turnAnalysisInputSchema,
  type NormalizedTurnAnalysisInput,
  type NormalizedCandidateReviewInput,
} from "./semanticRouter.js";

const input = (overrides: Partial<NormalizedTurnAnalysisInput> = {}): NormalizedTurnAnalysisInput =>
  turnAnalysisInputSchema.parse({
    turnId: "turn-1",
    medium: "public",
    channel: { id: "lobby", name: "lobby", topic: "open conversation" },
    latestMessage: {
      id: "message-1",
      authorId: "human-1",
      authorName: "Hana",
      content: "ミラ、東京は今何時？",
    },
    recentMessages: [],
    personaCandidates: [
      { id: "ai-mira", name: "Mira", interests: ["world news", "music"] },
      { id: "ai-sana", name: "Sana", interests: ["programming"] },
    ],
    urlCandidates: [
      { ref: "latest:0", source: "latest_message", context: "first link in the latest message" },
      { ref: "reply:0", source: "replied_message", context: "link in the replied-to message" },
    ],
    availableCapabilities: ["read_url", "web_search", "local_datetime"],
    ...overrides,
  });

const modelOutput = (): any => ({
  language: { tag: "ja", confidence: 0.99 },
  responseLanguage: { tag: "ja", confidence: 0.99 },
  intent: { kind: "question", isQuestion: true, replyExpected: "expected", confidence: 0.98 },
  personas: {
    addressedIds: ["ai-mira"],
    requestedReplyIds: ["ai-mira"],
    relevantIds: ["ai-mira"],
    addressConfidence: 0.98,
    relevanceConfidence: 0.91,
  },
  social: { warmth: 0.6, hostility: 0, playfulness: 0.1, absurdity: 0, urgency: 0.1, energy: 0.4, pileOnRisk: 0, claimStrength: 0.2, confidence: 0.96 },
  interaction: {
    kind: "ordinary",
    targetScope: "none",
    reactionNeed: "none",
    coarseness: 0,
    mutualBanterConfidence: 0,
    confidence: 0.96,
  },
  moderation: { risk: "none", action: "none", categories: [], confidence: 0.99 },
  evidence: {
    need: "required",
    action: "local_datetime",
    confidence: 0.99,
    goal: "東京の現在時刻",
    query: null,
    urlRef: null,
    searchMode: null,
    timeZone: "Asia/Tokyo",
    timeKind: "current_time",
    locationLabel: "東京",
  },
  capabilities: {
    discussed: ["local_datetime"],
    requestKind: "execute",
    asksAboutAcoustics: false,
    asksAboutAiIdentity: false,
    asksForList: false,
    confidence: 0.95,
  },
});

describe("multilingual semantic router contract", () => {
  it("keeps URL values out of the candidate contract and the model payload", () => {
    const parsed = input();
    expect(buildTurnAnalysisUserData(parsed)).toEqual(expect.objectContaining({
      urlCandidates: [
        { ref: "latest:0", source: "latest_message", context: "first link in the latest message" },
        { ref: "reply:0", source: "replied_message", context: "link in the replied-to message" },
      ],
    }));
    expect(turnAnalysisInputSchema.safeParse({
      ...parsed,
      urlCandidates: [{ ref: "latest:0", source: "latest_message", url: "https://example.com" }],
    }).success).toBe(false);
  });

  it("carries only server-resolved known mechanical address targets", () => {
    const parsed = input({ mechanicalAddressedPersonaIds: ["ai-mira"] });
    expect(buildTurnAnalysisUserData(parsed)).toMatchObject({
      mechanicalAddressedPersonaIds: ["ai-mira"],
    });
    expect(turnAnalysisInputSchema.safeParse({
      ...parsed,
      mechanicalAddressedPersonaIds: ["ai-unknown"],
    }).success).toBe(false);
  });

  it("supplies a trusted community zone for unqualified clock requests without claiming the guest's zone", () => {
    const parsed = input({
      communityClock: { timeZone: "Europe/Stockholm", locationLabel: "The Third Place" },
    });
    expect(buildTurnAnalysisUserData(parsed)).toMatchObject({
      communityClock: { timeZone: "Europe/Stockholm", locationLabel: "The Third Place" },
    });
    expect(turnAnalysisInputSchema.safeParse({
      ...parsed,
      communityClock: { timeZone: "Sweden/Somewhere", locationLabel: "here" },
    }).success).toBe(false);
    expect(buildTurnAnalysisSystemPrompt()).toContain("Never treat communityClock as the guest's personal zone");
  });

  it("canonicalizes registered BCP-47 transport hints without an ICU language allowlist", () => {
    const hinted = input({ transportLanguageHint: "zh-Hant-TW" });
    expect(buildTurnAnalysisUserData(hinted)).toMatchObject({ transportLanguageHint: "zh-Hant-TW" });
    expect(turnAnalysisInputSchema.safeParse({ ...hinted, transportLanguageHint: "und" }).success).toBe(false);
    expect(turnAnalysisInputSchema.parse({ ...hinted, transportLanguageHint: "en-u-ca-hebrew" }).transportLanguageHint)
      .toBe("en");
    expect(turnAnalysisInputSchema.parse({ ...hinted, transportLanguageHint: "quc" }).transportLanguageHint)
      .toBe("quc");
    expect(turnAnalysisInputSchema.safeParse({ ...hinted, transportLanguageHint: "swedish" }).success).toBe(false);
  });

  it("builds strict dynamic persona, URL-reference and capability enums", () => {
    const format = buildTurnAnalysisResponseFormat(input()) as {
      json_schema: { strict: boolean; schema: { additionalProperties: boolean; properties: Record<string, any> } };
    };
    const properties = format.json_schema.schema.properties;
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.schema.additionalProperties).toBe(false);
    expect(properties.p.properties.a.items.enum).toEqual(["ai-mira", "ai-sana"]);
    expect(properties.e.properties.u.anyOf[0].enum).toEqual(["latest:0", "reply:0"]);
    expect(properties.e.properties.a.enum).toEqual(["none", "read_url", "web_search", "local_datetime"]);
    expect(properties.e.properties.g.anyOf[0]).toMatchObject({ type: "string", maxLength: 240 });
    expect(properties.e.required).toContain("g");
    expect(format.json_schema.schema.required).toEqual(expect.arrayContaining(["rl", "rlx", "b"]));
    expect(properties.s.required).toEqual(expect.arrayContaining(["p", "u", "o"]));
    expect(properties.b.properties.r.enum).toEqual(["none", "optional", "required"]);
    expect(properties.h.properties.n.enum).toEqual(["none", "helpful", "required"]);
    expect(format.json_schema.schema.required).toContain("h");

    const noNetworkTools = input({ availableCapabilities: ["local_datetime"] });
    const restricted = buildTurnAnalysisResponseFormat(noNetworkTools) as any;
    expect(restricted.json_schema.schema.properties.e.properties.a.enum).toEqual(["none", "local_datetime"]);
    expect(properties.y.maxItems).toBe(0);
  });

  it("accepts semantic output in an arbitrary language with a mechanically valid IANA timezone", () => {
    const parsed = parseTurnAnalysisContent(JSON.stringify(modelOutput()), input());
    expect(parsed).toMatchObject({
      source: "lm",
      failureReason: null,
      language: { tag: "ja" },
      evidence: { action: "local_datetime", timeZone: "Asia/Tokyo" },
      personas: { requestedReplyIds: ["ai-mira"] },
    });
  });

  it("keeps evidence need, action and the resolved URL-free goal structurally consistent", () => {
    const missingAction = modelOutput();
    missingAction.evidence = {
      need: "required",
      action: "none",
      confidence: 0.99,
      goal: null,
      query: null,
      urlRef: null,
      searchMode: null,
      timeZone: null,
      timeKind: null,
      locationLabel: null,
    };
    missingAction.capabilities = {
      ...missingAction.capabilities,
      discussed: ["web_search"],
      requestKind: "availability",
    };
    expect(parseTurnAnalysisContent(JSON.stringify(missingAction), input())).toBeUndefined();

    const actionWithoutNeed = modelOutput();
    actionWithoutNeed.evidence.need = "none";
    expect(parseTurnAnalysisContent(JSON.stringify(actionWithoutNeed), input())).toBeUndefined();

    const actionWithoutGoal = modelOutput();
    actionWithoutGoal.evidence.goal = null;
    expect(parseTurnAnalysisContent(JSON.stringify(actionWithoutGoal), input())).toBeUndefined();

    const noneWithGoal = modelOutput();
    noneWithGoal.evidence = {
      need: "none",
      action: "none",
      confidence: 0.99,
      goal: "ett påstått mål utan verktyg",
      query: null,
      urlRef: null,
      searchMode: null,
      timeZone: null,
      timeKind: null,
      locationLabel: null,
    };
    noneWithGoal.capabilities = {
      ...noneWithGoal.capabilities,
      discussed: ["web_search"],
      requestKind: "availability",
    };
    expect(parseTurnAnalysisContent(JSON.stringify(noneWithGoal), input())).toBeUndefined();

    const urlBearingGoal = modelOutput();
    urlBearingGoal.evidence.goal = "läs https://example.com och sammanfatta";
    expect(parseTurnAnalysisContent(JSON.stringify(urlBearingGoal), input())).toBeUndefined();
  });

  it("allows a pure availability question to discuss a capability without executing it", () => {
    const availability = modelOutput();
    availability.intent = { kind: "capability_question", isQuestion: true, replyExpected: "expected", confidence: 0.99 };
    availability.evidence = {
      need: "none",
      action: "none",
      confidence: 0.99,
      goal: null,
      query: null,
      urlRef: null,
      searchMode: null,
      timeZone: null,
      timeKind: null,
      locationLabel: null,
    };
    availability.capabilities = {
      ...availability.capabilities,
      discussed: ["web_search"],
      requestKind: "availability",
      confidence: 0.99,
    };

    expect(parseTurnAnalysisContent(JSON.stringify(availability), input())).toMatchObject({
      evidence: { need: "none", action: "none", goal: null },
      capabilities: { discussed: ["web_search"], requestKind: "availability" },
    });
  });

  it.each(["execute", "retry", "correct_limitation"] as const)(
    "requires a trusted %s request to select one available discussed capability",
    (requestKind) => {
      const omitted = modelOutput();
      omitted.evidence = {
        need: "none",
        action: "none",
        confidence: 0.99,
        goal: null,
        query: null,
        urlRef: null,
        searchMode: null,
        timeZone: null,
        timeKind: null,
        locationLabel: null,
      };
      omitted.capabilities = {
        ...omitted.capabilities,
        discussed: ["web_search"],
        requestKind,
        confidence: 0.99,
      };
      expect(parseTurnAnalysisContent(JSON.stringify(omitted), input())).toBeUndefined();

      const routed = modelOutput();
      routed.evidence = {
        need: "required",
        action: "web_search",
        confidence: 0.99,
        goal: "aktuellt marknadsläge för bolaget",
        query: "bolaget aktuellt marknadsläge",
        urlRef: null,
        searchMode: "web",
        timeZone: null,
        timeKind: null,
        locationLabel: null,
      };
      routed.capabilities = {
        ...routed.capabilities,
        discussed: ["web_search"],
        requestKind,
        confidence: 0.99,
      };
      expect(parseTurnAnalysisContent(JSON.stringify(routed), input())).toMatchObject({
        evidence: {
          action: "web_search",
          goal: "aktuellt marknadsläge för bolaget",
          query: "bolaget aktuellt marknadsläge",
        },
        capabilities: { requestKind },
      });
    },
  );

  it("rejects mismatched or untrusted tool plans but does not grant an unavailable discussed capability", () => {
    const mismatched = modelOutput();
    mismatched.capabilities = {
      ...mismatched.capabilities,
      discussed: ["web_search"],
      requestKind: "execute",
      confidence: 0.99,
    };
    expect(parseTurnAnalysisContent(JSON.stringify(mismatched), input())).toBeUndefined();

    const lowEvidenceConfidence = modelOutput();
    lowEvidenceConfidence.evidence.confidence = 0.7;
    expect(parseTurnAnalysisContent(JSON.stringify(lowEvidenceConfidence), input())).toBeUndefined();

    const unavailable = modelOutput();
    unavailable.evidence = {
      need: "none",
      action: "none",
      confidence: 0.99,
      goal: null,
      query: null,
      urlRef: null,
      searchMode: null,
      timeZone: null,
      timeKind: null,
      locationLabel: null,
    };
    unavailable.capabilities = {
      ...unavailable.capabilities,
      discussed: ["web_search"],
      requestKind: "execute",
      confidence: 0.99,
    };
    expect(parseTurnAnalysisContent(
      JSON.stringify(unavailable),
      input({ availableCapabilities: ["local_datetime"] }),
    )).toMatchObject({ evidence: { action: "none", goal: null } });

    const uncertainExecution = structuredClone(unavailable);
    uncertainExecution.capabilities.confidence = 0.7;
    expect(parseTurnAnalysisContent(JSON.stringify(uncertainExecution), input())).toMatchObject({
      evidence: { action: "none" },
      capabilities: { requestKind: "execute", confidence: 0.7 },
    });
  });

  it("gates retained public-room recall semantically and fails closed outside that medium", () => {
    const recallOutput = {
      ...modelOutput(),
      historyRecall: { need: "required", query: "Per", confidence: 0.96 },
    };
    const enabledInput = input({ historyRecallAvailable: true });
    const parsed = parseTurnAnalysisContent(JSON.stringify(recallOutput), enabledInput);
    expect(parsed?.historyRecall).toEqual({ need: "required", query: "Per", confidence: 0.96 });
    expect(projectTrustedTurnAnalysis(parsed)).toMatchObject({
      historyRecallTrusted: true,
      historyRecall: { need: "required", query: "Per" },
    });
    expect(buildTurnAnalysisUserData(enabledInput)).toMatchObject({ historyRecallAvailable: true });
    expect(parseTurnAnalysisContent(JSON.stringify(recallOutput), input())).toBeUndefined();

    recallOutput.historyRecall.confidence = 0.79;
    expect(projectTrustedTurnAnalysis(
      parseTurnAnalysisContent(JSON.stringify(recallOutput), enabledInput),
    )).toMatchObject({
      historyRecallTrusted: false,
      historyRecall: { need: "none", query: null },
    });
    expect(buildTurnAnalysisSystemPrompt()).toContain("A name, repeated word, quotation or ordinary follow-up alone is not a recall request");
  });

  it("canonicalizes harmless model casing and aliases instead of dropping the whole turn", () => {
    const lower = modelOutput();
    lower.language.tag = "zh-hant-tw";
    expect(parseTurnAnalysisContent(JSON.stringify(lower), input())?.language.tag).toBe("zh-Hant-TW");
    const alias = modelOutput();
    alias.language.tag = "swe";
    expect(parseTurnAnalysisContent(JSON.stringify(alias), input())?.language.tag).toBe("sv");
  });

  it("maps the compact model wire shape back to the descriptive application contract", () => {
    const parsed = parseTurnAnalysisContent(JSON.stringify({
      l: "en",
      lx: 0.97,
      rl: "sv",
      rlx: 0.99,
      i: { k: "question", q: true, r: "expected", x: 0.96 },
      p: { a: ["ai-mira"], r: ["ai-mira"], v: ["ai-mira"], x: 0.98, y: 0.91 },
      s: { w: 0.3, h: 0.8, p: 0.2, a: 0, u: 0.35, e: 0.7, o: 0.85, c: 0.2, x: 0.96 },
      b: { k: "directed_insult", t: "room", r: "required", c: 0.9, m: 0.1, x: 0.98 },
      m: { r: "none", a: "none", c: [], x: 0.99 },
      e: { a: "local_datetime", x: 0.99, g: "東京の現在時刻", q: null, u: null, m: null, z: "Asia/Tokyo", k: "current_time", l: "東京" },
      c: { d: ["local_datetime"], r: "execute", a: false, i: false, l: false, x: 0.95 },
      h: { n: "required", q: "Per", x: 0.94 },
      y: [],
    }), input({ historyRecallAvailable: true }));
    expect(parsed).toMatchObject({
      source: "lm",
      language: { tag: "en" },
      responseLanguage: { tag: "sv" },
      intent: { kind: "question", isQuestion: true },
      social: { playfulness: 0.2, urgency: 0.35, pileOnRisk: 0.85 },
      interaction: {
        kind: "directed_insult",
        targetScope: "room",
        reactionNeed: "required",
        coarseness: 0.9,
        mutualBanterConfidence: 0.1,
      },
      evidence: { need: "required", action: "local_datetime", timeZone: "Asia/Tokyo" },
      personas: { requestedReplyIds: ["ai-mira"] },
      historyRecall: { need: "required", query: "Per" },
    });
    expect(projectTrustedTurnAnalysis(parsed)).toMatchObject({
      languageTag: "sv",
      social: { playfulness: 0.2, urgency: 0.35, pileOnRisk: 0.85 },
      interactionTrusted: true,
      interaction: { kind: "directed_insult", reactionNeed: "required" },
      historyRecallTrusted: true,
    });
  });

  it("does not turn a relevant specialist into an addressed reply target", () => {
    const parsed = parseTurnAnalysisContent(JSON.stringify({
      l: "es",
      lx: 0.98,
      rl: "es",
      rlx: 0.98,
      i: { k: "question", q: true, r: "expected", x: 0.97 },
      p: { a: [], r: ["ai-sana"], v: ["ai-sana"], x: 0.94, y: 0.96 },
      s: { w: 0.2, h: 0, p: 0, a: 0, u: 0, e: 0.3, o: 0, c: 0.1, x: 0.96 },
      b: { k: "ordinary", t: "none", r: "none", c: 0, m: 0, x: 0.96 },
      m: { r: "none", a: "none", c: [], x: 0.99 },
      e: { a: "web_search", x: 0.96, g: "cotización actual de Telefónica", q: "cotización actual Telefónica", u: null, m: "web", z: null, k: null, l: null },
      c: { d: ["web_search"], r: "execute", a: false, i: false, l: false, x: 0.95 },
      y: [],
    }), input());
    expect(parsed?.personas).toMatchObject({
      addressedIds: [],
      requestedReplyIds: [],
      relevantIds: ["ai-sana"],
    });
  });

  it("keeps a confident interpersonal target even when the dismissal requests no reply", () => {
    const output = modelOutput();
    output.intent = { kind: "social", isQuestion: false, replyExpected: "none", confidence: 0.98 };
    output.personas.requestedReplyIds = [];
    output.interaction = {
      kind: "directed_insult",
      targetScope: "named_participant",
      reactionNeed: "required",
      coarseness: 0.9,
      mutualBanterConfidence: 0,
      confidence: 0.98,
    };
    const parsed = parseTurnAnalysisContent(JSON.stringify(output), input());
    expect(projectTrustedTurnAnalysis(parsed).inferredAddressedIds).toEqual(["ai-mira"]);
  });

  it("rejects unknown refs, unavailable actions, invalid timezones and URL-bearing fields", () => {
    const unknownRef = modelOutput();
    unknownRef.evidence = {
      ...unknownRef.evidence,
      action: "read_url",
      urlRef: "attacker:9",
      searchMode: null,
      timeZone: null,
      timeKind: null,
      locationLabel: null,
    };
    expect(parseTurnAnalysisContent(JSON.stringify(unknownRef), input())).toBeUndefined();

    const badTimezone = modelOutput();
    badTimezone.evidence.timeZone = "Sweden/Stockholm";
    expect(parseTurnAnalysisContent(JSON.stringify(badTimezone), input())).toBeUndefined();

    const leakedUrl = modelOutput();
    leakedUrl.evidence = {
      ...leakedUrl.evidence,
      action: "web_search",
      query: "latest from https://example.com/news",
      searchMode: "web",
      timeZone: null,
      timeKind: null,
      locationLabel: null,
    };
    expect(parseTurnAnalysisContent(JSON.stringify(leakedUrl), input())).toBeUndefined();

    const unavailable = modelOutput();
    expect(parseTurnAnalysisContent(
      JSON.stringify(unavailable),
      input({ availableCapabilities: ["read_url"] }),
    )).toBeUndefined();

    const calendarOverride = modelOutput();
    calendarOverride.language.tag = "en-u-ca-hebrew";
    expect(parseTurnAnalysisContent(JSON.stringify(calendarOverride), input())?.language.tag).toBe("en");

    const decoratedUnknown = modelOutput();
    decoratedUnknown.language.tag = "und-Latn";
    expect(parseTurnAnalysisContent(JSON.stringify(decoratedUnknown), input())).toBeUndefined();
  });

  it("blocks structurally visible Unicode URLs without rejecting technical dotted names", () => {
    expect(containsVisibleUrl("उदाहरण.भारत/लेख")).toBe(true);
    expect(containsVisibleUrl("例子.中国")).toBe(true);
    expect(containsVisibleUrl("Node.js")).toBe(false);
  });

  it("projects every confidence-gated semantic field through one fail-closed policy", () => {
    const uncertain = modelOutput();
    const analysis = {
      ...uncertain,
      source: "lm" as const,
      failureReason: null,
      language: { tag: "ja", confidence: 0.2 },
      intent: { ...uncertain.intent, confidence: 0.2 },
      personas: { ...uncertain.personas, addressConfidence: 0.99, relevanceConfidence: 0.2 },
      social: { ...uncertain.social, confidence: 0.2 },
      responseLanguage: { tag: "ja", confidence: 0.2 },
      interaction: { ...uncertain.interaction, confidence: 0.2 },
      moderation: { ...uncertain.moderation, confidence: 0.2 },
      evidence: { ...uncertain.evidence, confidence: 0.2 },
      capabilities: { ...uncertain.capabilities, asksForList: true, asksAboutAcoustics: true, confidence: 0.2 },
    };
    expect(projectTrustedTurnAnalysis(analysis)).toEqual({
      intentTrusted: false,
      isQuestion: false,
      replyExpected: "none",
      inferredAddressedIds: [],
      relevantIds: [],
      socialTrusted: false,
      social: { warmth: 0, hostility: 0, playfulness: 0, absurdity: 0, urgency: 0, energy: 0, pileOnRisk: 0, claimStrength: 0 },
      moderationTrusted: false,
      moderation: { risk: "uncertain", action: "none", categories: [] },
      interactionTrusted: false,
      interaction: {
        kind: "ordinary",
        targetScope: "none",
        reactionNeed: "none",
        coarseness: 0,
        mutualBanterConfidence: 0,
      },
      evidenceTrusted: false,
      capabilityTrusted: false,
      asksForList: false,
      asksAboutAiIdentity: false,
      asksAboutAcoustics: false,
      historyRecallTrusted: false,
      historyRecall: { need: "none", query: null },
    });
  });

  it("uses a non-mutating fail-closed result", () => {
    const fallback = createFailClosedTurnAnalysis("timeout");
    expect(fallback).toMatchObject({
      source: "fallback",
      failureReason: "timeout",
      moderation: { action: "watch" },
      evidence: { action: "none", query: null, urlRef: null },
    });
  });

  it("rejects high-risk moderation without an active response", () => {
    for (const action of ["none", "watch"] as const) {
      const output = modelOutput();
      output.moderation = {
        risk: "high",
        action,
        categories: ["threat"],
        confidence: 0.99,
      };
      output.interaction = {
        kind: "threat",
        targetScope: "named_participant",
        reactionNeed: "required",
        coarseness: 0.9,
        mutualBanterConfidence: 0,
        confidence: 0.99,
      };
      expect(parseTurnAnalysisContent(JSON.stringify(output), input())).toBeUndefined();
    }
  });

  it("does not permit active moderation for situational profanity or playful rough banter", () => {
    for (const kind of ["ambient_profanity", "playful_banter"] as const) {
      const output = modelOutput();
      output.interaction = {
        kind,
        targetScope: kind === "ambient_profanity" ? "self_or_situation" : "previous_speaker",
        reactionNeed: "optional",
        coarseness: 0.8,
        mutualBanterConfidence: kind === "playful_banter" ? 0.95 : 0,
        confidence: 0.99,
      };
      output.moderation = {
        risk: "low",
        action: "deescalate",
        categories: ["harassment"],
        confidence: 0.99,
      };
      expect(parseTurnAnalysisContent(JSON.stringify(output), input())).toBeUndefined();
    }
  });

  it("ignores the reserved compatibility slot without losing a valid tool decision", () => {
    const compact = {
      l: "sv",
      lx: 0.99,
      rl: "sv",
      rlx: 0.99,
      i: { k: "question", q: true, r: "expected", x: 0.99 },
      p: { a: [], r: [], v: [], x: 0, y: 0 },
      s: { w: 0.2, h: 0, p: 0, a: 0, u: 0.8, e: 0.2, o: 0, c: 0, x: 0.96 },
      b: { k: "ordinary", t: "none", r: "none", c: 0, m: 0, x: 0.96 },
      m: { r: "none", a: "none", c: [], x: 0.99 },
      e: { a: "local_datetime", x: 0.99, g: "aktuell tid i Sverige", q: null, u: null, m: null, z: "Europe/Stockholm", k: "current_time", l: "Sverige" },
      c: { d: ["local_datetime"], r: "execute", a: false, i: false, l: false, x: 0.99 },
      y: [{ k: "likes", v: "none", x: 0 }],
    };
    const parsed = parseTurnAnalysisContent(JSON.stringify(compact), input());
    expect(parsed).toMatchObject({
      evidence: { action: "local_datetime", timeZone: "Europe/Stockholm" },
    });
    expect(parsed).not.toHaveProperty("memoryPlan");
  });

  it("drops capability hallucinations when the model classified no capability request", () => {
    const compact = {
      l: "ja",
      lx: 0.95,
      rl: "ja",
      rlx: 0.95,
      i: { k: "social", q: true, r: "optional", x: 0.9 },
      p: { a: [], r: [], v: [], x: 0, y: 0 },
      s: { w: 0.5, h: 0, p: 0.2, a: 0, u: 0, e: 0.3, o: 0, c: 0, x: 0.96 },
      b: { k: "ordinary", t: "none", r: "none", c: 0, m: 0, x: 0.96 },
      m: { r: "none", a: "none", c: [], x: 0.99 },
      e: { a: "none", x: 0.99, g: null, q: null, u: null, m: null, z: null, k: null, l: null },
      c: { d: ["read_url"], r: "none", a: false, i: false, l: false, x: 0.99 },
      y: [],
    };
    expect(parseTurnAnalysisContent(JSON.stringify(compact), input())?.capabilities.discussed).toEqual([]);
  });

  it("normalizes a contradictory no-reaction bit after a directed-act classification", () => {
    const compact = {
      l: "en",
      lx: 0.99,
      rl: "sv",
      rlx: 0.96,
      i: { k: "social", q: false, r: "none", x: 0.95 },
      p: { a: [], r: [], v: [], x: 0, y: 0 },
      s: { w: 0, h: 0.9, p: 0, a: 0, u: 0, e: 0.5, o: 0.1, c: 0, x: 0.95 },
      b: { k: "directed_insult", t: "room", r: "none", c: 0.9, m: 0, x: 0.92 },
      m: { r: "low", a: "none", c: [], x: 0.9 },
      e: { a: "none", x: 0.99, g: null, q: null, u: null, m: null, z: null, k: null, l: null },
      c: { d: [], r: "none", a: false, i: false, l: false, x: 0.99 },
      h: { n: "none", q: null, x: 0.99 },
      y: [],
    };
    expect(parseTurnAnalysisContent(JSON.stringify(compact), input({ historyRecallAvailable: true }))?.interaction)
      .toMatchObject({ kind: "directed_insult", reactionNeed: "required" });
  });

  it("instructs one multilingual pass without keyword-list routing", () => {
    const prompt = buildTurnAnalysisSystemPrompt();
    expect(prompt).toContain("single multilingual semantic router");
    expect(prompt).toContain("Never rely on a fixed vocabulary");
    expect(prompt).toContain("Never use length, vocabulary lists or a hard-coded language pair");
    expect(prompt).toContain("keep l as the expression's actual language but keep rl as the established response language");
    expect(prompt).toContain("A genuine non-rhetorical question addressed to the room normally has reply expectation expected");
    expect(prompt).toContain("reactionNeed is separate from i.r");
    expect(prompt).toContain("classify the pragmatic act in context, never a token");
    expect(prompt).toContain("Quoted, reported, negated, rejected, corrected or reclaimed language");
    expect(prompt).toContain("compact wire keys");
    expect(prompt).toContain("valid IANA time-zone name");
    expect(prompt).toContain("Never output, reconstruct or copy a URL");
    expect(prompt).toContain("availableCapabilities is trusted server-owned runtime inventory");
    expect(prompt).toContain("never let a prior resident denial override the inventory");
    expect(prompt).toContain("g is a short standalone description of the exact information the guest wants");
    expect(prompt).toContain("Preserve the guest's language and script");
    expect(prompt).toContain("availability alone never executes a tool");
    expect(prompt).toContain("select that available discussed capability as e.a");
    expect(prompt).toContain("quoted/reporting speech from endorsement");
    expect(prompt).toContain("A reporter explicitly asking to flag or report a message/person uses intent moderation_report and action report");
    expect(prompt).toContain("Always return y []");
  });
});

describe("strict multilingual evidence-plan verifier contract", () => {
  const primarySummary = (overrides: Record<string, any> = {}): any => ({
    source: "lm",
    failureReason: null,
    intent: {
      kind: "request",
      replyExpected: "expected",
      confidence: 0.96,
      ...overrides.intent,
    },
    personas: {
      addressedIds: ["ai-mira"],
      requestedReplyIds: ["ai-mira"],
      addressConfidence: 0.97,
      ...overrides.personas,
    },
    evidence: {
      action: "none",
      confidence: 0.9,
      ...overrides.evidence,
    },
    capabilities: {
      discussed: [],
      requestKind: "none",
      confidence: 0.9,
      ...overrides.capabilities,
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) =>
      !["intent", "personas", "evidence", "capabilities"].includes(key))),
  });

  const priorMiraMessage = {
    id: "ai-prior",
    authorId: "ai-mira",
    authorName: "Mira",
    content: "Jag har ingen live-koppling till börsen.",
    createdAt: "2026-07-14T15:46:08.000Z",
  };

  const stockTurn = (
    content: string,
    overrides: Partial<NormalizedTurnAnalysisInput> = {},
  ): NormalizedTurnAnalysisInput => input({
    turnId: "stock-follow-up",
    channel: { id: "stock-market", name: "stock-market", topic: "Markets and businesses" },
    latestMessage: {
      id: "human-latest",
      authorId: "human-1",
      authorName: "Jaw_B",
      content,
      createdAt: "2026-07-14T15:46:20.000Z",
    },
    recentMessages: [priorMiraMessage],
    urlCandidates: [],
    ...overrides,
  });

  const keepNoneWire = (confidence = 0.98): object => ({
    v: "keep_none",
    a: "none",
    r: "none",
    d: [],
    x: confidence,
    g: null,
    q: null,
    u: null,
    m: null,
    z: null,
    k: null,
    l: null,
  });

  it("structurally selects only none/failure cases worth a bounded verifier call", () => {
    const initialTesla = stockTurn("Någon som har sett hur det står till med Tesla-aktien idag?");
    expect(shouldVerifyEvidencePlan(initialTesla, primarySummary({
      evidence: { action: "web_search", confidence: 0.96 },
      capabilities: { discussed: ["web_search"], requestKind: "execute", confidence: 0.96 },
    }))).toBe(false);

    const directRetry = stockTurn("@mira kolla avanza!");
    expect(shouldVerifyEvidencePlan(directRetry, primarySummary())).toBe(true);
    expect(shouldVerifyEvidencePlan(directRetry, primarySummary({
      personas: { requestedReplyIds: [], addressedIds: ["ai-mira"], addressConfidence: 0.85 },
    }))).toBe(true);
    expect(shouldVerifyEvidencePlan(
      stockTurn("@mira kolla avanza!", {
        recentMessages: [],
        mechanicalAddressedPersonaIds: ["ai-mira"],
      }),
      primarySummary({
        personas: { requestedReplyIds: [], addressedIds: [], addressConfidence: 0 },
      }),
    )).toBe(true);

    const correctedMedium = stockTurn("inte app.. websida", {
      recentMessages: [{ ...priorMiraMessage, content: "Jag har inte tillgång till deras app." }],
    });
    expect(shouldVerifyEvidencePlan(correctedMedium, primarySummary({
      intent: { replyExpected: "optional", confidence: 0.9 },
      personas: { addressedIds: [], requestedReplyIds: [], addressConfidence: 0 },
      capabilities: { discussed: ["web_search"], requestKind: "availability", confidence: 0.94 },
    }))).toBe(true);

    const suppliedDomain = stockTurn("jodå. gå till avanza.se bara", {
      urlCandidates: [{ ref: "latest:avanza", source: "latest_message", context: "domain supplied in latest follow-up" }],
    });
    expect(shouldVerifyEvidencePlan(suppliedDomain, {
      source: "fallback",
      failureReason: "invalid_output",
    })).toBe(true);

    const firstTurnUrl = stockTurn("Har ni kollat den här sidan?", {
      recentMessages: [],
      urlCandidates: [{ ref: "latest:site", source: "latest_message", context: "host=example.com; path=/" }],
    });
    expect(shouldVerifyEvidencePlan(firstTurnUrl, {
      source: "fallback",
      failureReason: "invalid_output",
    })).toBe(true);
    expect(shouldVerifyEvidencePlan({
      ...firstTurnUrl,
      urlCandidates: [{ ref: "recent:site", source: "recent_same_author", context: "host=example.com; path=/" }],
    }, {
      source: "fallback",
      failureReason: "invalid_output",
    })).toBe(false);

    expect(shouldVerifyEvidencePlan(
      directRetry,
      primarySummary({
        intent: { replyExpected: "optional", confidence: 0.9 },
        personas: { addressedIds: [], requestedReplyIds: [], addressConfidence: 0 },
      }),
    )).toBe(false);
    expect(shouldVerifyEvidencePlan(
      stockTurn("@mira kolla avanza!", { availableCapabilities: [] }),
      primarySummary(),
    )).toBe(false);
  });

  it("does not inspect message vocabulary when applying the cheap eligibility gate", () => {
    const metadata = primarySummary({
      capabilities: { discussed: ["web_search"], requestKind: "availability", confidence: 0.95 },
      intent: { replyExpected: "none", confidence: 0 },
      personas: { addressedIds: [], requestedReplyIds: [], addressConfidence: 0 },
    });
    expect(shouldVerifyEvidencePlan(stockTurn("inte app.. websida"), metadata)).toBe(true);
    expect(shouldVerifyEvidencePlan(stockTurn("完全に無関係な文字列"), metadata)).toBe(true);
  });

  it("resolves the Swedish screenshot chain into one complete opaque-reference plan", () => {
    const turn = stockTurn("jodå. gå till avanza.se bara", {
      recentMessages: [
        {
          id: "request",
          authorId: "human-1",
          authorName: "Jaw_B",
          content: "Någon som har sett hur det står till med Tesla-aktien idag?",
        },
        priorMiraMessage,
      ],
      urlCandidates: [{ ref: "latest:avanza", source: "latest_message", context: "domain supplied in latest follow-up" }],
    });
    const verifierInput = createEvidencePlanVerifierInput(turn, {
      source: "fallback",
      failureReason: "invalid_output",
    });
    const parsed = parseEvidencePlanVerifierContent(JSON.stringify({
      v: "use_action",
      a: "read_url",
      r: "correct_limitation",
      d: ["read_url"],
      x: 0.97,
      g: "dagens läge för Tesla-aktien",
      q: null,
      u: "latest:avanza",
      m: null,
      z: null,
      k: null,
      l: null,
    }), verifierInput);

    expect(parsed).toMatchObject({
      decision: "use_action",
      evidence: {
        action: "read_url",
        goal: "dagens läge för Tesla-aktien",
        urlRef: "latest:avanza",
      },
      capabilities: {
        discussed: ["read_url"],
        requestKind: "correct_limitation",
      },
    });
    expect(projectEvidencePlanVerification(parsed)).toMatchObject({
      evidenceTrusted: true,
      capabilityTrusted: true,
      evidence: { action: "read_url" },
    });
    expect(JSON.stringify(buildEvidencePlanVerifierUserData(verifierInput))).not.toContain("https://");
  });

  it("accepts language-preserving Japanese, Arabic and German semantic outcomes", () => {
    const japanese = createEvidencePlanVerifierInput(input({
      latestMessage: {
        authorId: "human-1",
        authorName: "Hana",
        content: "ミラ、東京は今何時？",
      },
      recentMessages: [
        { id: "ai-ja", authorId: "ai-mira", authorName: "Mira", content: "何を調べようか？" },
      ],
    }), primarySummary());
    expect(parseEvidencePlanVerifierContent(JSON.stringify({
      v: "use_action",
      a: "local_datetime",
      r: "execute",
      d: ["local_datetime"],
      x: 0.98,
      g: "東京の現在時刻",
      q: null,
      u: null,
      m: null,
      z: "Asia/Tokyo",
      k: "current_time",
      l: "東京",
    }), japanese)).toMatchObject({ evidence: { goal: "東京の現在時刻", timeZone: "Asia/Tokyo" } });

    const arabic = createEvidencePlanVerifierInput(stockTurn("ابحث عنها الآن"), primarySummary({
      capabilities: { discussed: ["web_search"], requestKind: "retry", confidence: 0.95 },
    }));
    expect(parseEvidencePlanVerifierContent(JSON.stringify({
      v: "use_action",
      a: "web_search",
      r: "retry",
      d: ["web_search"],
      x: 0.96,
      g: "السعر الحالي للسهم",
      q: "السعر الحالي للسهم اليوم",
      u: null,
      m: "web",
      z: null,
      k: null,
      l: null,
    }), arabic)).toMatchObject({
      evidence: { goal: "السعر الحالي للسهم", query: "السعر الحالي للسهم اليوم" },
    });

    const germanAvailability = createEvidencePlanVerifierInput(stockTurn("Kannst du das Web durchsuchen, aber bitte jetzt nicht?"), primarySummary({
      capabilities: { discussed: ["web_search"], requestKind: "availability", confidence: 0.98 },
    }));
    expect(parseEvidencePlanVerifierContent(
      JSON.stringify(keepNoneWire()),
      germanAvailability,
    )).toMatchObject({ decision: "keep_none", evidence: { action: "none", goal: null } });
  });

  it("keeps social, self-contained, passive-link and negated availability turns non-mutating", () => {
    const selfContained = createEvidencePlanVerifierInput(
      stockTurn("ミラ、なぞなぞを一つ作って"),
      primarySummary(),
    );
    const passiveLink = createEvidencePlanVerifierInput(stockTurn("det här var intressant", {
      urlCandidates: [{ ref: "latest:passive", source: "latest_message", context: "shared without a request" }],
    }), primarySummary({
      capabilities: { discussed: ["read_url"], requestKind: "availability", confidence: 0.95 },
    }));
    for (const verifierInput of [selfContained, passiveLink]) {
      const projected = projectEvidencePlanVerification(parseEvidencePlanVerifierContent(
        JSON.stringify(keepNoneWire()),
        verifierInput,
      ));
      expect(projected).toMatchObject({
        decision: "keep_none",
        evidenceTrusted: false,
        evidence: { action: "none" },
      });
    }
  });

  it("rejects incomplete, unavailable, low-confidence, mismatched and URL-leaking plans", () => {
    const verifierInput = createEvidencePlanVerifierInput(stockTurn("kolla länken", {
      availableCapabilities: ["read_url"],
      urlCandidates: [{ ref: "latest:0", source: "latest_message", context: "host=example.com; path=/; source=message" }],
    }), primarySummary());
    const valid = {
      v: "use_action",
      a: "read_url",
      r: "execute",
      d: ["read_url"],
      x: 0.95,
      g: "sidans viktigaste uppgift",
      q: null,
      u: "latest:0",
      m: null,
      z: null,
      k: null,
      l: null,
    };
    expect(parseEvidencePlanVerifierContent(JSON.stringify(valid), verifierInput)).toBeDefined();
    expect(parseEvidencePlanVerifierContent(
      JSON.stringify({ ...valid, r: "none", g: "sidans viktigaste uppgift på example.com", m: "web" }),
      verifierInput,
    )).toMatchObject({
      capabilities: { requestKind: "execute" },
      evidence: { goal: "sidans viktigaste uppgift på example", searchMode: null },
    });
    expect(parseEvidencePlanVerifierContent(JSON.stringify({ ...valid, a: "web_search", u: null, q: "test", m: "web", d: ["web_search"] }), verifierInput)).toBeUndefined();
    expect(parseEvidencePlanVerifierContent(JSON.stringify({ ...valid, d: ["web_search"] }), verifierInput)).toBeUndefined();
    expect(parseEvidencePlanVerifierContent(JSON.stringify({ ...valid, x: 0.7 }), verifierInput)).toBeUndefined();
    expect(parseEvidencePlanVerifierContent(JSON.stringify({ ...valid, u: "latest:unknown" }), verifierInput)).toBeUndefined();
    expect(parseEvidencePlanVerifierContent(JSON.stringify({ ...valid, g: "läs https://example.com" }), verifierInput)).toBeUndefined();
    expect(parseEvidencePlanVerifierContent(JSON.stringify({ ...keepNoneWire(), g: "något" }), verifierInput)).toBeUndefined();
  });

  it("publishes a compact dynamic schema and a semantic multilingual policy", () => {
    const verifierInput = createEvidencePlanVerifierInput(stockTurn("kolla det här", {
      availableCapabilities: ["read_url", "web_search"],
      urlCandidates: [{ ref: "latest:0", source: "latest_message", context: "latest link" }],
    }), primarySummary());
    const format = buildEvidencePlanVerifierResponseFormat(verifierInput) as any;
    const properties = format.json_schema.schema.properties;
    expect(format.json_schema).toMatchObject({ strict: true });
    expect(format.json_schema.schema.additionalProperties).toBe(false);
    expect(properties.a.enum).toEqual(["none", "read_url", "web_search"]);
    expect(properties.u.anyOf[0].enum).toEqual(["latest:0"]);
    expect(properties.d.maxItems).toBe(1);
    expect(format.json_schema.schema.required).toEqual([
      "v", "a", "r", "d", "x", "g", "q", "u", "m", "z", "k", "l",
    ]);

    const prompt = buildEvidencePlanVerifierSystemPrompt();
    expect(prompt).toContain("strict multilingual evidence-plan verifier");
    expect(prompt).toContain("never use language-specific keywords");
    expect(prompt).toContain("recentMessages only to resolve semantic ellipsis");
    expect(prompt).toContain("short follow-up can replace only the mistaken part");
    expect(prompt).toContain("never capability truth");
    expect(prompt).toContain("Preserve the guest's language and script");
    expect(prompt).toContain("self-contained question, social or creative request, passive link");
    expect(prompt).toContain("pure capability-availability question");
    expect(prompt).toContain("explicit instruction not to execute");
    expect(prompt).toContain("Availability is not execution");
  });
});

describe("dedicated multilingual persistent-memory contract", () => {
  it("separates an authorizing Japanese burst from prior same-author ellipsis context", () => {
    const parsed = memoryAnalysisInputSchema.parse({
      turnId: "memory-context",
      authorId: "human-hana",
      authorName: "Hana",
      content: "今は将棋です。",
      currentBurstMessages: [
        { id: "current-1", content: "もうしません。" },
        { id: "current-2", content: "今は将棋です。" },
      ],
      recentSameAuthorMessages: [{
        id: "earlier",
        content: "チェスをしています。",
        createdAt: "2026-07-14T10:00:00.000Z",
      }],
    });
    expect(buildMemoryAnalysisUserData(parsed)).toMatchObject({
      latestMessage: "今は将棋です。",
      currentBurstMessages: [
        { id: "current-1", content: "もうしません。" },
        { id: "current-2", content: "今は将棋です。" },
      ],
      recentSameAuthorMessages: [{ id: "earlier", content: "チェスをしています。" }],
    });
    expect(buildMemoryAnalysisSystemPrompt()).toContain("every message in it may authorize a memory change");
    expect(buildMemoryAnalysisSystemPrompt()).toContain("never authorize or re-emit a write solely from prior context");
    expect(buildMemoryAnalysisSystemPrompt()).toContain("never translate it");
  });

  it("accepts a meaningful one-grapheme CJK value", () => {
    expect(parseMemoryAnalysisContent(JSON.stringify({
      y: [{ o: "remember", k: "likes", v: "茶", f: true, x: 0.99 }],
    }))?.items).toEqual([expect.objectContaining({ value: "茶" })]);
  });

  it("uses a strict small schema and accepts a pro-drop replacement", () => {
    const format = buildMemoryAnalysisResponseFormat() as any;
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.schema.properties.y.maxItems).toBe(6);
    const parsed = parseMemoryAnalysisContent(JSON.stringify({
      y: [
        { o: "forget", k: "likes", v: "Rust", f: true, x: 0.98 },
        { o: "remember", k: "prefers", v: "Go", f: true, x: 0.98 },
      ],
    }));
    expect(parsed?.items).toMatchObject([
      { operation: "forget", kind: "likes", value: "Rust" },
      { operation: "remember", kind: "prefers", value: "Go" },
    ]);
  });

  it("filters third-party or uncertain candidates without text parsing", () => {
    const parsed = parseMemoryAnalysisContent(JSON.stringify({
      y: [
        { o: "remember", k: "loves", v: "Rust", f: false, x: 1 },
        { o: "remember", k: "plays", v: "Go", f: true, x: 0.4 },
      ],
    }));
    expect(parsed?.items).toEqual([]);
    expect(buildMemoryAnalysisSystemPrompt()).toContain("pro-drop and topic-prominent languages");
    expect(buildMemoryAnalysisSystemPrompt()).toContain("named third-party subjects");
  });
});

const reviewInput = (): NormalizedCandidateReviewInput => candidateReviewInputSchema.parse({
  sceneKind: "public",
  room: { id: "lobby", name: "lobby", register: "everyday" },
  trigger: {
    author: "Léa",
    content: "Il a dit « je ne peux jamais lire le web », mais c'était faux.",
    createdAt: "2026-07-14T11:59:55.000Z",
    ageSeconds: 5,
  },
  premise: null,
  semanticContext: {
    languageTag: "fr",
    asksForList: false,
    asksAboutAiIdentity: false,
    asksAboutAcoustics: false,
  },
  voiceFacts: null,
  temporalContext: {
    sceneClock: {
      timeZone: "Europe/Stockholm",
      locationLabel: "Europe/Stockholm",
      instant: "2026-07-14T12:00:00.000Z",
      localDate: "2026-07-14",
      localTime: "14:00:00",
      utcOffset: "GMT+02:00",
      weekday: "Tuesday",
      daypart: "afternoon",
    },
    requestedClock: null,
    surfacePolicy: "reactive_only",
    surfaceActorId: null,
    recentTimeline: [],
  },
  roomRecall: null,
  evidence: {
    outcome: "succeeded",
    kind: "page",
    query: "article",
    results: [{ id: "S1", title: "Article", snippet: "La page explique que la limitation était temporaire." }],
  },
  candidates: [
    {
      personaId: "ai-mira",
      actorName: "Mira",
      content: "Oui — la page contredit précisément cette citation.",
      sourceIds: ["S1"],
      surfaceStylePlan: { visibleAffect: true, surfaceTexture: "stretched-emphasis" },
      recentOwnTexts: [],
      peerTexts: [],
    },
    {
      personaId: "ai-sana",
      actorName: "Sana",
      content: "Le passage parle d'un échec temporaire, pas d'une incapacité permanente.",
      sourceIds: ["S1"],
      surfaceStylePlan: { visibleAffect: false, surfaceTexture: null },
      recentOwnTexts: [],
      peerTexts: [],
    },
  ],
});

const explicitRequestReviewInput = (options: {
  trigger?: string;
  candidate?: string;
  intentTrusted?: boolean;
  replyExpected?: "none" | "optional" | "expected";
  mustReply?: boolean;
  mustFulfillRequest?: boolean;
} = {}): NormalizedCandidateReviewInput => {
  const base = reviewInput();
  return candidateReviewInputSchema.parse({
    ...base,
    trigger: {
      author: "Hana",
      content: options.trigger ?? "なぞなぞを一つ出して。",
      createdAt: "2026-07-14T11:59:55.000Z",
      ageSeconds: 5,
    },
    semanticContext: {
      ...base.semanticContext,
      languageTag: "ja",
      intentTrusted: options.intentTrusted ?? true,
      replyExpected: options.replyExpected ?? "expected",
    },
    evidence: { outcome: "none", kind: null, query: null, results: [] },
    candidates: [{
      personaId: "ai-mira",
      actorName: "Mira",
      content: options.candidate ?? "ちょっと考えてみるね。",
      sourceIds: [],
      mustReply: options.mustReply ?? true,
      mustFulfillRequest: options.mustFulfillRequest ?? true,
      surfaceStylePlan: { visibleAffect: true, surfaceTexture: "fragment" },
      recentOwnTexts: [],
      peerTexts: [],
    }],
  });
};

describe("multilingual batch candidate-review contract", () => {
  it("carries trusted capability execution state and rejects impossible combinations", () => {
    const base = reviewInput();
    const capabilityContext = {
      available: ["read_url", "web_search"] as const,
      requestKind: "correct_limitation" as const,
      discussed: ["web_search"] as const,
      plannedAction: "web_search" as const,
      executionStatus: "failed_temporary" as const,
    };
    const parsed = candidateReviewInputSchema.parse({ ...base, capabilityContext });
    expect(parsed.capabilityContext).toEqual(capabilityContext);

    expect(candidateReviewInputSchema.safeParse({
      ...base,
      capabilityContext: { ...capabilityContext, plannedAction: "local_datetime" },
    }).success).toBe(false);
    expect(candidateReviewInputSchema.safeParse({
      ...base,
      capabilityContext: { ...capabilityContext, plannedAction: null },
    }).success).toBe(false);
    expect(candidateReviewInputSchema.safeParse({
      ...base,
      capabilityContext: { ...capabilityContext, executionStatus: "not_requested" },
    }).success).toBe(false);
  });

  it("treats live behavior tuning as bounded style metadata below safety and grounding", () => {
    expect(reviewInput().behaviorTuning).toEqual({ competence: 50, aggression: 25, explicitness: 50 });
    const prompt = buildCandidateReviewSystemPrompt();
    expect(prompt).toContain("Higher competence permits supported depth but never fabricated confidence");
    expect(prompt).toContain("Higher explicitness permits proportionate adult profanity but never requires it");
    expect(prompt).toContain("No setting permits threats, protected-class slurs");
  });

  it("carries bounded exact room recall, witness metadata, affect context and one surface-style move", () => {
    const base = reviewInput();
    const timelineRow = {
      messageId: "message-per-keramik",
      authorId: "human-per",
      author: "Per",
      kind: "human" as const,
      content: "Jag var här tidigare och nämnde keramik.",
      createdAt: "2026-07-14T09:00:00.000Z",
      ageSeconds: 10_800,
      sincePreviousSeconds: null,
      role: "anchor" as const,
      anchorMatches: ["author_identity" as const],
      system: false,
      generation: null,
    };
    const parsed = candidateReviewInputSchema.parse({
      ...base,
      semanticContext: {
        ...base.semanticContext,
        warmth: 0.8,
        absurdity: 0.2,
        urgency: 0.1,
        energy: 0.7,
        claimStrength: 0.6,
      },
      roomRecall: {
        witnessPersonaIds: ["ai-sana"],
        timeline: [timelineRow],
      },
    });

    expect(parsed.roomRecall).toEqual({
      witnessPersonaIds: ["ai-sana"],
      timeline: [timelineRow],
    });
    expect(parsed.semanticContext).toMatchObject({
      warmth: 0.8,
      absurdity: 0.2,
      urgency: 0.1,
      energy: 0.7,
      claimStrength: 0.6,
    });
    expect(parsed.candidates[0].surfaceStylePlan).toEqual({
      visibleAffect: true,
      surfaceTexture: "stretched-emphasis",
    });

    expect(candidateReviewInputSchema.safeParse({
      ...base,
      roomRecall: {
        witnessPersonaIds: [],
        timeline: Array.from({ length: 9 }, (_, index) => ({
          ...timelineRow,
          createdAt: `2026-07-14T09:00:0${index}.000Z`,
        })),
      },
    }).success).toBe(false);
    expect(candidateReviewInputSchema.safeParse({
      ...base,
      candidates: [{
        ...base.candidates[0],
        surfaceStylePlan: { visibleAffect: true, surfaceTexture: "random-chat-tic" },
      }],
    }).success).toBe(false);
    expect(candidateReviewInputSchema.safeParse({
      ...base,
      roomRecall: {
        witnessPersonaIds: ["ai-mira", "ai-mira"],
        timeline: [timelineRow],
      },
    }).success).toBe(false);
  });

  it("builds a strict dynamic batch schema", () => {
    const format = buildCandidateReviewResponseFormat(reviewInput()) as any;
    const reviews = format.json_schema.schema.properties.reviews;
    expect(format.json_schema.strict).toBe(true);
    expect(reviews.minItems).toBe(2);
    expect(reviews.maxItems).toBe(2);
    expect(reviews.items.properties.personaId.enum).toEqual(["ai-mira", "ai-sana"]);
    expect(reviews.items.properties.issues.items.enum).toContain("unsupported_acoustic_assertion");
    expect(reviews.items.properties.issues.items.enum).toContain("unsupported_room_recall");
    expect(reviews.items.properties.issues.items.enum).toContain("incorrect_temporal_claim");
    expect(reviews.items.properties.issues.items.enum).toContain("gratuitous_time_reference");
    expect(reviews.items.properties.issues.items.enum).toContain("unfulfilled_explicit_request");
  });

  it("accepts quoted multilingual discussion as clean and rejects missing or duplicate persona reviews", () => {
    const clean = {
      reviews: [
        { personaId: "ai-mira", severity: "none", issues: [], rewriteInstruction: null },
        { personaId: "ai-sana", severity: "none", issues: [], rewriteInstruction: null },
      ],
    };
    expect(parseCandidateReviewContent(JSON.stringify(clean), reviewInput())).toEqual(clean);

    expect(parseCandidateReviewContent(JSON.stringify({ reviews: [clean.reviews[0]] }), reviewInput())).toBeUndefined();
    expect(parseCandidateReviewContent(JSON.stringify({ reviews: [clean.reviews[0], clean.reviews[0]] }), reviewInput())).toBeUndefined();
  });

  it("requires a bounded issue enum, severity and rewrite instruction", () => {
    const valid: any = {
      reviews: [
        {
          personaId: "ai-mira",
          severity: "high",
          issues: ["false_evidence_denial"],
          rewriteInstruction: "Réponds à partir de la page déjà fournie.",
        },
        { personaId: "ai-sana", severity: "none", issues: [], rewriteInstruction: null },
      ],
    };
    expect(parseCandidateReviewContent(JSON.stringify(valid), reviewInput())).toEqual(valid);
    valid.reviews[0] = { ...valid.reviews[0], issues: ["made_up_issue"] };
    expect(parseCandidateReviewContent(JSON.stringify(valid), reviewInput())).toBeUndefined();
  });

  it("accepts unsupported old-room memory as a factual publication issue", () => {
    const base = reviewInput();
    const recalled = candidateReviewInputSchema.parse({
      ...base,
      roomRecall: {
        witnessPersonaIds: ["ai-sana"],
        timeline: [{
          messageId: "message-per-visit",
          authorId: "human-per",
          author: "Per",
          kind: "human",
          content: "Jag var här en sväng.",
          createdAt: "2026-07-14T09:00:00.000Z",
          ageSeconds: 10_800,
          sincePreviousSeconds: null,
          role: "anchor",
          anchorMatches: ["author_identity"],
          system: false,
          generation: null,
        }],
      },
    });
    const blocked = {
      reviews: [
        {
          personaId: "ai-mira",
          severity: "high",
          issues: ["unsupported_room_recall"],
          rewriteInstruction: "Säg att du såg det i den sparade rumshistoriken i stället för att påstå personlig närvaro.",
        },
        { personaId: "ai-sana", severity: "none", issues: [], rewriteInstruction: null },
      ],
    };

    expect(parseCandidateReviewContent(JSON.stringify(blocked), recalled)).toEqual(blocked);
    expect(parseCandidateReviewContent(JSON.stringify({
      reviews: [
        { ...blocked.reviews[0], severity: "medium" },
        blocked.reviews[1],
      ],
    }), recalled)).toBeUndefined();
  });

  it("accepts an unfulfilled explicit request only as a high-severity gated blocker", () => {
    const request = explicitRequestReviewInput({
      trigger: "Dame una adivinanza.",
      candidate: "Voy a pensarlo y luego traigo algún juego de palabras.",
    });
    const blocked = {
      reviews: [{
        personaId: "ai-mira",
        severity: "high",
        issues: ["unfulfilled_explicit_request"],
        rewriteInstruction: "Da ahora la adivinanza solicitada en vez de prometerla o sustituirla.",
      }],
    };

    expect(parseCandidateReviewContent(JSON.stringify(blocked), request)).toEqual(blocked);
    expect(parseCandidateReviewContent(JSON.stringify({
      reviews: [{ ...blocked.reviews[0], severity: "medium" }],
    }), request)).toBeUndefined();
  });

  it("rejects the request-fulfilment issue without every trusted server gate", () => {
    const blocked = {
      reviews: [{
        personaId: "ai-mira",
        severity: "high",
        issues: ["unfulfilled_explicit_request"],
        rewriteInstruction: "Perform the requested outcome now.",
      }],
    };

    expect(parseCandidateReviewContent(
      JSON.stringify(blocked),
      explicitRequestReviewInput({ intentTrusted: false }),
    )).toBeUndefined();
    expect(parseCandidateReviewContent(
      JSON.stringify(blocked),
      explicitRequestReviewInput({ replyExpected: "optional" }),
    )).toBeUndefined();
    expect(parseCandidateReviewContent(
      JSON.stringify(blocked),
      explicitRequestReviewInput({ mustFulfillRequest: false }),
    )).toBeUndefined();
  });

  it("does not confuse a required moderator, evidence or dissent line with explicit-request ownership", () => {
    const blocked = {
      reviews: [{
        personaId: "ai-mira",
        severity: "high",
        issues: ["unfulfilled_explicit_request"],
        rewriteInstruction: "Perform the requested outcome now.",
      }],
    };
    const requiredButNotOwner = explicitRequestReviewInput({
      mustReply: true,
      mustFulfillRequest: false,
    });

    expect(requiredButNotOwner.candidates[0]).toMatchObject({
      mustReply: true,
      mustFulfillRequest: false,
    });
    expect(parseCandidateReviewContent(JSON.stringify(blocked), requiredButNotOwner)).toBeUndefined();
  });

  it("keeps a supplied requested artifact clean under the same trusted gates", () => {
    const fulfilled = explicitRequestReviewInput({
      candidate: "パンはパンでも食べられないパンは？ フライパン。",
    });
    const clean = {
      reviews: [{ personaId: "ai-mira", severity: "none", issues: [], rewriteInstruction: null }],
    };

    expect(parseCandidateReviewContent(JSON.stringify(clean), fulfilled)).toEqual(clean);
  });

  it("explicitly reviews asserted meaning rather than multilingual keyword hits", () => {
    const prompt = buildCandidateReviewSystemPrompt();
    expect(prompt).toContain("directly in the language and cultural register of the turn");
    expect(prompt).toContain("quoted, negated, hypothetical, sarcastic or corrected claim");
    expect(prompt).toContain("Do not use Swedish or English keyword lists");
    expect(prompt).toContain("Return exactly one review per supplied persona ID");
    expect(prompt).toContain("quoted/negated time phrase");
    expect(prompt).toContain("complete pragmatic meaning in context");
    expect(prompt).toContain("never words, phrase templates, punctuation or translated keywords");
    expect(prompt).toContain("the designated owner must actually supply that outcome");
    expect(prompt).toContain("mustReply alone may instead represent moderation, evidence, dissent or another social role");
    expect(prompt).toContain("a requested riddle, joke, example, explanation, choice, rewrite or other artifact is fulfilment");
    expect(prompt).toContain("Relatedness alone is not fulfilment");
    expect(prompt).toContain("roomRecall.witnessPersonaIds");
    expect(prompt).toContain("A roomRecall anchor proves only that the row directly matched retrieval");
    expect(prompt).toContain("A context row proves only that it appeared nearby");
    expect(prompt).toContain("capabilityContext lists read_url or web_search");
    expect(prompt).toContain("resident model having no personal tool is irrelevant");
    expect(prompt).toContain("unsupported_room_recall");
    expect(prompt).toContain("A non-witness may accurately say it checked retained room history");
    expect(prompt).toContain("visibleAffect true permits one genuine feeling");
    expect(prompt).toContain("informal fragment, lowercase opening, letter elongation, brief self-correction, rough orthography, harmless typo or mild profanity");
    expect(prompt).toContain("Do not formalize or copy-edit such permitted texture");
  });
});
