import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../shared/types.js";
import { recallWitnessedPublicConversation } from "./dmPublicContext.js";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 13, 10, minute)).toISOString();
const row = (id: string, authorId: string, minute: number, channelId = "lobby", content = "An actual public message."): ChatMessage => ({
  id, authorId, channelId, content, createdAt: at(minute), reactions: [],
});
const input = (messages: ChatMessage[]) => ({
  messages, channels: [{ id: "lobby", name: "Lobby" }, { id: "pingu", name: "Pingu" }],
  ownerId: "ai-mira", subjects: [{ id: "human-lumi", displayLabel: "Lumi" }],
  trigger: { id: "dm-question", createdAt: at(30) },
});

describe("witness-bound public context for a private conversation", () => {
  it.each(["", "௰"])("keeps stable-ID public recall independent of display-label tokenization (%j)", (displayLabel) => {
    const messages = [row("subject", "human-lumi", 20), row("witness", "ai-mira", 21)];
    const request = { ...input(messages), subjects: [{ id: "human-lumi", displayLabel }] };
    const recalled = recallWitnessedPublicConversation(request);
    expect(recalled).toEqual(recallWitnessedPublicConversation(input(messages)));
    expect(recalled?.recall.anchorMessageIds).toEqual(["subject"]);
    expect(recalled?.recall.witnessPersonaIds).toEqual(["ai-mira"]);
    expect(recallWitnessedPublicConversation({ ...request, subjects: [] })).toBeUndefined();
    expect(recallWitnessedPublicConversation({ ...request, subjects: [{ id: "different-person", displayLabel }] })).toBeUndefined();
    expect(recallWitnessedPublicConversation({ ...request, messages: [messages[0]!] })).toBeUndefined();
    expect(recallWitnessedPublicConversation({
      ...request, messages: messages.map((message) => ({ ...message, channelId: "dm:other" })),
    })).toBeUndefined();
  });

  it.each([false, true])("keeps a recent witnessed exchange despite denser old messages (old witness: %s)", (oldWitness) => {
    const messages = Array.from({ length: 22 }, (_, index) => row(`dense-${index}`, (
      index < 8 || index === 20 ? "human-lumi" : index === 21 ? "ai-mira" : "human-other"
    ), index));
    if (oldWitness) messages[3]!.reactions = [{ emoji: "👀", memberIds: ["ai-mira"] }];

    const result = recallWitnessedPublicConversation(input(messages));
    expect(result?.recall.messages).toHaveLength(8);
    expect(result?.recall.anchorMessageIds).toContain("dense-20");
    expect(result?.recall.messages.map((message) => message.id)).toContain("dense-21");
    expect(result?.recall.witnessPersonaIds).toEqual(["ai-mira"]);
  });

  it("does not infer cross-channel ordering for messages at the exact DM trigger timestamp", () => {
    expect(recallWitnessedPublicConversation(input([
      row("a-anchor", "human-lumi", 30), row("b-witness", "ai-mira", 30),
    ]))).toBeUndefined();
    expect(recallWitnessedPublicConversation({
      ...input([row("anchor", "human-lumi", 20), row("witness", "ai-mira", 21)]),
      trigger: { id: "dm-question", createdAt: "invalid" },
    })).toBeUndefined();
  });

  it("retrieves the latest witnessed public encounter with its original room and exact authors", () => {
    const result = recallWitnessedPublicConversation(input([
      row("old", "human-lumi", 1), row("old-reply", "ai-mira", 2),
      row("new", "human-lumi", 20, "pingu"), row("new-reply", "ai-mira", 21, "pingu"),
    ]));
    expect(result?.sourceChannel).toEqual({ id: "pingu", name: "Pingu" });
    expect(result?.recall.messages.map((message) => message.id)).toEqual(["new", "new-reply"]);
    expect(result?.recall.rows[0]?.anchorMatches).toContain("author_identity");
    expect(result?.recall.witnessPersonaIds).toEqual(["ai-mira"]);
  });

  it("does not turn presence elsewhere in a room into a witness to this exchange", () => {
    expect(recallWitnessedPublicConversation(input([
      row("mira-earlier", "ai-mira", 1), row("lumi-later", "human-lumi", 20),
      row("other-witness", "ai-juno", 21),
    ]))).toBeUndefined();
  });

  it("excludes private/removed rooms, system rows and messages after the DM trigger", () => {
    const system = { ...row("system", "ai-mira", 21), system: true };
    expect(recallWitnessedPublicConversation(input([
      row("secret", "human-lumi", 10, "dm:other"), row("secret-reply", "ai-mira", 11, "dm:other"),
      row("removed", "human-lumi", 10, "removed-room"), row("removed-reply", "ai-mira", 11, "removed-room"),
      row("lumi", "human-lumi", 20), system, row("future-reply", "ai-mira", 31),
    ]))).toBeUndefined();
  });

  it("never substitutes a same-label topic or another person's author ID", () => {
    expect(recallWitnessedPublicConversation(input([
      row("topic", "human-other", 20, "lobby", "Lumi is the product we were discussing."),
      row("mira", "ai-mira", 21),
    ]))).toBeUndefined();
    expect(recallWitnessedPublicConversation({ ...input([]), subjects: [] })).toBeUndefined();
  });

  it("accepts an actual reaction witness and stays within eight rows", () => {
    const messages = Array.from({ length: 16 }, (_, index) => ({
      ...row(`row-${index}`, "human-lumi", index),
      reactions: [{ emoji: "👀", memberIds: ["ai-mira"] }],
    }));
    const result = recallWitnessedPublicConversation(input(messages));
    expect(result?.recall.messages).toHaveLength(8);
    expect(result?.recall.witnessPersonaIds).toEqual(["ai-mira"]);
  });
});
