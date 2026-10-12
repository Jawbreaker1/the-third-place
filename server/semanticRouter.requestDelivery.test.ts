import { describe, expect, it } from "vitest";
import {
  buildCandidateReviewResponseFormat,
  candidateReviewInputSchema,
  parseCandidateReviewContent,
  type NormalizedCandidateReviewInput,
} from "./semanticRouter.js";

const inputFor = (options: {
  content?: string;
  trigger?: string;
  owner?: boolean;
  trusted?: boolean;
  expected?: "none" | "optional" | "expected";
} = {}): NormalizedCandidateReviewInput => candidateReviewInputSchema.parse({
  sceneKind: "public",
  room: { id: "test-room", name: "Test room", register: "everyday" },
  trigger: {
    author: "Alex",
    content: options.trigger ?? "Yes, let's pick up where we left off.",
    createdAt: "2026-10-12T12:00:00.000Z",
    ageSeconds: 0,
  },
  premise: null,
  semanticContext: {
    languageTag: null,
    intentTrusted: options.trusted ?? true,
    replyExpected: options.expected ?? "expected",
    asksForList: false,
    asksAboutAiIdentity: false,
    asksAboutAcoustics: false,
  },
  voiceFacts: null,
  temporalContext: {
    sceneClock: {
      timeZone: "Europe/Stockholm",
      locationLabel: "Sweden",
      instant: "2026-10-12T12:00:00.000Z",
      localDate: "2026-10-12",
      localTime: "14:00:00",
      utcOffset: "GMT+02:00",
      weekday: "Monday",
      daypart: "afternoon",
    },
    requestedClock: null,
    surfacePolicy: "reactive_only",
    surfaceActorId: null,
    recentTimeline: [],
  },
  evidence: { outcome: "none", kind: null, query: null, results: [] },
  candidates: [{
    personaId: "ai-sana",
    actorName: "Sana",
    content: options.content ?? "I can post the example if you want.",
    sourceIds: [],
    mustReply: true,
    mustFulfillRequest: options.owner ?? true,
    surfaceStylePlan: { visibleAffect: false, surfaceTexture: null },
    recentOwnTexts: [],
    peerTexts: [],
  }],
});

type Delivery = {
  status: "not_due" | "delivered" | "constrained" | "missing";
  resolvedOutcome: string | null;
  deliveredExcerpt: string | null;
};

const missing: Delivery = {
  status: "missing",
  resolvedOutcome: "Provide the example offered in the previous exchange.",
  deliveredExcerpt: null,
};

const notDue: Delivery = {
  status: "not_due",
  resolvedOutcome: null,
  deliveredExcerpt: null,
};

const reviewFor = (requestDelivery?: Delivery) => ({
  personaId: "ai-sana",
  severity: "none",
  issues: [] as string[],
  rewriteInstruction: null as string | null,
  sameSceneOverlap: "none",
  outputLanguage: { tag: "und", confidence: 0 },
  ...(requestDelivery ? { requestDelivery } : {}),
});

const parse = (
  input: NormalizedCandidateReviewInput,
  reviews = [reviewFor()],
) => parseCandidateReviewContent(
  JSON.stringify({ reviews }),
  input,
  { requireDeliveryAssessment: true },
);

const successfulEvidenceInput = (): NormalizedCandidateReviewInput => {
  const base = inputFor({ trusted: false, expected: "optional", content: "Northbridge won, 2–1." });
  return candidateReviewInputSchema.parse({
    ...base,
    evidence: {
      outcome: "succeeded",
      kind: "search",
      query: "final result",
      results: [{ id: "S1", title: "Final", snippet: "Northbridge won, 2–1." }],
    },
    capabilityContext: {
      available: ["web_search"],
      externalEvidenceAvailable: true,
      requestKind: "execute",
      discussed: ["web_search"],
      plannedAction: "web_search",
      executionStatus: "succeeded",
    },
    candidates: [{ ...base.candidates[0], sourceIds: ["S1"] }],
  });
};

