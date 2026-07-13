#!/usr/bin/env node

import { assessCandidate, compareHumanizerSimilarity } from "../server/humanizer.ts";
import { LmStudioClient } from "../server/lmStudio.ts";
import { PERSONAS } from "../server/personas.ts";

const jsonMode = process.argv.includes("--json");
const strict = process.argv.includes("--strict");
const lm = new LmStudioClient();
const byId = (id) => {
  const persona = PERSONAS.find((candidate) => candidate.id === id);
  if (!persona) throw new Error(`Unknown evaluation persona: ${id}`);
  return persona;
};
const selected = [byId("ai-sana"), byId("ai-vale")];
const now = new Date().toISOString();
const seedHistory = [
  { author: "Sana", kind: "ai", content: "TURN är reservvägen när direkt P2P inte tar sig igenom NAT.", createdAt: now },
  { author: "Vale", kind: "ai", content: "En lyckad Chrome-demo säger nästan inget om restriktiva företagsnät.", createdAt: now },
];

const health = await lm.probe();
if (!health.connected) {
  console.error(`Humanity live eval: LM Studio is offline (${health.label}).`);
  process.exitCode = 2;
} else {
  const first = await lm.generateScene({
    kind: "public",
    channelId: "ai-programming",
    channelName: "ai-programming",
    selected,
    history: seedHistory,
    trigger: {
      author: "guest",
      content: "WebRTC fungerar i min Chrome-demo, så TURN behövs väl aldrig? Håller ni med?",
    },
    mustReplyIds: selected.map((persona) => persona.id),
    languageHint: "Swedish",
    premise: "Svara självständigt: en praktisk teknisk invändning och en skeptisk kontrollfråga, utan att upprepa varandra.",
  });
  const extendedHistory = [
    ...seedHistory,
    ...first.map((line) => ({
      author: byId(line.personaId).name,
      kind: "ai",
      content: line.content,
      createdAt: new Date().toISOString(),
    })),
  ];
  const second = await lm.generateScene({
    kind: "public",
    channelId: "ai-programming",
    channelName: "ai-programming",
    selected,
    history: extendedHistory,
    trigger: {
      author: "guest",
      content: "Men om det gick nyss i Chrome, varför skulle vi lägga tid på TURN?",
    },
    mustReplyIds: selected.map((persona) => persona.id),
    languageHint: "Swedish",
    premise: "Fortsätt samtalet utan att återanvända samma öppning, analogi eller slutsats som nyss.",
  });

  const consideredSelected = [byId("ai-ibrahim"), byId("ai-tess")];
  const considered = await lm.generateScene({
    kind: "ambient",
    conversationMode: "considered",
    channelId: "ai-programming",
    channelName: "ai-programming",
    selected: consideredSelected,
    history: extendedHistory,
    mustReplyIds: consideredSelected.map((persona) => persona.id),
    languageHint: "Swedish",
    premise: "Ibrahim gör en konkret observation om när agentiska kodverktyg blir svårare att felsöka än vanlig kod. Tess svarar med en annan praktisk konsekvens, inte en sammanfattning.",
  });

  const issues = [];
  for (const [label, lines] of [["first", first], ["second", second], ["considered", considered]]) {
    if (lines.length !== 2) issues.push(`${label}: expected 2 lines, got ${lines.length}`);
    for (const line of lines) {
      const assessment = assessCandidate({ personaId: line.personaId, text: line.content });
      if (!assessment.acceptable) issues.push(`${label}/${line.personaId}: ${assessment.reasonCodes.join(",")}`);
    }
  }
  for (const persona of selected) {
    const left = first.find((line) => line.personaId === persona.id)?.content;
    const right = second.find((line) => line.personaId === persona.id)?.content;
    if (!left || !right) continue;
    const similarity = compareHumanizerSimilarity(left, right).combined;
    if (similarity >= 0.8) issues.push(`${persona.id}: repeated answer similarity ${similarity.toFixed(2)}`);
  }
  const leadWords = considered.find((line) => line.personaId === "ai-ibrahim")?.content.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  const responseWords = considered.find((line) => line.personaId === "ai-tess")?.content.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  if (leadWords < 45 || leadWords > 75) issues.push(`considered lead: ${leadWords} words, expected 45–75`);
  if (responseWords < 8 || responseWords > 28) issues.push(`considered response: ${responseWords} words, expected 8–28`);

  const report = {
    model: health.id,
    latencyMs: health.latencyMs,
    scenes: { first, second, considered },
    consideredWordCounts: { lead: leadWords, response: responseWords },
    passed: issues.length === 0,
    issues,
  };
  if (jsonMode) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Humanity live eval — ${health.label}`);
    for (const [label, lines] of Object.entries(report.scenes)) {
      console.log(`\n${label}`);
      for (const line of lines) console.log(`  ${byId(line.personaId).name}: ${line.content}`);
    }
    console.log(`\nConsidered words: ${leadWords} + ${responseWords}`);
    console.log(report.passed ? "Result: PASS" : `Result: WARN\n- ${issues.join("\n- ")}`);
  }
  if (strict && issues.length > 0) process.exitCode = 1;
}
