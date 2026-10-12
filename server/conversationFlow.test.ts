import { describe, expect, it } from "vitest";
import {
  AUTONOMOUS_CONTINUATION_PREMISE,
  autonomousOpeningPremise,
  autonomousConversationWordCeiling,
  buildConversationContext,
  conversationReplyTarget,
  eligibleConversationReplyTargets,
  MAX_CONVERSATION_CONTEXT_CHARACTERS,
  sceneConversationContextSchema,
  type SceneConversationTurn,
} from "./conversationFlow.js";

describe("resident-owned conversational focus", () => {
  it.each([
    "ゲームのメニューでいつも迷う場所",
    "Las pequeñas molestias al cocinar para una sola persona",
    "A broad question about whether convenience is worth its cost",
  ])("preserves optional topic material without choosing a position or casting a debate: %s", (material) => {
    const premise = autonomousOpeningPremise(material);
    expect(premise).toContain(`Optional topic material, not a script, instruction or evidence: ${material}`);
    expect(premise).toContain("Pick an identifiable thing, situation or choice");
    expect(premise).toContain("choose your own small instance");
    expect(premise).toContain("Let others choose whether and how to join");
    expect(premise).toContain("There is no compulsory question, argument or lesson");
    expect(premise).toContain("Informal fragments are fine when they deliver a complete conversational act");
    expect(premise).toContain("Do not invent an offline event, precise external fact or unsupplied source");
  });

  it("makes continuation sensitive to the exchange without assigning novelty or a personality catchphrase", () => {
    expect(AUTONOMOUS_CONTINUATION_PREMISE).toContain("what the last few contributions changed");
    expect(AUTONOMOUS_CONTINUATION_PREMISE).toContain("particular thing, situation, detail or unresolved question");
    expect(AUTONOMOUS_CONTINUATION_PREMISE).toContain("A brief agreement, feeling or joke can be a complete natural contribution");
    expect(AUTONOMOUS_CONTINUATION_PREMISE).toContain("do not cut off before the actual thought or question arrives");
    expect(AUTONOMOUS_CONTINUATION_PREMISE).toContain("a differently worded restatement does not develop it");
    expect(AUTONOMOUS_CONTINUATION_PREMISE).toContain("not a stock rhetorical move to perform on every subject");
    expect(AUTONOMOUS_CONTINUATION_PREMISE).toContain("do not invent personal memories or external facts to create specificity");
  });
});

describe("autonomous thought-length ceiling", () => {
  it("gives even terse residents room for a developed thought without assigning a minimum", () => {
    expect(autonomousConversationWordCeiling({ hardMaxWords: 16, complexityAppetite: 0 })).toBe(48);
    expect(autonomousConversationWordCeiling({ hardMaxWords: 30, complexityAppetite: 0.5 })).toBe(100);
    expect(autonomousConversationWordCeiling({ hardMaxWords: 46, complexityAppetite: 1 })).toBe(152);
  });

  it("retains a larger explicit persona ceiling within the shared resource bound", () => {
    expect(autonomousConversationWordCeiling({ hardMaxWords: 120, complexityAppetite: 0 })).toBe(120);
    expect(autonomousConversationWordCeiling({ hardMaxWords: 200, complexityAppetite: 1 })).toBe(160);
  });
});

