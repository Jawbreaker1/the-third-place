/** Resource policy only. Meaning, interest and the decision to speak are model-owned. */
export const CONVERSATION_MAX_PUBLICATIONS = 8;
export const CONVERSATION_MAX_QUIET_CANDIDATES = 2;

export interface ConversationReplyOpportunity {
  /** The published reply that actually selected the target, never a legacy automatic UI link. */
  afterMessageId: string;
  actorId: string;
}

/** A chance to respond, not an obligation. Do not compound it with returning-speaker bias. */
export function conversationReplyCandidatePool(input: {
  latestMessageId?: string;
  opportunity?: ConversationReplyOpportunity;
  candidateIds: readonly string[];
  random: number;
}): string[] | undefined {
  const opportunity = input.opportunity;
  if (!opportunity || opportunity.afterMessageId !== input.latestMessageId ||
      !input.candidateIds.includes(opportunity.actorId)) return undefined;
  const others = [...new Set(input.candidateIds)].filter((id) => id !== opportunity.actorId);
  // When the addressee does not win this opportunity, give the other eligible
  // residents a real opening rather than reselecting the same person via the
  // separate returning-participant preference.
  return input.random < 0.7 || !others.length ? [opportunity.actorId] : others;
}

export function conversationOpportunity(input: {
  publishedCount: number;
  lastAuthorId?: string;
  quietCandidateIds: readonly string[];
  eligibleIds: readonly string[];
}): { status: "ready" | "wait" | "quiet" | "budget"; candidateIds: string[] } {
  if (input.publishedCount >= CONVERSATION_MAX_PUBLICATIONS) return { status: "budget", candidateIds: [] };
  if (new Set(input.quietCandidateIds).size >= CONVERSATION_MAX_QUIET_CANDIDATES) {
    return { status: "quiet", candidateIds: [] };
  }
  const quiet = new Set(input.quietCandidateIds);
  const candidateIds = [...new Set(input.eligibleIds)]
    .filter((id) => id !== input.lastAuthorId && !quiet.has(id));
  return { status: candidateIds.length ? "ready" : "wait", candidateIds };
}
