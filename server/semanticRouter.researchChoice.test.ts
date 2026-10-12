import { describe, expect, it, vi } from "vitest";
import { LmStudioClient } from "./lmStudio.js";
import type { ModelBackend } from "./modelBackend.js";
import {
  buildEvidencePlanVerifierSystemPrompt,
  buildEvidencePlanVerifierUserData,
  buildTurnAnalysisSystemPrompt,
  buildTurnAnalysisUserData,
  createEvidencePlanVerifierInput,
  parseEvidencePlanVerifierContent,
  parseTurnAnalysisContent,
  projectEvidencePlanVerification,
  projectTrustedTurnAnalysis,
  recoverTurnAnalysisAfterVerifiedNoEvidence,
  shouldVerifyEvidencePlan,
  turnAnalysisInputSchema,
  type EvidencePlanPrimarySummary,
} from "./semanticRouter.js";

const turn = (content: string) => turnAnalysisInputSchema.parse({
  turnId: "research-choice",
  medium: "public",
  channel: { id: "room", name: "Community" },
  latestMessage: { id: "latest", authorId: "human", authorName: "Guest", content },
  recentMessages: [{
    id: "previous", authorId: "ai-mira", authorName: "Mira", authorKind: "ai",
    content: "We were comparing different explanations.",
  }],
  personaCandidates: [{ id: "ai-mira", name: "Mira" }],
  availableCapabilities: ["web_search", "read_url"],
  urlCandidates: [{ ref: "latest:0", source: "latest_message", context: "path=/article" }],
});

const invalidSelectedPrimary = (): EvidencePlanPrimarySummary => ({
  source: "fallback",
  failureReason: "invalid_output",
  intent: { kind: "question", replyExpected: "expected", confidence: 0.98 },
  personas: { addressedIds: [], requestedReplyIds: [], addressConfidence: 0.9 },
  evidence: { action: "web_search", confidence: 0.99 },
  capabilities: { discussed: ["web_search"], requestKind: "execute", confidence: 0.99 },
});

const noneWire = () => ({
  t: "und", tx: 0, v: "keep_none", a: "none", r: "none", d: [], x: 0.98,
  g: null, q: null, u: null, m: null, z: null, k: null, l: null, c: null, w: null, f: null,
});

const compactQuestion = (): any => ({
  l: "fr", lx: 0.99, rl: "fr", rlx: 0.99,
  i: { k: "question", q: true, r: "optional", d: "normal", o: "general", j: 0.97, x: 0.98 },
  p: { a: [], r: [], v: ["ai-mira"], x: 0, y: 0.92, h: [], z: 0 },
  f: { r: "none", p: [], m: [], x: 1 },
  s: { w: 0.6, h: 0, p: 0.2, a: 0, u: 0, e: 0.5, o: 0, c: 0.4, x: 0.96 },
  b: { k: "ordinary", t: "room", r: "none", c: 0, m: 0, x: 0.97 },
  m: { r: "none", a: "none", c: [], x: 1 },
  r: { k: "irrelevant", x: 1 },
  e: { a: "web_search", x: 0.9, g: "la question actuelle", q: "la question actuelle",
    u: null, m: "web", z: null, k: null, l: null, c: null, w: null, f: null },
  c: { d: [], r: "none", a: false, i: false, l: false, x: 1 },
  h: { n: "none", q: null, x: 1 }, y: [],
});

const trustedNone = (input = turn("Une correction dans la conversation.")) =>
  parseEvidencePlanVerifierContent(
    JSON.stringify(noneWire()), createEvidencePlanVerifierInput(input, invalidSelectedPrimary()),
  )!;

