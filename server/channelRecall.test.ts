import { describe, expect, it } from "vitest";
import type { ChatMessage, Member, ReplyPreview } from "../shared/types.js";
import { channelRecallTokens, recallChannelHistory } from "./channelRecall.js";

const start = Date.UTC(2026, 6, 14, 10, 0, 0);

const human = (id: string, name: string): Member => ({
  id,
  name,
  kind: "human",
  status: "offline",
  avatar: { color: "#111", accent: "#222", glyph: name[0] ?? "?" },
});

const message = (
  index: number,
  content: string,
  options: {
    id?: string;
    channelId?: string;
    authorId?: string;
    authorName?: string;
    system?: boolean;
    replyToId?: string;
    replyPreview?: ReplyPreview;
    reactions?: ChatMessage["reactions"];
    time?: number;
  } = {},
): ChatMessage => ({
  id: options.id ?? `message-${index.toString().padStart(3, "0")}`,
  channelId: options.channelId ?? "lobby",
  authorId: options.authorId ?? "human-filler",
  content,
  createdAt: new Date(options.time ?? start + index * 10_000).toISOString(),
  reactions: options.reactions ?? [],
  ...(options.authorName ? { authorSnapshot: human(options.authorId ?? "human-filler", options.authorName) } : {}),
  ...(options.system ? { system: true } : {}),
  ...(options.replyToId ? { replyToId: options.replyToId } : {}),
  ...(options.replyPreview ? { replyPreview: options.replyPreview } : {}),
});

const trigger = (index: number, channelId = "lobby"): ChatMessage =>
  message(index, "Kommer ni ihåg det här?", { id: "trigger", channelId, authorId: "human-question" });

