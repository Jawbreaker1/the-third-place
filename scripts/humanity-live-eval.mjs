#!/usr/bin/env node

import { assessCandidate, compareHumanizerSimilarity } from "../server/humanizer.ts";
import { ActorChannelRuntime } from "../server/actorChannels.ts";
import {
  ambientConversationPremise,
  ambientSceneWordLimits,
  consideredConversationLeadPremise,
  consideredConversationResponsePremise,
} from "../server/director.ts";
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
const actorChannels = new ActorChannelRuntime();
const words = (value) => value.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
const emojiCount = (value) => value.match(/\p{Extended_Pictographic}/gu)?.length ?? 0;
const hasFoodMotif = (value) => /\b(?:mat(?:en)?|food|kimchi|ferment\w*|bakteri\w*|måltid\w*|snacks?|frukost|leftovers?|hot sauce|chili|smak\w*|textur\w*|kök(?:et)?|recept\w*)\b/iu.test(value);
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
  const consideredPlan = {
    lead: consideredSelected[0],
    responder: consideredSelected[1],
    responseRole: "example",
  };
  const consideredLead = await lm.generateScene({
    kind: "ambient",
    conversationMode: "considered",
    consideredRole: "lead",
    channelId: "ai-programming",
    channelName: "ai-programming",
    selected: [consideredPlan.lead],
    history: extendedHistory,
    mustReplyIds: [consideredPlan.lead.id],
    wordLimits: { [consideredPlan.lead.id]: { minimum: 45, maximum: 75 } },
    languageHint: "Swedish",
    premise: consideredConversationLeadPremise(
      consideredPlan,
      "När blir agentiska kodverktyg svårare att felsöka än vanlig kod, och vilken dold återkopplingsloop orsakar det?",
    ),
  });
  const consideredResponse = consideredLead[0]
    ? await lm.generateScene({
        kind: "ambient",
        conversationMode: "considered",
        consideredRole: "response",
        consideredResponseRole: consideredPlan.responseRole,
        channelId: "ai-programming",
        channelName: "ai-programming",
        selected: [consideredPlan.responder],
        history: [
          ...extendedHistory,
          {
            author: consideredPlan.lead.name,
            kind: "ai",
            content: consideredLead[0].content,
            createdAt: new Date().toISOString(),
          },
        ],
        mustReplyIds: [consideredPlan.responder.id],
        wordLimits: { [consideredPlan.responder.id]: { minimum: 8, maximum: 28 } },
        languageHint: "Swedish",
        premise: consideredConversationResponsePremise(consideredPlan),
      })
    : [];
  const considered = [...consideredLead, ...consideredResponse];

  const kim = byId("ai-kim");
  const kimPrompts = [
    "Är pseudonymer bra eller dåliga för en liten nätgemenskap? Ta en tydlig sida.",
    "Vad gör en gammal skiva värd att lyssna på från början till slut igen?",
    "Är en minutiöst planerad resa friare än en spontan resa när man väl är på plats?",
    "Blir ett kreativt hobbyprojekt roligare av en löjligt strikt begränsning?",
    "Är notisbrickor en hjälp eller gör de vänskap till ännu en att-göra-lista?",
    "Är det bättre att spela om ett välbekant spel än att ständigt jaga nästa nya spel?",
  ];
  const kimNonFood = [];
  for (const content of kimPrompts) {
    const lines = await lm.generateScene({
      kind: "public",
      channelId: "lobby",
      channelName: "lobby",
      selected: [kim],
      history: [],
      trigger: { author: "guest", content, messageId: `kim-${kimNonFood.length}` },
      mustReplyIds: [kim.id],
      languageHint: "Swedish",
      premise: "Svara på själva ämnet med en konkret åsikt och ett skäl. Byt inte ämne och använd ingen analogi.",
      actorChannelNotes: actorChannels.promptNotes([kim], "lobby"),
      actorExpertiseNotes: actorChannels.expertiseNotes([kim], "lobby"),
    });
    kimNonFood.push(lines[0]);
  }
  const kimFood = await lm.generateScene({
    kind: "public",
    channelId: "side-quests",
    channelName: "side-quests",
    selected: [kim],
    history: [],
    trigger: {
      author: "guest",
      content: "Kim, vad är det mest intressanta med fermentering när man faktiskt provar hemma?",
      messageId: "kim-food-control",
    },
    mustReplyIds: [kim.id],
    languageHint: "Swedish",
    premise: "Detta är en direkt matfråga, så Kims genuina intresse får märkas. Ge ett specifikt men kort svar.",
    actorChannelNotes: actorChannels.promptNotes([kim], "side-quests"),
    actorExpertiseNotes: actorChannels.expertiseNotes([kim], "side-quests"),
  });

  const ambientSelected = [byId("ai-pixel"), byId("ai-tess")];
  const ambientSeed = "Believable lighting contributes more to a convincing render than complex materials; one visual cue should expose the weaker side.";
  const ambientSubstance = await lm.generateScene({
    kind: "ambient",
    channelId: "3d-visualisation",
    channelName: "3d-visualisation",
    selected: ambientSelected,
    history: [],
    mustReplyIds: ambientSelected.map((persona) => persona.id),
    wordLimits: ambientSceneWordLimits(ambientSelected[0], ambientSelected[1], false),
    languageHint: "Swedish",
    premise: ambientConversationPremise(ambientSeed, ambientSelected[0], ambientSelected[1], false, true),
    actorChannelNotes: actorChannels.promptNotes(ambientSelected, "3d-visualisation"),
    actorExpertiseNotes: actorChannels.expertiseNotes(ambientSelected, "3d-visualisation"),
  });

  const issues = [];
  for (const [label, lines] of [["first", first], ["second", second], ["considered", considered], ["ambientSubstance", ambientSubstance]]) {
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
  const leadWords = words(considered.find((line) => line.personaId === "ai-ibrahim")?.content ?? "");
  const responseWords = words(considered.find((line) => line.personaId === "ai-tess")?.content ?? "");
  if (leadWords < 45 || leadWords > 75) issues.push(`considered lead: ${leadWords} words, expected 45–75`);
  if (responseWords < 8 || responseWords > 28) issues.push(`considered response: ${responseWords} words, expected 8–28`);
  const kimMissing = kimNonFood.filter((line) => !line).length;
  const kimFoodReferences = kimNonFood.filter((line) => line && hasFoodMotif(line.content)).length;
  const kimEmojis = kimNonFood.reduce((total, line) => total + (line ? emojiCount(line.content) : 0), 0);
  const kimQuestionEndings = kimNonFood.filter((line) => line && /\?\s*$/u.test(line.content)).length;
  if (kimMissing > 0) issues.push(`kim: ${kimMissing}/${kimPrompts.length} non-food replies missing`);
  if (kimFoodReferences > 1) issues.push(`kim: ${kimFoodReferences}/${kimPrompts.length} unrelated replies used a food motif`);
  if (kimEmojis > 2) issues.push(`kim: ${kimEmojis} emoji across ${kimPrompts.length} unrelated replies`);
  if (kimQuestionEndings > 2) issues.push(`kim: ${kimQuestionEndings}/${kimPrompts.length} unrelated replies ended as questions`);
  if (!kimFood[0] || !hasFoodMotif(kimFood[0].content)) issues.push("kim control: direct fermentation answer lost the genuine interest");
  const ambientCombined = ambientSubstance.map((line) => line.content).join(" ");
  if (!/(?:ljus|lighting|material|render|skugg|reflektion|highlight|yta)/iu.test(ambientCombined)) {
    issues.push("ambient substance: 3D exchange lost its concrete lighting/material anchor");
  }
  if (ambientSubstance.some((line) => words(line.content) < 8)) {
    issues.push("ambient substance: one contribution was too thin to advance the issue");
  }

  const report = {
    model: health.id,
    latencyMs: health.latencyMs,
    scenes: { first, second, considered, ambientSubstance, kimNonFood, kimFood },
    consideredWordCounts: { lead: leadWords, response: responseWords },
    kimMetrics: {
      prompts: kimPrompts.length,
      missing: kimMissing,
      unrelatedFoodReferences: kimFoodReferences,
      emoji: kimEmojis,
      questionEndings: kimQuestionEndings,
    },
    passed: issues.length === 0,
    issues,
  };
  if (jsonMode) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`Humanity live eval — ${health.label}`);
    for (const [label, lines] of Object.entries(report.scenes)) {
      console.log(`\n${label}`);
      for (const line of lines) {
        if (line) console.log(`  ${byId(line.personaId).name}: ${line.content}`);
        else console.log("  [missing line]");
      }
    }
    console.log(`\nConsidered words: ${leadWords} + ${responseWords}`);
    console.log(`Kim non-food metrics: ${kimFoodReferences} food motifs, ${kimEmojis} emoji, ${kimQuestionEndings} question endings / ${kimPrompts.length}`);
    console.log(report.passed ? "Result: PASS" : `Result: WARN\n- ${issues.join("\n- ")}`);
  }
  if (strict && issues.length > 0) process.exitCode = 1;
}