describe("independent semantic request-delivery assessment", () => {
  // These tests validate the typed review contract, not the semantic accuracy
  // of a hand-written verdict. Real model decisions belong in the live eval.
  it("requires a delivery decision for an eligible owner in production, retaining legacy parse compatibility", () => {
    const input = inputFor();
    const legacy = { reviews: [reviewFor()] };
    expect(parseCandidateReviewContent(JSON.stringify(legacy), input)).toEqual(legacy);
    expect(parse(input)).toBeUndefined();
  });

  it("requires the field in the production response schema when the scene has an eligible owner", () => {
    const format = buildCandidateReviewResponseFormat(inputFor()) as {
      json_schema: { schema: { properties: { reviews: { items: {
        required: string[];
        properties: Record<string, unknown>;
      } } } } };
    };
    const item = format.json_schema.schema.properties.reviews.items;
    expect(item.required).toContain("requestDelivery");
    expect(item.properties.requestDelivery).toBeDefined();
  });

  it("does not let a trusted request owner bypass assessment with a null not-due verdict", () => {
    expect(parse(inputFor(), [reviewFor(notDue)])).toBeUndefined();
    expect(parse(successfulEvidenceInput(), [reviewFor(notDue)])).toBeUndefined();
  });

  it.each([
    { owner: false },
    { trusted: false },
    { expected: "optional" as const },
    { expected: "none" as const },
  ])("does not manufacture a delivery obligation from missing eligibility %j", (options) => {
    const input = inputFor(options);
    expect(parse(input)).toBeDefined();
    expect(parse(input, [reviewFor(notDue)])).toBeDefined();
  });

  it("cannot elevate a private remembered promise into a live request", () => {
    const base = inputFor({ owner: false, expected: "optional", trigger: "Good evening!", content: "Hey Alex!" });
    const input = candidateReviewInputSchema.parse({
      ...base,
      candidates: [{ ...base.candidates[0], privateRelationshipNote: "I promised Alex an example yesterday." }],
    });
    expect(parse(input, [reviewFor(notDue)])?.reviews[0].issues).toEqual([]);
    expect(parse(input)).toBeDefined();
  });

  it.each([
    { trusted: true, expected: "optional" as const },
    { trusted: false, expected: "none" as const },
  ])("keeps the current DM response contract when auxiliary intent misses %j", (options) => {
    const input = candidateReviewInputSchema.parse({ ...inputFor(options), sceneKind: "dm" });
    expect(parse(input)).toBeUndefined();
    expect(parse(input, [reviewFor(notDue)])).toBeUndefined();
    expect(parse(input, [reviewFor(missing)])?.reviews[0]).toMatchObject({
      severity: "high", issues: ["unfulfilled_explicit_request"],
    });
  });

  it("a DM greeting is delivered by a greeting, not by a remembered artifact", () => {
    const text = "Hey, have a good evening!";
    const base = inputFor({ trusted: false, expected: "none", trigger: "Just saying hi before dinner.", content: text });
    const input = candidateReviewInputSchema.parse({
      ...base, sceneKind: "dm",
      candidates: [{ ...base.candidates[0], privateRelationshipNote: "I once offered to explain array copying." }],
    });
    expect(parse(input, [reviewFor({
      status: "delivered", resolvedOutcome: "Acknowledge the current greeting.", deliveredExcerpt: text,
    })])?.reviews[0].severity).toBe("none");
  });

  it("DM scope alone creates no duty without a current trigger and designated owner", () => {
    const base = inputFor({ trusted: false, expected: "none" });
    const noTrigger = candidateReviewInputSchema.parse({ ...base, sceneKind: "dm", trigger: null });
    const noOwner = candidateReviewInputSchema.parse({
      ...base, sceneKind: "dm", candidates: [{ ...base.candidates[0], mustFulfillRequest: false }],
    });
    expect(parse(noTrigger, [reviewFor(notDue)])).toBeDefined();
    expect(parse(noOwner, [reviewFor(notDue)])).toBeDefined();
  });

  it("does not treat a friendly greeting as a missing artifact", () => {
    const input = inputFor({ owner: false, trigger: "Hej igen!", content: "Hej! Kul att se dig." });
    expect(parse(input, [reviewFor(notDue)])?.reviews[0]).toMatchObject({
      severity: "none", issues: [], requestDelivery: notDue,
    });
  });

  it("assesses an owned acknowledgement against the greeting rather than an old artifact", () => {
    const content = "Hej! Kul att se dig.";
    const input = inputFor({ trigger: "Hej igen!", content });
    expect(parse(input, [reviewFor({
      status: "delivered",
      resolvedOutcome: "Acknowledge the current greeting, not an unrelated old promise.",
      deliveredExcerpt: content,
    })])?.reviews[0].severity).toBe("none");
  });

  it("makes a typed missing outcome block publication even if the issue list claims the draft is clean", () => {
    const parsed = parse(inputFor(), [reviewFor(missing)]);
    expect(parsed?.reviews[0]).toMatchObject({
      severity: "high",
      issues: ["unfulfilled_explicit_request"],
      requestDelivery: missing,
    });
    expect(parsed?.reviews[0].rewriteInstruction).toEqual(expect.any(String));
    expect(parsed?.reviews[0].rewriteInstruction?.length).toBeGreaterThan(0);
  });

  it("retains a separate grounding blocker while normalizing missing delivery", () => {
    const review = {
      ...reviewFor(missing),
      severity: "high",
      issues: ["evidence_ungrounded"],
      rewriteInstruction: "Do not invent facts; provide only the supported answer.",
    };
    const parsed = parse(inputFor(), [review]);
    expect(parsed?.reviews[0].severity).toBe("high");
    expect(parsed?.reviews[0].issues).toEqual(expect.arrayContaining([
      "evidence_ungrounded", "unfulfilled_explicit_request",
    ]));
  });

  it("never uses a delivered assessment to clear another publication blocker", () => {
    const input = inputFor({ content: "Northbridge won 5–0 today." });
    const review = {
      ...reviewFor({ status: "delivered", resolvedOutcome: "Report the final score.", deliveredExcerpt: "Northbridge won 5–0 today." }),
      severity: "high",
      issues: ["evidence_ungrounded"],
      rewriteInstruction: "Do not invent the score.",
    };
    expect(parse(input, [review])?.reviews[0]).toMatchObject({ severity: "high", issues: ["evidence_ungrounded"] });
  });

  it("never approves a delivery assessment that contradicts an existing missing-outcome blocker", () => {
    const input = inputFor({ content: "const copy = [...original];" });
    const parsed = parse(input, [{
      ...reviewFor({ status: "delivered", resolvedOutcome: "Provide a copy example.", deliveredExcerpt: "const copy = [...original];" }),
      severity: "high",
      issues: ["unfulfilled_explicit_request"],
      rewriteInstruction: "Provide the missing requested comparison as well.",
    }]);
    // Contradictory semantic dimensions may fail closed or retain the blocker,
    // but the structural provenance field cannot erase a substantive finding.
    expect(parsed === undefined || parsed.reviews[0].severity === "high").toBe(true);
  });

  it.each([
    ["sv", "Här är omskrivningen: Vi ses efter lunch.", "Vi ses efter lunch."],
    ["ja", "例はこれ。const copy = [...original];", "const copy = [...original];"],
    ["ar", "الاقتراح: نبدأ بالتجربة الصغيرة ثم نقارن النتيجة.", "نبدأ بالتجربة الصغيرة ثم نقارن النتيجة."],
  ])("accepts exact artifact provenance independent of content language (%s)", (_language, content, excerpt) => {
    const assessment: Delivery = { status: "delivered", resolvedOutcome: "Provide the agreed self-contained artifact.", deliveredExcerpt: excerpt };
    expect(parse(inputFor({ content }), [reviewFor(assessment)])?.reviews[0]).toMatchObject({ severity: "none", requestDelivery: assessment });
  });

  it.each(["delivered", "constrained"] as const)("rejects %s with an excerpt not present in the candidate", (status) => {
    const assessment: Delivery = { status, resolvedOutcome: "Provide the agreed artifact or precise existing constraint.", deliveredExcerpt: "This text does not occur in the draft." };
    expect(parse(inputFor(), [reviewFor(assessment)])).toBeUndefined();
  });

  it("does not accept a peer's excerpt as proof of the owner's delivery", () => {
    const base = inputFor();
    const input = candidateReviewInputSchema.parse({
      ...base,
      candidates: [
        base.candidates[0],
        { ...base.candidates[0], personaId: "ai-mira", actorName: "Mira", content: "Here is a peer's artifact.", mustFulfillRequest: false },
      ],
    });
    expect(parse(input, [
      reviewFor({ status: "delivered", resolvedOutcome: "Provide an artifact.", deliveredExcerpt: "Here is a peer's artifact." }),
      { ...reviewFor(notDue), personaId: "ai-mira" },
    ])).toBeUndefined();
  });

  it.each([
    { status: "not_due", resolvedOutcome: "A task", deliveredExcerpt: null },
    { status: "not_due", resolvedOutcome: null, deliveredExcerpt: "I can post" },
    { status: "delivered", resolvedOutcome: null, deliveredExcerpt: "I can post" },
    { status: "delivered", resolvedOutcome: "", deliveredExcerpt: "I can post" },
    { status: "delivered", resolvedOutcome: "A task", deliveredExcerpt: null },
    { status: "constrained", resolvedOutcome: "A task", deliveredExcerpt: "" },
    { status: "missing", resolvedOutcome: null, deliveredExcerpt: null },
    { status: "missing", resolvedOutcome: "x".repeat(221), deliveredExcerpt: null },
    { status: "delivered", resolvedOutcome: "A task", deliveredExcerpt: "x".repeat(301) },
  ] satisfies Delivery[])("rejects malformed or oversized delivery metadata %j", (assessment) => {
    expect(parse(inputFor(), [reviewFor(assessment)])).toBeUndefined();
  });

  it.each([
    { trigger: "Can you outline your plan, without doing it yet?", content: "First compare the two inputs, then test their differing cases.", outcome: "Outline the planned steps without executing them." },
    { trigger: "Where did we leave this?", content: "We agreed on the example, but I have not posted it yet.", outcome: "Give an honest current status, not the artifact itself." },
  ])("permits a reviewed planning/status answer as the requested deliverable: $trigger", ({ trigger, content, outcome }) => {
    expect(parse(inputFor({ trigger, content }), [reviewFor({ status: "delivered", resolvedOutcome: outcome, deliveredExcerpt: content })])?.reviews[0].severity).toBe("none");
  });

  it.each([
    { trigger: "Compare the two files.", content: "I only have the first file; could you attach the second?" },
    { trigger: "What will the official result be next week?", content: "The event has not happened, so I cannot report a result yet." },
  ])("preserves a reviewed concrete constraint instead of forcing invented completion: $trigger", ({ trigger, content }) => {
    expect(parse(inputFor({ trigger, content }), [reviewFor({ status: "constrained", resolvedOutcome: "Supply the requested comparison or result.", deliveredExcerpt: content })])?.reviews[0].severity).toBe("none");
  });

  it("accepts a constrained response for a trusted pre-execution refusal without inventing an attempt", () => {
    const base = inputFor({ content: "Not tonight, I don't feel like checking that site." });
    const input = candidateReviewInputSchema.parse({
      ...base,
      capabilityContext: {
        available: ["read_url"], externalEvidenceAvailable: true,
        requestKind: "execute", discussed: ["read_url"], plannedAction: "read_url", executionStatus: "declined",
      },
    });
    expect(parse(input, [reviewFor({ status: "constrained", resolvedOutcome: "Read the supplied page.", deliveredExcerpt: base.candidates[0].content })])?.reviews[0].severity).toBe("none");
  });

  it("excludes a server-confirmed failed-capability reporter from artifact delivery", () => {
    const base = inputFor({ owner: false, content: "The page did not open on this attempt." });
    const input = candidateReviewInputSchema.parse({
      ...base,
      evidence: { outcome: "failed", kind: null, query: null, results: [] },
      capabilityContext: {
        available: ["read_url"], externalEvidenceAvailable: true,
        requestKind: "execute", discussed: ["read_url"], plannedAction: "read_url", executionStatus: "failed_temporary",
      },
      candidates: [{ ...base.candidates[0], mustReportCapabilityFailure: true }],
    });
    expect(parse(input)).toBeDefined();
    expect(parse(input, [reviewFor(notDue)])?.reviews[0].issues).toEqual([]);
  });

  it("requires assessment for successful typed-capability ownership independently of low intent confidence", () => {
    const input = successfulEvidenceInput();
    expect(parse(input)).toBeUndefined();
    expect(parse(input, [reviewFor(missing)])?.reviews[0]).toMatchObject({ severity: "high", issues: ["unfulfilled_explicit_request"] });
    expect(parse(input, [reviewFor({ status: "delivered", resolvedOutcome: "Give the winner and score.", deliveredExcerpt: "Northbridge won, 2–1." })])?.reviews[0].severity).toBe("none");
  });

  it.each([
    { mode: "guarded_practical", trusted: true },
    { mode: "guarded_practical", trusted: false },
    { mode: "defensive_pivot", trusted: true },
  ] as const)("routes a missing permitted outcome through $mode (trusted=$trusted) without requesting a withheld action", ({ mode, trusted }) => {
    const base = inputFor({ content: "I might have a lab example for you later." });
    const input = candidateReviewInputSchema.parse({
      ...base,
      semanticContext: { ...base.semanticContext, operationalMode: mode, operationalModeTrusted: trusted },
    });
    const parsed = parse(input, [reviewFor({ ...missing, resolvedOutcome: "Give the permitted isolated lab example, not a real-target action." })]);
    expect(parsed?.reviews[0]).toMatchObject({ severity: "high", issues: ["operational_scope_mismatch"] });
    expect(parsed?.reviews[0].issues).not.toContain("unfulfilled_explicit_request");
  });

  it("requires only the eligible owner to have an assessment in strict parsing of a mixed scene", () => {
    const base = inputFor({ content: "const copy = [...original];" });
    const input = candidateReviewInputSchema.parse({
      ...base,
      candidates: [
        base.candidates[0],
        { ...base.candidates[0], personaId: "ai-mira", actorName: "Mira", mustFulfillRequest: false, content: "Nice!" },
      ],
    });
    const owner = reviewFor({ status: "delivered", resolvedOutcome: "Provide a copy example.", deliveredExcerpt: "const copy = [...original];" });
    expect(parse(input, [owner, { ...reviewFor(), personaId: "ai-mira" }])).toBeDefined();
    expect(parse(input, [reviewFor(), { ...reviewFor(notDue), personaId: "ai-mira" }])).toBeUndefined();
  });
});
