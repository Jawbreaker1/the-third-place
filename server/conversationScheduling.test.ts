import { describe, expect, it } from "vitest";
import { conversationOpportunity, conversationReplyCandidatePool } from "./conversationScheduling.js";

describe("published-conversation scheduling", () => {
  it("does not prescribe an action or a minimum number of replies", () => {
    for (const publishedCount of [0, 1, 3, 7]) {
      expect(conversationOpportunity({ publishedCount, quietCandidateIds: [], eligibleIds: ["a", "b"] }))
        .toEqual({ status: "ready", candidateIds: ["a", "b"] });
    }
  });
  it("offers another resident a turn after one declines, then permits natural silence", () => {
    expect(conversationOpportunity({ publishedCount: 1, lastAuthorId: "a", quietCandidateIds: ["b"], eligibleIds: ["a", "b", "c"] }))
      .toEqual({ status: "ready", candidateIds: ["c"] });
    expect(conversationOpportunity({ publishedCount: 1, lastAuthorId: "a", quietCandidateIds: ["b", "c"], eligibleIds: ["d"] }).status)
      .toBe("quiet");
  });
  it("distinguishes a temporary missing speaker from genuine abstention", () => {
    expect(conversationOpportunity({ publishedCount: 1, lastAuthorId: "a", quietCandidateIds: [], eligibleIds: ["a"] }).status).toBe("wait");
    expect(conversationOpportunity({ publishedCount: 8, quietCandidateIds: [], eligibleIds: ["b"] }).status).toBe("budget");
  });

  it("gives the actual addressee a bounded opportunity without always closing the room into a pair", () => {
    const input = { latestMessageId: "reply", opportunity: { afterMessageId: "reply", actorId: "b" }, candidateIds: ["a", "b", "c"] };
    expect(conversationReplyCandidatePool({ ...input, random: 0.1 })).toEqual(["b"]);
    expect(conversationReplyCandidatePool({ ...input, random: 0.99 })).toEqual(["a", "c"]);
    expect(conversationReplyCandidatePool({ ...input, opportunity: undefined, random: 0 })).toBeUndefined();
    expect(conversationReplyCandidatePool({ ...input, candidateIds: ["b"], random: 0.99 })).toEqual(["b"]);
  });

  it("does not resurrect an old target or override availability and a decision to stay quiet", () => {
    const opportunity = { afterMessageId: "reply", actorId: "b" };
    expect(conversationReplyCandidatePool({ latestMessageId: "newer", opportunity, candidateIds: ["b"], random: 0 })).toBeUndefined();
    const eligible = conversationOpportunity({ publishedCount: 2, lastAuthorId: "a", quietCandidateIds: ["b"], eligibleIds: ["a", "b", "c"] });
    expect(conversationReplyCandidatePool({ latestMessageId: "reply", opportunity, candidateIds: eligible.candidateIds, random: 0 })).toBeUndefined();
    expect(conversationReplyCandidatePool({ latestMessageId: "reply", opportunity, candidateIds: ["c"], random: 0 })).toBeUndefined();
  });
});