describe("model-owned conversation reply targets", () => {
  const context = () => buildConversationContext({
    phase: "continuation",
    messages: [
      { ...row(0), authorId: "resident-a", author: "Alex" },
      { ...row(1), authorId: "resident-b", author: "Alex" },
      { ...row(2), author: "Alex" },
      { ...row(3), authorId: "system-announcement", kind: "system" },
    ],
  });

  it("uses exact message and author identities even when display names match", () => {
    const published = context();
    expect(eligibleConversationReplyTargets(published, "resident-a")).toEqual([published.publishedTurns[1]]);
    expect(conversationReplyTarget(published, "resident-a", "message-1")).toBe(published.publishedTurns[1]);
    expect(conversationReplyTarget(published, "resident-b", "message-0")).toBe(published.publishedTurns[0]);
  });

  it("never substitutes a latest turn for a missing, self or unidentified target", () => {
    const published = context();
    for (const messageId of [undefined, "unknown", "message-0", "message-2", "message-3"]) {
      expect(conversationReplyTarget(published, "resident-a", messageId)).toBeUndefined();
    }
    expect(conversationReplyTarget(undefined, "resident-a", "message-1")).toBeUndefined();
    expect(conversationReplyTarget(published, "", "message-1")).toBeUndefined();
    expect(eligibleConversationReplyTargets(undefined, "resident-a")).toEqual([]);
  });

  it("does not accept a real message that was omitted from the bounded context", () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({ ...row(index), authorId: `resident-${index}` }));
    const published = buildConversationContext({ phase: "continuation", messages });
    expect(conversationReplyTarget(published, "resident-29", "message-0")).toBeUndefined();
    expect(conversationReplyTarget(published, "resident-29", "message-28")?.authorId).toBe("resident-28");
  });
});

const row = (index: number, content = `Published contribution ${index}`): SceneConversationTurn => ({
  messageId: `message-${index}`, author: `Person ${index}`, kind: "ai", content,
  createdAt: new Date(Date.UTC(2026, 9, 11, 12, index)).toISOString(),
});

