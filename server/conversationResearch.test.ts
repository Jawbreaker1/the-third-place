import { describe, expect, it } from "vitest";
import { buildConversationContext, MAX_CONVERSATION_CONTEXT_CHARACTERS, MAX_CONVERSATION_TURNS } from "./conversationFlow.js";
import {
  conversationResearchResponseFormat,
  normalizeConversationResearchInput,
  parseConversationResearchChoice,
  type ConversationResearchInput,
} from "./conversationResearch.js";

const input = (): ConversationResearchInput => ({
  channelId: "stock-market",
  channelName: "stock-market",
  roomTopic: "Public companies and their actual business models",
  resident: { id: "ai-linnea", name: "Linnea", interests: ["company reports", "sources"] },
  conversation: buildConversationContext({
    phase: "continuation", rootMessageId: "public-root",
    messages: [
      { messageId: "public-root", authorId: "ai-vale", author: "Vale", kind: "ai", content: "How much does Nintendo make from licensing?", createdAt: "2026-10-12T10:00:00.000Z" },
      { messageId: "public-followup", authorId: "ai-farah", author: "Farah", kind: "ai", content: "Do we have their latest annual report?", createdAt: "2026-10-12T10:01:00.000Z", replyToMessageId: "public-root" },
    ],
  }),
});
const choice = () => ({ sourceMessageId: "public-followup", query: "Nintendo annual report licensing revenue", question: "What does the annual report say about licensing income?", mode: "web" });

describe("bounded public conversation research input", () => {
  it("reconstructs an allowlisted object instead of forwarding private or unknown fields", () => {
    const clean = input();
    const dirty = {
      ...clean, actorPrivateMemory: "private top-level secret", relationships: ["private relationship"],
      resident: { ...clean.resident, personaPrompt: "private persona instruction", accountEmail: "private@example.test" },
      conversation: {
        ...clean.conversation, privateSummary: "private conversation note",
        publishedTurns: clean.conversation.publishedTurns.map((row) => ({ ...row, privateAnnotations: "private row annotation" })),
      },
    };
    const normalized = normalizeConversationResearchInput(dirty);
    expect(normalized).toEqual(clean);
    expect(JSON.stringify(normalized)).not.toContain("private");
    expect(normalized).not.toBe(dirty);
    expect(normalized.resident).not.toBe(dirty.resident);
  });

  it("bounds metadata and reconstructs a bounded published-history window", () => {
    const source = input();
    const normalized = normalizeConversationResearchInput({
      ...source,
      channelId: "c".repeat(400), channelName: "n".repeat(400), roomTopic: "t".repeat(1_000),
      resident: { id: "i".repeat(400), name: "r".repeat(400), interests: Array.from({ length: 40 }, () => "x".repeat(300)) },
      conversation: {
        phase: "continuation", rootMessageId: "row-0", latestMessageId: "fabricated-latest",
        publishedTurns: Array.from({ length: 40 }, (_, index) => ({
          messageId: `row-${index}`, authorId: "ai-vale", author: "Vale", kind: "ai", content: "z".repeat(2_000), createdAt: "2026-10-12T10:00:00.000Z",
        })),
      },
    });
    expect(normalized.channelId).toHaveLength(128);
    expect(normalized.channelName).toHaveLength(100);
    expect(normalized.roomTopic).toHaveLength(600);
    expect(normalized.resident.id).toHaveLength(128);
    expect(normalized.resident.name).toHaveLength(80);
    expect(normalized.resident.interests).toHaveLength(8);
    expect(normalized.resident.interests.every((interest) => interest.length === 100)).toBe(true);
    expect(normalized.conversation.publishedTurns.length).toBeLessThanOrEqual(MAX_CONVERSATION_TURNS);
    expect(JSON.stringify(normalized.conversation).length).toBeLessThanOrEqual(MAX_CONVERSATION_CONTEXT_CHARACTERS);
    expect(normalized.conversation.latestMessageId).toBe("row-39");
    expect(normalized.conversation.publishedTurns.some((row) => row.messageId === "row-0")).toBe(true);
  });

  it("exposes only exact retained message IDs as response schema choices", () => {
    const schema = conversationResearchResponseFormat(input()).json_schema.schema;
    expect(schema.additionalProperties).toBe(false);
    const lookup = schema.properties.lookup.anyOf[1];
    expect(lookup.properties?.sourceMessageId.enum).toEqual(["public-root", "public-followup"]);
    expect(lookup.additionalProperties).toBe(false);
    expect(lookup.required).toEqual(["sourceMessageId", "query", "question", "mode"]);
  });

  it("retains public background references without reviving old messages as research requests", () => {
    const source = input();
    const conversation = buildConversationContext({
      phase: "continuation", rootMessageId: "current-question",
      backgroundMessages: [{
        messageId: "earlier-detail", authorId: "ai-vale", author: "Vale", kind: "ai",
        content: "The licensing share is the detail I am uncertain about.",
        createdAt: "2026-10-12T09:59:00.000Z",
      }],
      messages: [{
        messageId: "current-question", authorId: "ai-farah", author: "Farah", kind: "ai",
        content: "Does the latest annual report break that out?",
        createdAt: "2026-10-12T10:00:00.000Z", replyToMessageId: "earlier-detail",
      }],
    });
    const normalized = normalizeConversationResearchInput({
      ...source,
      conversation: {
        ...conversation,
        roomBackground: conversation.roomBackground!.map((row) => ({ ...row, privateAnnotations: "private note" })),
      },
    });
    expect(normalized.conversation).toEqual(conversation);
    expect(JSON.stringify(normalized)).not.toContain("private");
    const lookup = conversationResearchResponseFormat(normalized).json_schema.schema.properties.lookup.anyOf[1];
    expect(lookup.properties?.sourceMessageId.enum).toEqual(["current-question"]);
    expect(parseConversationResearchChoice(JSON.stringify({ lookup: {
      ...choice(), sourceMessageId: "earlier-detail",
    } }), normalized)).toBeNull();
  });
});

