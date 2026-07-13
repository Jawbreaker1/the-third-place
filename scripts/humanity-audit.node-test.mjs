import assert from "node:assert/strict";
import test from "node:test";

import { auditState, renderHumanReport } from "./humanity-audit.mjs";

const message = (id, authorId, content, extra = {}) => ({
  id,
  authorId,
  channelId: "lobby",
  content,
  createdAt: `2026-01-01T00:00:0${id}.000Z`,
  reactions: [],
  ...extra,
});

test("audits only AI messages and identifies repetition, clichés, emoji and cross-persona echoes", () => {
  const exact = "Absolutely! Here's the thing: widgets are blue. ✨";
  const state = {
    version: 1,
    messages: [
      message("1", "ai-alpha", exact),
      message("2", "ai-beta", exact),
      message("3", "ai-alpha", "Absolutely! Here's the thing: widgets are bright blue. ✨"),
      message("4", "ai-beta", "Bra fråga! Låt oss dyka ner i saken. 😊"),
      message("5", "ai-beta", "Bra fråga! Här kommer en kort förklaring."),
      message("6", "ai-alpha", "quiet unrelated line"),
      message("7", "human-1", exact),
      message("8", "ai-alpha", exact, { system: true }),
      message("9", "system", exact, { system: true }),
    ],
  };

  const report = auditState(state, { source: "fixture", pairWindow: 20, strict: true });

  assert.equal(report.global.messageCount, 6);
  assert.equal(report.ignoredMessageCount, 3);
  assert.equal(report.global.personaCount, 2);
  assert.equal(report.global.duplicatePairs.exact.count, 1);
  assert.ok(report.global.duplicatePairs.near.count >= 2);
  assert.equal(report.global.crossPersonaEcho.exactCount, 1);
  assert.ok(report.global.crossPersonaEcho.nearCount >= 1);
  assert.equal(report.global.repeatedOpenings["2"].top[0].phrase, "absolutely here's");
  assert.equal(report.global.repeatedOpenings["2"].top[0].count, 3);
  assert.ok(report.global.assistantCliches.messageCount >= 5);
  assert.equal(report.global.emoji.messagesWithEmoji, 4);
  assert.equal(report.personas.find((persona) => persona.personaId === "ai-alpha").messageCount, 3);
  assert.match(renderHumanReport(report), /Per persona\nai-alpha/u);
});

test("rejects malformed state instead of silently auditing the wrong shape", () => {
  assert.throws(() => auditState({ messages: null }), /messages array/u);
});

test("strict mode catches only an unmistakably repetitive regression", () => {
  const messages = Array.from({ length: 20 }, (_, index) =>
    message(
      String(index + 10),
      "ai-loop",
      "Absolutely! Great question. Here's the thing: this is a game-changer. ✨",
      { createdAt: `2026-01-01T00:01:${String(index).padStart(2, "0")}.000Z` },
    ),
  );

  const report = auditState({ version: 1, messages }, { pairWindow: 200, strict: true });

  assert.equal(report.strict.passed, false);
  assert.ok(report.strict.issues.some((issue) => issue.metric === "duplicatePairs.exact.pairsPerMessage"));
  assert.ok(report.strict.issues.some((issue) => issue.metric === "assistantCliches.messageRate"));
});
