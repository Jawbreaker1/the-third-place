import { z } from "zod";
import type { NormalizedCandidateReviewInput } from "./semanticRouter.js";

/** This is a semantic result from the existing reviewer, not a text heuristic. */
export const requestDeliverySchema = z.object({
  status: z.enum(["not_due", "delivered", "constrained", "missing"]),
  resolvedOutcome: z.string().trim().min(1).max(220).nullable(),
  deliveredExcerpt: z.string().min(1).max(300).nullable(),
}).strict();

export type RequestDeliveryAssessment = z.infer<typeof requestDeliverySchema>;

type ReviewCandidate = NormalizedCandidateReviewInput["candidates"][number];

/** Reuse trusted request ownership; an old memory cannot create a new duty. */
export const requiresRequestDeliveryAssessment = (
  input: NormalizedCandidateReviewInput,
  candidate: ReviewCandidate,
): boolean => candidate.mustFulfillRequest && !candidate.mustReportCapabilityFailure && (
  (input.semanticContext.intentTrusted && input.semanticContext.replyExpected === "expected") ||
  (input.evidence.outcome === "succeeded" && Boolean(input.capabilityContext?.plannedAction) &&
    input.capabilityContext?.executionStatus === "succeeded")
);

export const requestDeliveryFailureIssue = (
  input: NormalizedCandidateReviewInput,
): "unfulfilled_explicit_request" | "operational_scope_mismatch" =>
  input.semanticContext.operationalMode === "guarded_practical" ||
  (input.semanticContext.operationalMode === "defensive_pivot" &&
    input.semanticContext.operationalModeTrusted)
    ? "operational_scope_mismatch" : "unfulfilled_explicit_request";

export const requestDeliveryJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    resolvedOutcome: { type: ["string", "null"], minLength: 1, maxLength: 220 },
    status: { type: "string", enum: ["not_due", "delivered", "constrained", "missing"] },
    deliveredExcerpt: { type: ["string", "null"], minLength: 1, maxLength: 300 },
  },
  required: ["resolvedOutcome", "status", "deliveredExcerpt"],
};

export const REQUEST_DELIVERY_REVIEW_GUIDANCE = `REQUEST DELIVERY ASSESSMENT: When the response schema includes requestDelivery, decide it BEFORE style/grounding issues, for each candidate independently. For a trusted expected mustFulfillRequest owner, resolve the concrete outcome due NOW from the newest turn and bounded committed conversation, not from what the candidate happens to offer. Acceptance or resumption of a clear earlier offer requests its result even without repeating the task. Private memory may disambiguate the offer, never create a duty on an unrelated greeting. Non-owners and failure reporters use not_due with both text fields null. An expected owner cannot opt out with not_due: an actual greeting/status/planning request is delivered by that response, not by an unsolicited old task. Describe only this owner's task; never copy another candidate's uncommitted draft, private note or hidden review instructions into resolvedOutcome.
Write resolvedOutcome as a short description of the actual requested result, not the candidate's substitute. Then classify: delivered = that result is present in the candidate now; missing = a core result is absent, partial or merely promised/offered/announced; constrained = the candidate actually explains a necessary missing input, unavailable external result or permitted refusal instead of pretending success. A status/plan request is delivered by a real status/plan; do not demand the future work itself. Readiness or an offer to send an already requested self-contained result is missing, not a constraint. Never require optional elaboration or unrequested formatting. In guarded/pivot modes assess only the permitted safe outcome, never the withheld action.
For delivered/constrained, deliveredExcerpt is ONE SHORT exact span (normally 15–80 characters) containing part of the actual result or concrete constraint. Choose a useful line or clause, not its introduction or an entire artifact/code block. The excerpt is an audit pointer, not the whole proof: assess the complete candidate. Null for missing is allowed. Missing requires high unfulfilled_explicit_request (operational_scope_mismatch in guarded/pivot). This assessment cannot clear factual, safety or other issues. Newly composed examples, explanations and creative artifacts require no external citation. Trace their complete internal sequence: carry established state forward, never reset it at a subsection label, and judge each observation at the point it occurs. Before alleging a defect, compare the candidate's exact assertion with your proposed correction: if they agree, there is no contradiction to repair. Missing optional explanatory output or an alternative presentation is not a factual error. Historical retrieval, current facts and external/source claims still require their existing evidence.`;