describe("source-bound channel recall", () => {
  it("recalls Per with exact source messages after more than sixty later lines", () => {
    const messages = Array.from({ length: 78 }, (_, index) =>
      message(index, `bakgrund rad ${index} om vardagligt småprat`)
    );
    messages[5] = message(5, "Per joined the room", { authorId: "system", system: true });
    messages[6] = message(6, "Nu välkomnar vi Per", { authorId: "human-jaw", authorName: "Jaw_B" });
    messages[7] = message(7, "Är det verkligen gentilt att fråga efter sådant?", {
      authorId: "human-per",
      authorName: "Per",
    });
    messages[8] = message(8, "han är väl okej", {
      authorId: "ai-bosse",
      reactions: [{ emoji: "👀", memberIds: ["ai-mira"] }],
    });
    const latest = trigger(78);
    messages.push(latest);
    const recentMessageIds = messages.slice(-27).map((candidate) => candidate.id);

    const recalled = recallChannelHistory({
      messages,
      query: "Kommer ni ihåg Per?",
      trigger: latest,
      recentMessageIds,
      allowedPersonaIds: ["ai-bosse", "ai-mira", "ai-sana"],
    });

    expect(recalled).toBeDefined();
    expect(recalled!.messages.length).toBeLessThanOrEqual(8);
    expect(recalled!.messages.map((candidate) => candidate.id)).toEqual(expect.arrayContaining([
      "message-005",
      "message-006",
      "message-007",
      "message-008",
    ]));
    expect(recalled!.messages.every((candidate) => !recentMessageIds.includes(candidate.id))).toBe(true);
    expect(recalled!.matchedMessageIds).toEqual(expect.arrayContaining(["message-005", "message-006", "message-007"]));
    expect(recalled!.witnessPersonaIds).toEqual(["ai-bosse", "ai-mira"]);
  });

  it("tokenizes and retrieves across writing systems with Unicode case folding", () => {
    const fixtures = [
      { history: "Vi jämförde Straße med den nya vägen.", query: "Minns du STRASSE?" },
      { history: "将棋の定跡について長く話した。", query: "以前の将棋の話を覚えてる？" },
      { history: "تحدثنا عن الموسيقى الكلاسيكية", query: "ماذا قلنا عن الموسيقى؟" },
      { history: "हमने शतरंज की रणनीति पर चर्चा की", query: "शतरंज वाली चर्चा याद है?" },
    ];
    fixtures.forEach(({ history, query }, fixtureIndex) => {
      const messages = Array.from({ length: 24 }, (_, index) =>
        message(index, `neutral-${fixtureIndex}-${index}`)
      );
      messages[4] = message(4, history, { id: `unicode-${fixtureIndex}` });
      const latest = trigger(30);
      messages.push(latest);
      const result = recallChannelHistory({
        messages,
        query,
        trigger: latest,
        recentMessageIds: [],
        allowedPersonaIds: [],
      });
      expect(result?.matchedMessageIds, query).toContain(`unicode-${fixtureIndex}`);
    });
    expect(channelRecallTokens("Straße STRASSE")).toEqual(["strasse"]);
  });

  it("fails closed when every overlapping token is common in the retained corpus", () => {
    const messages = Array.from({ length: 30 }, (_, index) =>
      message(index, `shared update room ${index}`)
    );
    const latest = trigger(31);
    messages.push(latest);

    expect(recallChannelHistory({
      messages,
      query: "shared update",
      trigger: latest,
      recentMessageIds: [],
      allowedPersonaIds: [],
    })).toBeUndefined();
  });

  it("excludes other channels, future messages, old messages, the trigger and recent context", () => {
    const notBefore = start + 20 * 10_000;
    const latest = message(60, "recall nebula marker", { id: "trigger" });
    const messages = Array.from({ length: 55 }, (_, index) => message(index, `ordinary filler ${index}`));
    messages.push(
      message(2, "nebula marker", { id: "too-old" }),
      message(25, "nebula marker", { id: "valid-source" }),
      message(26, "nebula marker", { id: "other-channel", channelId: "ai-lab" }),
      message(55, "nebula marker", { id: "recent-source" }),
      latest,
      message(61, "nebula marker", { id: "future-source" }),
    );

    const result = recallChannelHistory({
      messages,
      query: "nebula marker",
      trigger: latest,
      notBefore: new Date(notBefore).toISOString(),
      recentMessageIds: ["recent-source"],
      allowedPersonaIds: [],
    });

    expect(result?.matchedMessageIds).toContain("valid-source");
    expect(result?.messages.every((candidate) => candidate.channelId === "lobby")).toBe(true);
    expect(result?.messages.every((candidate) => Date.parse(candidate.createdAt) >= notBefore)).toBe(true);
    expect(result?.messages.map((candidate) => candidate.id)).not.toEqual(expect.arrayContaining([
      "too-old",
      "other-channel",
      "recent-source",
      "trigger",
      "future-source",
    ]));
  });

  it("derives witnesses only from allowed AI authors and reactions directly in the episode window", () => {
    const replyTarget = message(0, "earlier unrelated line", { id: "reply-target", authorId: "ai-sana" });
    const messages = Array.from({ length: 30 }, (_, index) => message(index + 1, `filler ${index + 1}`));
    messages.push(replyTarget);
    messages[10] = message(11, "the quasar-detail starts here", {
      id: "matched",
      authorId: "human-one",
      replyToId: "reply-target",
      replyPreview: { authorId: "ai-sana", authorName: "Sana", content: "earlier unrelated line" },
      reactions: [{ emoji: "✨", memberIds: ["ai-juno", "not-allowed"] }],
    });
    messages[11] = message(12, "jag såg också det", { id: "mira-line", authorId: "ai-mira" });
    messages[12] = message(13, "fortsättning", {
      id: "preview-reply",
      authorId: "human-two",
      replyToId: "missing-target",
      replyPreview: { authorId: "ai-otto", authorName: "Otto", content: "gammal rad" },
    });
    messages[13] = message(14, "ignoreras som vittne", { authorId: "ai-disallowed" });
    const latest = trigger(40);
    messages.push(latest);

    const result = recallChannelHistory({
      messages,
      query: "quasar-detail",
      trigger: latest,
      recentMessageIds: [],
      allowedPersonaIds: ["ai-sana", "ai-juno", "ai-mira", "ai-otto"],
      maxMessages: 6,
    });

    expect(result?.witnessPersonaIds).toEqual(["ai-juno", "ai-mira"]);
    expect(result?.witnessPersonaIds).not.toContain("ai-sana");
    expect(result?.witnessPersonaIds).not.toContain("ai-otto");
    expect(result?.witnessPersonaIds).not.toContain("not-allowed");
    expect(result?.witnessPersonaIds).not.toContain("ai-disallowed");
  });

  it("is deterministic and caps caller-requested output at ten exact chronological sources", () => {
    const messages = Array.from({ length: 80 }, (_, index) =>
      message(index, index >= 20 && index < 32 ? `aurora detail ${index}` : `plain filler ${index}`)
    );
    const latest = trigger(90);
    messages.push(latest);
    const input = {
      query: "aurora detail",
      trigger: latest,
      recentMessageIds: [] as string[],
      allowedPersonaIds: [] as string[],
      maxMessages: 1_000,
    };

    const first = recallChannelHistory({ ...input, messages });
    const second = recallChannelHistory({ ...input, messages: [...messages].reverse() });

    expect(first?.messages).toHaveLength(10);
    expect(second?.messages.map((candidate) => candidate.id)).toEqual(first?.messages.map((candidate) => candidate.id));
    expect(first!.messages.map((candidate) => Date.parse(candidate.createdAt)))
      .toEqual([...first!.messages].map((candidate) => Date.parse(candidate.createdAt)).sort((left, right) => left - right));
    expect(first!.messages.every((candidate) => messages.includes(candidate))).toBe(true);
  });
});