describe("verified no-evidence recovery", () => {
  it("revalidates intact conversation fields instead of losing them to an inconsistent evidence branch", () => {
    const input = turn("Une correction dans la conversation.");
    const content = JSON.stringify(compactQuestion());
    expect(parseTurnAnalysisContent(content, input)).toBeUndefined();
    const recovered = recoverTurnAnalysisAfterVerifiedNoEvidence(content, input, trustedNone(input));
    expect(recovered).toMatchObject({
      source: "lm", failureReason: null,
      language: { tag: "fr", confidence: 0.99 },
      intent: { kind: "question", replyExpected: "optional", operationalMode: "general", confidence: 0.98 },
      personas: { relevantIds: ["ai-mira"], requestedReplyIds: [] },
      evidence: { action: "none", goal: null, query: null },
      capabilities: { discussed: [], requestKind: "none", asksForList: false },
    });
  });

  it.each([
    ["unknown resident", (value: any) => { value.p.v = ["unknown-resident"]; }],
    ["unknown retained human", (value: any) => { value.p.h = ["unknown-human"]; }],
    ["invalid moderation", (value: any) => { value.m.r = "high"; value.m.a = "none"; }],
    ["invalid operational mode", (value: any) => { value.i.o = "invented-mode"; }],
    ["invalid operational confidence", (value: any) => { value.i.j = 2; }],
    ["invalid independent capability flag", (value: any) => { value.c.a = "yes"; }],
    ["missing independent capability confidence", (value: any) => { delete value.c.x; }],
    ["missing intent", (value: any) => { delete value.i; }],
  ] as const)("does not recover %s merely because the verifier says none", (_label, mutate) => {
    const input = turn("Une correction dans la conversation.");
    const value = compactQuestion();
    mutate(value);
    expect(recoverTurnAnalysisAfterVerifiedNoEvidence(JSON.stringify(value), input, trustedNone(input)))
      .toBeUndefined();
  });

  it("preserves valid restrictive operational semantics and does not synthesize a reply obligation", () => {
    const input = turn("Une correction dans la conversation.");
    const value = compactQuestion();
    value.i.o = "defensive_pivot";
    value.i.r = "none";
    const result = recoverTurnAnalysisAfterVerifiedNoEvidence(JSON.stringify(value), input, trustedNone(input));
    expect(result?.intent).toMatchObject({ operationalMode: "defensive_pivot", replyExpected: "none" });
  });

  it("does not upgrade independent identity, acoustic or list flags with the verifier's confidence", () => {
    const input = turn("Une correction dans la conversation.");
    const value = compactQuestion();
    value.c = { ...value.c, x: 0.1, a: true, i: true, l: true };
    const result = recoverTurnAnalysisAfterVerifiedNoEvidence(JSON.stringify(value), input, trustedNone(input));
    expect(result?.capabilities).toMatchObject({
      confidence: 0.1, asksAboutAcoustics: true, asksAboutAiIdentity: true, asksForList: true,
    });
    expect(projectTrustedTurnAnalysis(result!)).toMatchObject({
      capabilityTrusted: false, asksAboutAcoustics: false, asksAboutAiIdentity: false, asksForList: false,
    });
  });

  it("requires a trusted independently parsed no-action decision and leaves valid primary output alone", () => {
    const input = turn("Une correction dans la conversation.");
    const content = JSON.stringify(compactQuestion());
    expect(recoverTurnAnalysisAfterVerifiedNoEvidence(content, input, undefined)).toBeUndefined();
    expect(recoverTurnAnalysisAfterVerifiedNoEvidence(content, input, { ...trustedNone(input), confidence: 0.1 }))
      .toBeUndefined();
    expect(recoverTurnAnalysisAfterVerifiedNoEvidence(content, input, { ...trustedNone(input), confidence: NaN }))
      .toBeUndefined();
    expect(recoverTurnAnalysisAfterVerifiedNoEvidence(content, input, { ...trustedNone(input), decision: "use_action" }))
      .toBeUndefined();
    const valid = compactQuestion();
    valid.c.d = ["web_search"];
    valid.c.r = "execute";
    expect(parseTurnAnalysisContent(JSON.stringify(valid), input)?.evidence.action).toBe("web_search");
    expect(recoverTurnAnalysisAfterVerifiedNoEvidence(JSON.stringify(valid), input, trustedNone(input)))
      .toBeUndefined();
  });

  it("wires bounded recovery into the actual client and emits only its typed result", async () => {
    const input = turn("Une correction dans la conversation.");
    const bodies: Record<string, any>[] = [];
    const responses = [compactQuestion(), noneWire()];
    const backend: ModelBackend = {
      providerId: "lmstudio", configuredModel: "synthetic-routing-recovery",
      probe: async () => ({ connected: true, id: "synthetic-routing-recovery" }),
      complete: async (body) => {
        bodies.push(body);
        return { choices: [{ message: { content: JSON.stringify(responses.shift()) } }] };
      },
    };
    const logged: string[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((line) => logged.push(String(line)));
    try {
      const result = await new LmStudioClient({ backend }).analyzeTurn(input);
      expect(result.source).toBe("lm");
      expect(result.intent.replyExpected).toBe("optional");
      expect(result.evidence.action).toBe("none");
      expect(bodies).toHaveLength(2);
      expect(bodies[0].messages[0].content).not.toContain("- market_snapshot:");
      expect(logged.map((line) => JSON.parse(line))).toContainEqual(expect.objectContaining({
        stage: "routing", outcome: "recovered", analysisSource: "lm", evidenceAction: "none", replyExpected: "optional",
      }));
      expect(logged.join(" ")).not.toContain(input.latestMessage.content);
    } finally { spy.mockRestore(); }
  });
});

describe("evidence-need routing contract", () => {
  it("gives the primary and verifier the same evidence-dependency boundary before provider selection", () => {
    for (const prompt of [buildTurnAnalysisSystemPrompt(), buildEvidencePlanVerifierSystemPrompt()]) {
      expect(prompt).toContain("Evidence need comes before provider selection");
      expect(prompt).toContain("stable general knowledge or ordinary reasoning");
      expect(prompt).toContain("casual factual corrections can be answered conversationally without searching");
      expect(prompt).toContain("An uncertain or invalid classifier result is uncertainty about the routing");
      expect(prompt).toContain("Evidence choice never decides whether anybody must reply");
      expect(prompt.indexOf("Evidence need comes before provider selection"))
        .toBeLessThan(prompt.indexOf("- web_search:"));
    }
  });

  it("retains explicit external evidence and trusted room-grounding requirements", () => {
    for (const prompt of [buildTurnAnalysisSystemPrompt(), buildEvidencePlanVerifierSystemPrompt()]) {
      expect(prompt).toContain("explicit lookup, source-checking or verification requests");
      expect(prompt).toContain("reading a supplied source, finding a real link, required freshness");
      expect(prompt).toContain("exact fact not reliably available");
      expect(prompt).toContain("trusted room-grounding requirements");
      expect(prompt).toContain("narrow semantic override to the self-contained-knowledge default");
    }
  });

  it("limits the primary action catalog to runtime inventory without inventing a fallback", () => {
    const prompt = buildTurnAnalysisSystemPrompt(["read_url", "web_search"]);
    expect(prompt).toContain("choose none or exactly one cataloged action from read_url, web_search");
    expect(prompt).toContain("whether an actual listed server capability (read_url, web_search) is available");
    expect(prompt).toContain("- read_url:");
    expect(prompt).toContain("- web_search:");
    expect(prompt).not.toContain("- market_snapshot:");
    expect(prompt).not.toContain("- football_data:");
    expect(prompt).not.toContain("- weather_forecast:");
    expect(prompt).not.toContain("market_snapshot");
    expect(prompt).not.toContain("football_data");
    expect(prompt).toContain("unavailable specialized provider does not mean that no available provider can help");
    const unavailable = buildTurnAnalysisSystemPrompt([]);
    expect(unavailable).toContain("(no evidence actions available)");
    expect(unavailable).not.toContain("- web_search:");
  });

  it.each(["execute", "retry", "correct_limitation"] as const)(
    "sends an unresolved %s request to the existing verifier despite a wrong intent label or unavailable specialist",
    (requestKind) => {
      const input = turn("Una petición cuyo proveedor debe decidir el clasificador.");
      input.recentMessages = [];
      const primary: EvidencePlanPrimarySummary = {
        ...invalidSelectedPrimary(), source: "lm", failureReason: null,
        intent: { kind: "capability_question", replyExpected: "expected", confidence: 1 },
        evidence: { action: "none", confidence: 1 },
        capabilities: { discussed: ["market_snapshot"], requestKind, confidence: 1 },
      };
      expect(shouldVerifyEvidencePlan(input, primary)).toBe(true);
      expect(shouldVerifyEvidencePlan(input, {
        ...primary, capabilities: { ...primary.capabilities, confidence: 0.1 },
      })).toBe(false);
      expect(shouldVerifyEvidencePlan({ ...input, availableCapabilities: ["local_datetime"] }, primary))
        .toBe(false);
      expect(shouldVerifyEvidencePlan(input, {
        ...primary, capabilities: { ...primary.capabilities, requestKind: "availability" },
      })).toBe(false);
      expect(shouldVerifyEvidencePlan(input, {
        ...primary, capabilities: { discussed: [], requestKind: "none", confidence: 1 },
      })).toBe(false);
    },
  );

  it("treats missing older history as supplementary rather than a prerequisite for the active discussion", () => {
    const prompt = buildTurnAnalysisSystemPrompt();
    expect(prompt).toContain("recentMessages already contain the relevant room events or discussion");
    expect(prompt).toContain("Recall is supplementary only for a genuinely missing earlier part");
  });

  // These are boundary/replay tests, not simulated proof of LLM understanding.
  // The live evaluation must separately establish the semantic choices.
  it.each([
    "Alla fåglar äter ju kanske inte bara frön? Örnar till exempel?",
    "Mais tous les métaux ne sont pas magnétiques, si ?",
    "すべての哺乳類が卵を産むわけじゃないよね？",
  ])("allows an independent no-research result after an invalid selected plan: %s", (content) => {
    const input = turn(content);
    const primary = invalidSelectedPrimary();
    expect(shouldVerifyEvidencePlan(input, primary)).toBe(true);
    const verifier = createEvidencePlanVerifierInput(input, primary);
    expect(buildTurnAnalysisUserData(input)).toMatchObject({ latestMessage: { content } });
    const payload = buildEvidencePlanVerifierUserData(verifier) as { primarySignals: object };
    expect(JSON.stringify(payload.primarySignals)).not.toContain("web_search");
    expect(projectEvidencePlanVerification(parseEvidencePlanVerifierContent(
      JSON.stringify(noneWire()), verifier,
    ))).toMatchObject({ decision: "keep_none", evidenceTrusted: false, evidence: { action: "none" } });
  });

  it.each([
    { content: "Kan du verifiera påståendet hos en trovärdig källa?", query: "verifiera påståendet källa", mode: "web" },
    { content: "What did the central bank announce today?", query: "central bank announcement today", mode: "news" },
  ])("still accepts a complete independent external plan: $content", ({ content, query, mode }) => {
    const verifier = createEvidencePlanVerifierInput(turn(content), invalidSelectedPrimary());
    const result = parseEvidencePlanVerifierContent(JSON.stringify({
      ...noneWire(), v: "use_action", a: "web_search", r: "execute", d: ["web_search"],
      g: query, q: query, m: mode,
    }), verifier);
    expect(projectEvidencePlanVerification(result)).toMatchObject({
      decision: "use_action", evidenceTrusted: true,
      evidence: { action: "web_search", query, searchMode: mode },
    });
  });

  it("preserves requested URL reading and rejects a fabricated source reference", () => {
    const verifier = createEvidencePlanVerifierInput(
      turn("Lee este artículo y dime qué afirma."), invalidSelectedPrimary(),
    );
    const plan = {
      ...noneWire(), v: "use_action", a: "read_url", r: "execute", d: ["read_url"],
      g: "lo que afirma el artículo", u: "latest:0",
    };
    expect(parseEvidencePlanVerifierContent(JSON.stringify(plan), verifier)?.evidence.action).toBe("read_url");
    expect(parseEvidencePlanVerifierContent(JSON.stringify({ ...plan, u: "invented:0" }), verifier))
      .toBeUndefined();
  });

  it("does not permit an incomplete search under the new guidance", () => {
    const verifier = createEvidencePlanVerifierInput(turn("Find a source for this."), invalidSelectedPrimary());
    expect(parseEvidencePlanVerifierContent(JSON.stringify({
      ...noneWire(), v: "use_action", a: "web_search", r: "execute", d: ["web_search"],
      g: null, m: "web", q: null,
    }), verifier)).toBeUndefined();
  });
});
