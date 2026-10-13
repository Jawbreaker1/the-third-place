import { describe, expect, it } from "vitest";
import {
  candidateReviewInputSchema,
  parseCandidateReviewContent,
  type CandidateReviewSeverity,
} from "./semanticRouter.js";

const boundary = "I'd rather keep other people's private conversations private.";
const reviewInput = (content = boundary, sceneKind: "dm" | "voice" = "dm") => candidateReviewInputSchema.parse({
  sceneKind,
  room: { id: "synthetic-personal-context", name: "Private chat", register: "everyday" },
  trigger: { author: "Sam", content: "What did Lea tell you in private?", createdAt: "2026-10-13T08:30:00.000Z", ageSeconds: 0 },
  premise: null,
  semanticContext: { languageTag: "en", intentTrusted: true, replyExpected: "expected",
    asksForList: false, asksAboutAiIdentity: false, asksAboutAcoustics: false },
  voiceFacts: null,
  temporalContext: {
    sceneClock: { timeZone: "Europe/Stockholm", locationLabel: "Sweden", instant: "2026-10-13T08:30:00.000Z",
      localDate: "2026-10-13", localTime: "10:30:00", utcOffset: "GMT+02:00", weekday: "Tuesday", daypart: "morning" },
    requestedClock: null, surfacePolicy: "reactive_only", surfaceActorId: null, recentTimeline: [],
  },
  evidence: { outcome: "none", kind: null, query: null, results: [] },
  candidates: [{ personaId: "ai-mira", actorName: "Mira", content, sourceIds: [], mustReply: true, mustFulfillRequest: true,
    surfaceStylePlan: { visibleAffect: false, surfaceTexture: null }, recentOwnTexts: [], peerTexts: [] }],
});

const constrainedReview = () => ({
  personaId: "ai-mira", severity: "none" as CandidateReviewSeverity, issues: [] as string[], rewriteInstruction: null as string | null,
  sameSceneOverlap: "none", outputLanguage: { tag: "en", confidence: 1 },
  requestDelivery: { resolvedOutcome: "Respond to a request for a third person's private information without exposing it.",
    status: "constrained", deliveredExcerpt: boundary },
});

describe("personal-context entailment contract", () => {
  // Contract tests establish existing schema behavior, not the
  // semantic correctness of a handwritten verdict. The isolated reviewer eval
  // supplies independent positive/negative contrastives for actual Gemma runs.
  it.each(["dm", "voice"] as const)("allows a complete constrained privacy boundary without requiring other private data in %s", (kind) => {
    const input = reviewInput(boundary, kind);
    const review = constrainedReview();
    const parsed = parseCandidateReviewContent(JSON.stringify({ reviews: [review] }), input, { requireDeliveryAssessment: true });
    expect(parsed?.reviews[0]).toEqual(review);
    expect(input.roomRecall).toBeNull();
    expect(input.candidates[0].privateRelationshipNote).toBeNull();
    expect(input.candidates[0].publicParticipantNote).toBeNull();
  });

  it.each(["dm", "voice"] as const)("uses the existing evidence_ungrounded blocker, not a relaxed publication path, in %s", (kind) => {
    const candidate = "We've never spoken privately; this was our only conversation.";
    const input = reviewInput(candidate, kind);
    const review = {
      ...constrainedReview(), severity: "high", issues: ["evidence_ungrounded"],
      rewriteInstruction: "Use a privacy boundary without asserting that unavailable private contact never occurred.",
      requestDelivery: { resolvedOutcome: "Respond to the request for private information.", status: "delivered", deliveredExcerpt: candidate },
    };
    expect(parseCandidateReviewContent(JSON.stringify({ reviews: [review] }), input, { requireDeliveryAssessment: true })?.reviews[0].severity).toBe("high");
    for (const severity of ["none", "low", "medium"] as const) {
      expect(parseCandidateReviewContent(JSON.stringify({ reviews: [{ ...review, severity }] }), input, { requireDeliveryAssessment: true })).toBeUndefined();
    }
  });

  it("requires an exact candidate excerpt even when a privacy boundary is assessed as constrained", () => {
    const input = reviewInput();
    const review = constrainedReview();
    review.requestDelivery.deliveredExcerpt = "A different boundary that the candidate did not say.";
    expect(parseCandidateReviewContent(JSON.stringify({ reviews: [review] }), input, { requireDeliveryAssessment: true })).toBeUndefined();
  });
});