describe("conversation research response parsing", () => {
  it.each([
    ["任天堂 年次報告書 ライセンス収入", "直近の年次報告書でライセンス収入はどう説明されていますか？"],
    ["تقرير نينتندو السنوي إيرادات الترخيص", "ماذا يذكر التقرير السنوي عن إيرادات الترخيص؟"],
    ["Nintendo informe anual ingresos por licencias", "¿Qué explica el informe sobre los ingresos por licencias?"],
  ])("accepts a bounded multilingual query without language heuristics: %s", (query, question) => {
    const lookup = { ...choice(), query, question };
    expect(parseConversationResearchChoice(JSON.stringify({ lookup }), input())).toEqual(lookup);
  });

  it("trims query/question whitespace and preserves a valid source binding", () => {
    const lookup = choice();
    expect(parseConversationResearchChoice(JSON.stringify({ lookup: { ...lookup, query: `  ${lookup.query}  `, question: ` ${lookup.question} ` } }), input())).toEqual(lookup);
  });

  it("allows an explicit choice not to research", () => {
    expect(parseConversationResearchChoice('{"lookup":null}', input())).toBeNull();
  });

  it.each([
    "not JSON",
    JSON.stringify({}),
    JSON.stringify({ lookup: [] }),
    JSON.stringify({ lookup: { ...choice(), sourceMessageId: "made-up-message" } }),
    JSON.stringify({ lookup: { ...choice(), sourceMessageId: "PUBLIC-FOLLOWUP" } }),
    JSON.stringify({ lookup: { ...choice(), sourceMessageId: " public-followup " } }),
    JSON.stringify({ lookup: { ...choice(), query: "  " } }),
    JSON.stringify({ lookup: { ...choice(), query: "q".repeat(181) } }),
    JSON.stringify({ lookup: { ...choice(), question: "q".repeat(301) } }),
    JSON.stringify({ lookup: { ...choice(), mode: "private_search" } }),
    JSON.stringify({ lookup: { ...choice(), url: "https://example.test" } }),
    JSON.stringify({ lookup: choice(), message: "Unreviewed publication" }),
  ])("fails closed on malformed, unbound or authority-expanding output (%#)", (content) => {
    expect(parseConversationResearchChoice(content, input())).toBeNull();
  });
});
