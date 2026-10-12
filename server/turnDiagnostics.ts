import { CANDIDATE_REVIEW_ISSUES, TURN_CAPABILITIES } from "./semanticRouter.js";

export interface TurnDiagnosticContext {
  kind: string;
  channelId?: string;
  trigger?: { messageId?: string; authorKind?: string };
}

const OUTCOMES = [
  "started", "completed", "published", "abstained", "empty", "rejected",
  "unavailable", "failed", "cancelled", "deferred", "superseded", "expired",
  "capacity_limited", "suppressed", "retrying", "selected", "invalid_output", "recovered",
] as const;
const STAGES = ["turn", "routing", "selection", "capability", "queue", "generation", "draft", "review", "filter", "recovery", "publication"] as const;
const MECHANICAL_ISSUES = ["near_duplicate_self", "near_duplicate_peer", "reused_opening", "assistant_cliche", "ai_meta_language", "overly_polished", "register_mismatch", "list_like_reply", "evidence_denial", "evidence_ungrounded", "room_contract", "style_contract"] as const;
const CAPABILITY_STATES = ["grounding_available", "retrieved_only", "failed_temporary", "declined"] as const;
const NUMBER_FIELDS = [
  "durationMs", "queueWaitMs", "queueDepth", "activeCount", "candidateCount",
  "acceptedCount", "publishedCount", "selectedCount", "requiredCount", "attempt",
  "historyTurns", "conversationTurns", "recallTurns",
] as const;

export type TurnDiagnosticEvent = {
  stage: (typeof STAGES)[number];
  outcome: (typeof OUTCOMES)[number];
  analysisSource?: "lm" | "fallback";
  evidenceAction?: "none" | (typeof TURN_CAPABILITIES)[number];
  replyExpected?: "none" | "optional" | "expected";
  reviewIssues?: readonly string[];
  mechanicalIssues?: readonly string[];
  capabilityState?: (typeof CAPABILITY_STATES)[number];
} & Partial<Record<(typeof NUMBER_FIELDS)[number], number>>;

/** Operational metadata only. No body, query, URL, draft, memory or error text.
 * The projection is deliberately explicit even though callsites are typed:
 * diagnostic extras must never start logging prompt content by accident.
 * This is a synchronous bounded event, not another in-memory/persistent ledger.
 */
export const recordTurnDiagnostic = (
  context: TurnDiagnosticContext,
  event: TurnDiagnosticEvent,
  sink: (line: string) => void = (line) => console.info(line),
): void => {
  try {
    if ((context.kind !== "public" && context.kind !== "dm") ||
        !context.trigger?.messageId || context.trigger.authorKind === "ai") return;
    if (!STAGES.includes(event.stage) || !OUTCOMES.includes(event.outcome)) return;
    const entry: Record<string, unknown> = {
      event: "interactive_turn",
      timestamp: new Date().toISOString(),
      medium: context.kind,
      triggerMessageId: context.trigger.messageId.slice(0, 160),
      channelId: context.channelId?.slice(0, 160),
      stage: event.stage,
      outcome: event.outcome,
    };
    for (const field of NUMBER_FIELDS) {
      const value = event[field];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        entry[field] = Math.round(value);
      }
    }
    if (event.analysisSource === "lm" || event.analysisSource === "fallback") entry.analysisSource = event.analysisSource;
    if (event.replyExpected && ["none", "optional", "expected"].includes(event.replyExpected)) entry.replyExpected = event.replyExpected;
    if (event.evidenceAction && ["none", ...TURN_CAPABILITIES].includes(event.evidenceAction)) entry.evidenceAction = event.evidenceAction;
    if (event.capabilityState && CAPABILITY_STATES.includes(event.capabilityState)) entry.capabilityState = event.capabilityState;
    if (event.reviewIssues) {
      entry.reviewIssues = [...new Set(event.reviewIssues.filter((issue) =>
        (CANDIDATE_REVIEW_ISSUES as readonly string[]).includes(issue),
      ))].slice(0, CANDIDATE_REVIEW_ISSUES.length);
    }
    if (event.mechanicalIssues) {
      entry.mechanicalIssues = [...new Set(event.mechanicalIssues.filter((issue) =>
        (MECHANICAL_ISSUES as readonly string[]).includes(issue),
      ))].slice(0, MECHANICAL_ISSUES.length);
    }
    sink(JSON.stringify(entry));
  } catch {
    // A broken logging sink must never change a routing/publication decision.
  }
};