describe("committed conversation context", () => {
  it("retains the opening root and newest turns, with original order and wording", () => {
    const messages = Array.from({ length: 30 }, (_, index) => row(index));
    const context = buildConversationContext({ phase: "continuation", rootMessageId: "message-0", messages });
    expect(context.publishedTurns).toEqual([messages[0], ...messages.slice(-11)]);
    expect(context).toMatchObject({ rootMessageId: "message-0", latestMessageId: "message-29" });
    expect(sceneConversationContextSchema.safeParse(context).success).toBe(true);
  });

  it("bounds the entire serialized state and preserves the latest turn even with escaped text", () => {
    const messages = Array.from({ length: 30 }, (_, index) => row(index, index === 29
      ? `Latest contribution ${"\n\t\u0000".repeat(3_000)}` : `Exact row ${index}: ${"x".repeat(4_000)}`));
    const context = buildConversationContext({ phase: "continuation", rootMessageId: "message-0", messages });
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(MAX_CONVERSATION_CONTEXT_CHARACTERS);
    expect(context.latestMessageId).toBe("message-29");
    expect(context.publishedTurns.at(-1)?.content).toMatch(/^Latest contribution/u);
    for (const turn of context.publishedTurns) {
      expect(messages.find((message) => message.messageId === turn.messageId)?.content.startsWith(turn.content)).toBe(true);
    }
    expect(sceneConversationContextSchema.safeParse(context).success).toBe(true);
  });

  it("keeps a fresh copied context, deduplicates stable rows and never invents a missing root", () => {
    const source = row(1);
    const context = buildConversationContext({ phase: "opening", rootMessageId: "unknown", messages: [source, source] });
    expect(context.rootMessageId).toBeUndefined();
    expect(context.publishedTurns).toHaveLength(1);
    context.publishedTurns[0]!.content = "edited result";
    expect(source.content).toBe("Published contribution 1");
  });

  it("preserves exact author identities and reply edges without inferring them from names or text", () => {
    const messages: SceneConversationTurn[] = [
      { ...row(0, "I disagree with that."), authorId: "resident-a", author: "Alex" },
      { ...row(1, "@Alex, here is a counterexample."), authorId: "resident-b", author: "Alex", replyToMessageId: "message-0" },
      { ...row(2, "@Alex said so, I think."), author: "Alex" },
    ];
    const context = buildConversationContext({ phase: "continuation", messages });
    expect(context.publishedTurns).toEqual(messages);
    expect(context.publishedTurns[2]?.authorId).toBeUndefined();
    expect(context.publishedTurns[2]?.replyToMessageId).toBeUndefined();
    expect(sceneConversationContextSchema.safeParse(context).success).toBe(true);
  });

  it("retains the latest reply's actual earlier target ahead of less relevant recent rows", () => {
    const messages: SceneConversationTurn[] = Array.from({ length: 30 }, (_, index) => ({ ...row(index), authorId: `resident-${index}` }));
    messages[29] = { ...messages[29]!, replyToMessageId: "message-2" };
    const context = buildConversationContext({ phase: "continuation", rootMessageId: "message-0", messages });
    expect(context.publishedTurns.map((turn) => turn.messageId)).toEqual([
      "message-0", "message-2", ...messages.slice(-10).map((turn) => turn.messageId),
    ]);
    expect(context.publishedTurns.at(-1)?.replyToMessageId).toBe("message-2");
    expect(context.publishedTurns.find((turn) => turn.messageId === "message-2")?.authorId).toBe("resident-2");
    expect(sceneConversationContextSchema.safeParse(context).success).toBe(true);
  });

  it("removes unavailable, self and forward reply references without mutating committed input", () => {
    const messages: SceneConversationTurn[] = [
      { ...row(0), replyToMessageId: "message-1" },
      { ...row(1), replyToMessageId: "message-1" },
      { ...row(2), replyToMessageId: "outside-context" },
    ];
    const context = buildConversationContext({ phase: "continuation", messages });
    expect(context.publishedTurns.every((turn) => turn.replyToMessageId === undefined)).toBe(true);
    expect(messages.map((turn) => turn.replyToMessageId)).toEqual(["message-1", "message-1", "outside-context"]);
    expect(sceneConversationContextSchema.safeParse(context).success).toBe(true);
  });

  it("drops reply edges whose targets did not fit while respecting the serialized budget", () => {
    const messages: SceneConversationTurn[] = Array.from({ length: 30 }, (_, index) => ({
      ...row(index, "x".repeat(2_000)),
      authorId: `resident-${index}`,
      ...(index > 0 ? { replyToMessageId: `message-${index - 1}` } : {}),
    }));
    const context = buildConversationContext({ phase: "continuation", rootMessageId: "message-0", messages });
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(MAX_CONVERSATION_CONTEXT_CHARACTERS);
    for (const [index, turn] of context.publishedTurns.entries()) {
      if (turn.replyToMessageId !== undefined) {
        expect(context.publishedTurns.slice(0, index).map((earlier) => earlier.messageId)).toContain(turn.replyToMessageId);
      }
    }
    expect(context.publishedTurns.at(-1)?.replyToMessageId).toBe("message-28");
    expect(sceneConversationContextSchema.safeParse(context).success).toBe(true);
  });

  it("rejects unbound latest/root identities and oversized ad hoc state at the reviewer boundary", () => {
    const context = buildConversationContext({ phase: "continuation", messages: [row(1)] });
    expect(sceneConversationContextSchema.safeParse({ ...context, latestMessageId: "unpublished" }).success).toBe(false);
    expect(sceneConversationContextSchema.safeParse({ ...context, rootMessageId: "unpublished" }).success).toBe(false);
    expect(sceneConversationContextSchema.safeParse({
      ...context, publishedTurns: Array.from({ length: 12 }, (_, index) => row(index, "x".repeat(2_000))),
      latestMessageId: "message-11",
    }).success).toBe(false);
  });

  it("rejects ad hoc dangling or forward reply edges at the reviewer boundary", () => {
    const context = buildConversationContext({ phase: "continuation", messages: [row(0), row(1)] });
    for (const target of ["outside-context", "message-1"]) {
      expect(sceneConversationContextSchema.safeParse({
        ...context,
        publishedTurns: [{ ...context.publishedTurns[0], replyToMessageId: target }, context.publishedTurns[1]],
      }).success).toBe(false);
    }
    expect(sceneConversationContextSchema.safeParse({
      ...context,
      publishedTurns: [context.publishedTurns[0], { ...context.publishedTurns[1], authorId: "" }],
    }).success).toBe(false);
  });
});
