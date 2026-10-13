// REJECTED LIVE EXPERIMENT — NOT PRODUCTION. Retained for reproducibility;
// live evaluation exposed unacceptable false approvals of private-history claims.
import { z } from "zod";
import type { RequestDeliveryAssessment } from "../../server/requestDeliveryReview.js";

/** A decomposition made by the existing DM reviewer, never by a text heuristic. */
export const dmRequestDeliverySchema = z.object({
  parts: z.array(z.object({
    requestedOutcome: z.string().trim().min(1).max(220),
    status: z.enum(["delivered", "constrained", "missing"]),
    deliveredExcerpt: z.string().min(1).max(300).nullable(),
  }).strict()).max(6),
}).strict().superRefine((value, context) => {
  const outcomes = new Set<string>();
  value.parts.forEach((part, index) => {
    if (outcomes.has(part.requestedOutcome)) {
      context.addIssue({
        code: z.ZodIssueCode.custom, path: ["parts", index, "requestedOutcome"],
        message: "Each requested outcome must be assessed once",
      });
    }
    outcomes.add(part.requestedOutcome);
  });
});

export type DmRequestDelivery = z.infer<typeof dmRequestDeliverySchema>;

export const dmRequestDeliveryJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    parts: {
      type: "array", minItems: 0, maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          requestedOutcome: { type: "string", minLength: 1, maxLength: 220 },
          status: { type: "string", enum: ["delivered", "constrained", "missing"] },
          deliveredExcerpt: { type: ["string", "null"], minLength: 1, maxLength: 300 },
        },
        required: ["requestedOutcome", "status", "deliveredExcerpt"],
      },
    },
  },
  required: ["parts"],
};

/**
 * Validate transport integrity and conservatively aggregate the review into
 * the existing publication contract. Exact excerpts establish membership in
 * the candidate, not factual support or semantic completeness. Those remain
 * independent duties of the reviewer and its existing grounding checks.
 */
export const normalizeDmRequestDelivery = (
  value: unknown,
  candidateContent: string,
): RequestDeliveryAssessment | undefined => {
  const parsed = dmRequestDeliverySchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { parts } = parsed.data;
  // Eligibility is server-owned and enforced by the existing review schema;
  // this representation lets a mixed batch describe its non-owners too.
  if (parts.length === 0) return { status: "not_due", resolvedOutcome: null, deliveredExcerpt: null };
  for (const part of parts) {
    if (part.status !== "missing" && part.deliveredExcerpt === null) return undefined;
    if (part.deliveredExcerpt !== null && (
      !part.deliveredExcerpt.trim() || !candidateContent.includes(part.deliveredExcerpt)
    )) return undefined;
  }
  const status = parts.some((part) => part.status === "missing")
    ? "missing"
    : parts.some((part) => part.status === "constrained")
      ? "constrained"
      : "delivered";
  return {
    status,
    resolvedOutcome: parts.map((part) => part.requestedOutcome).join("; ").slice(0, 220),
    deliveredExcerpt: parts.find((part) => part.deliveredExcerpt !== null)?.deliveredExcerpt ?? null,
  };
};

// Replaces the single-outcome delivery guidance for eligible DM owners; it is
// not appended to it and does not introduce a second reviewer or source store.
export const DM_REQUEST_DELIVERY_REVIEW_GUIDANCE = `DM REQUEST DELIVERY: When the schema includes requestDelivery, non-owners use parts []. An eligible mustFulfillRequest owner cannot opt out: before judging its draft, independently identify every actual core outcome requested now from the newest trigger and bounded committed conversation. Return one to six distinct parts, including missing outcomes, not just a description of what the draft happens to offer. Acceptance or resumption of an earlier offer can request its result; an unrelated greeting does not activate an old commitment. Assess status or planning at that level. Do not add optional elaboration, formatting or invented tasks.
For each part give its requestedOutcome, status and one short exact deliveredExcerpt from this candidate, or null for a missing part. Delivered means that outcome is present now. Constrained means the candidate explains the necessary missing input, unavailable result or permitted refusal for that part. Missing means a feasible core outcome is omitted, replaced, merely offered or promised. A failed external lookup constrains only the affected external part: supported memory can still be delivered. Conversely, one delivered memory cannot excuse another missing feasible part. Do not demand an unavailable current answer or invented evidence. In guarded or pivot modes assess only the permitted safe outcome.
Each delivered or constrained part requires its own exact excerpt. Factual uncertainty is not itself a missing response when the candidate explains the actual evidence gap. Excerpts are audit pointers, not proof of truth or completeness: independently check the whole prose, including volunteered and negative or exclusive history claims. This delivery assessment never clears grounding, privacy, safety or any other issue. Existing evidence and commitment boundaries remain in force.`;
