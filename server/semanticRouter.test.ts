import { describe, expect, it } from "vitest";
import {
  buildCandidateReviewResponseFormat,
  buildCandidateReviewSystemPrompt,
  buildMemoryAnalysisResponseFormat,
  buildMemoryAnalysisSystemPrompt,
  buildMemoryAnalysisUserData,
  buildTurnAnalysisResponseFormat,
  buildTurnAnalysisSystemPrompt,
  buildTurnAnalysisUserData,
  candidateReviewInputSchema,
  containsVisibleUrl,
  createFailClosedTurnAnalysis,
  memoryAnalysisInputSchema,
  parseCandidateReviewContent,
  parseMemoryAnalysisContent,
  parseTurnAnalysisContent,
  projectTrustedTurnAnalysis,
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
  intent: { kind: "question", isQuestion: true, replyExpected: "expected", confidence: 0.98 },
  personas: {
    addressedIds: ["ai-mira"],
    requestedReplyIds: ["ai-mira"],
    relevantIds: ["ai-mira"],
    addressConfidence: 0.98,
    relevanceConfidence: 0.91,
  },
  social: { warmth: 0.6, hostility: 0, playfulness: 0.1, absurdity: 0, urgency: 0.1, energy: 0.4, pileOnRisk: 0, claimStrength: 0.2, confidence: 0.96 },
  moderation: { risk: "none", action: "none", categories: [], confidence: 0.99 },
  evidence: {
    need: "required",
    action: "local_datetime",
    confidence: 0.99,
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
      l: "ja",
      lx: 0.97,
      i: { k: "question", q: true, r: "expected", x: 0.96 },
      p: { a: ["ai-mira"], r: ["ai-mira"], v: ["ai-mira"], x: 0.98, y: 0.91 },
      s: { w: 0.6, h: 0, a: 0, e: 0.4, c: 0.2, x: 0.96 },
      m: { r: "none", a: "none", c: [], x: 0.99 },
      e: { a: "local_datetime", x: 0.99, q: null, u: null, m: null, z: "Asia/Tokyo", k: "current_time", l: "東京" },
      c: { d: ["local_datetime"], r: "execute", a: false, i: false, l: false, x: 0.95 },
      y: [],
    }), input());
    expect(parsed).toMatchObject({
      source: "lm",
      language: { tag: "ja" },
      intent: { kind: "question", isQuestion: true },
      evidence: { need: "required", action: "local_datetime", timeZone: "Asia/Tokyo" },
      personas: { requestedReplyIds: ["ai-mira"] },
    });
  });

  it("does not turn a relevant specialist into an addressed reply target", () => {
    const parsed = parseTurnAnalysisContent(JSON.stringify({
      l: "es",
      lx: 0.98,
      i: { k: "question", q: true, r: "expected", x: 0.97 },
      p: { a: [], r: ["ai-sana"], v: ["ai-sana"], x: 0.94, y: 0.96 },
      s: { w: 0.2, h: 0, a: 0, e: 0.3, c: 0.1, x: 0.96 },
      m: { r: "none", a: "none", c: [], x: 0.99 },
      e: { a: "web_search", x: 0.96, q: "cotización actual Telefónica", u: null, m: "web", z: null, k: null, l: null },
      c: { d: ["web_search"], r: "execute", a: false, i: false, l: false, x: 0.95 },
      y: [],
    }), input());
    expect(parsed?.personas).toMatchObject({
      addressedIds: [],
      requestedReplyIds: [],
      relevantIds: ["ai-sana"],
    });
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
      evidence: { ...uncertain.evidence, confidence: 0.2 },
      capabilities: { ...uncertain.capabilities, asksForList: true, asksAboutAcoustics: true, confidence: 0.2 },
    };
    expect(projectTrustedTurnAnalysis(analysis)).toEqual({
      intentTrusted: false,
      isQuestion: false,
      inferredAddressedIds: [],
      relevantIds: [],
      socialTrusted: false,
      social: { warmth: 0, hostility: 0, playfulness: 0, absurdity: 0, urgency: 0, energy: 0, pileOnRisk: 0, claimStrength: 0 },
      evidenceTrusted: false,
      capabilityTrusted: false,
      asksForList: false,
      asksAboutAiIdentity: false,
      asksAboutAcoustics: false,
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

  it("ignores the reserved compatibility slot without losing a valid tool decision", () => {
    const compact = {
      l: "sv",
      lx: 0.99,
      i: { k: "question", q: true, r: "expected", x: 0.99 },
      p: { a: [], r: [], v: [], x: 0, y: 0 },
      s: { w: 0.2, h: 0, a: 0, e: 0.2, c: 0, x: 0.96 },
      m: { r: "none", a: "none", c: [], x: 0.99 },
      e: { a: "local_datetime", x: 0.99, q: null, u: null, m: null, z: "Europe/Stockholm", k: "current_time", l: "Sverige" },
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
      i: { k: "social", q: true, r: "optional", x: 0.9 },
      p: { a: [], r: [], v: [], x: 0, y: 0 },
      s: { w: 0.5, h: 0, a: 0, e: 0.3, c: 0, x: 0.96 },
      m: { r: "none", a: "none", c: [], x: 0.99 },
      e: { a: "none", x: 0.99, q: null, u: null, m: null, z: null, k: null, l: null },
      c: { d: ["read_url"], r: "none", a: false, i: false, l: false, x: 0.99 },
      y: [],
    };
    expect(parseTurnAnalysisContent(JSON.stringify(compact), input())?.capabilities.discussed).toEqual([]);
  });

  it("instructs one multilingual pass without keyword-list routing", () => {
    const prompt = buildTurnAnalysisSystemPrompt();
    expect(prompt).toContain("single multilingual semantic router");
    expect(prompt).toContain("Never rely on a fixed vocabulary");
    expect(prompt).toContain("compact wire keys");
    expect(prompt).toContain("valid IANA time-zone name");
    expect(prompt).toContain("Never output, reconstruct or copy a URL");
    expect(prompt).toContain("quoted/reporting speech from endorsement");
    expect(prompt).toContain("Always return y []");
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
  trigger: { author: "Léa", content: "Il a dit « je ne peux jamais lire le web », mais c'était faux." },
  premise: null,
  semanticContext: {
    languageTag: "fr",
    asksForList: false,
    asksAboutAiIdentity: false,
    asksAboutAcoustics: false,
  },
  voiceFacts: null,
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
      recentOwnTexts: [],
      peerTexts: [],
    },
    {
      personaId: "ai-sana",
      actorName: "Sana",
      content: "Le passage parle d'un échec temporaire, pas d'une incapacité permanente.",
      sourceIds: ["S1"],
      recentOwnTexts: [],
      peerTexts: [],
    },
  ],
});

describe("multilingual batch candidate-review contract", () => {
  it("builds a strict dynamic batch schema", () => {
    const format = buildCandidateReviewResponseFormat(reviewInput()) as any;
    const reviews = format.json_schema.schema.properties.reviews;
    expect(format.json_schema.strict).toBe(true);
    expect(reviews.minItems).toBe(2);
    expect(reviews.maxItems).toBe(2);
    expect(reviews.items.properties.personaId.enum).toEqual(["ai-mira", "ai-sana"]);
    expect(reviews.items.properties.issues.items.enum).toContain("unsupported_acoustic_assertion");
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

  it("explicitly reviews asserted meaning rather than multilingual keyword hits", () => {
    const prompt = buildCandidateReviewSystemPrompt();
    expect(prompt).toContain("directly in the language and cultural register of the turn");
    expect(prompt).toContain("quoted, negated, hypothetical, sarcastic or corrected claim");
    expect(prompt).toContain("Do not use Swedish or English keyword lists");
    expect(prompt).toContain("Return exactly one review per supplied persona ID");
  });
});
