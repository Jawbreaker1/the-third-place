#!/usr/bin/env node

import { assessCandidate, compareHumanizerSimilarity, segmentWords } from "../server/humanizer.ts";
import { ActorChannelRuntime } from "../server/actorChannels.ts";
import {
  ambientConversationPremise,
  ambientSceneWordLimits,
  consideredConversationLeadPremise,
  consideredConversationResponsePremise,
  consideredConversationWordLimits,
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
const wordUnits = (value, languageTag) => segmentWords(value, languageTag).length;
const emojiCount = (value) => value.match(/\p{Extended_Pictographic}/gu)?.length ?? 0;
// This is a mechanical URL-shape guard, not intent or topic classification.
// Unicode separators and controls terminate the candidate just as ASCII space
// does, so scripts that do not use whitespace are handled consistently.
const hasUrl = (value) => /https?:\/\/[^\p{Z}\p{C}<>"'`]+/iu.test(value);
const now = new Date().toISOString();
const seedHistory = [
  { author: "Sana", kind: "ai", content: "TURN är reservvägen när direkt P2P inte tar sig igenom NAT.", createdAt: now },
  { author: "Vale", kind: "ai", content: "En lyckad Chrome-demo säger nästan inget om restriktiva företagsnät.", createdAt: now },
];
let focusedRetryCount = 0;

// Human-triggered production turns give a required resident one bounded
// focused retry when the reviewed batch omits them. Mirror that contract here
// so the eval measures delivered behavior rather than demanding that every
// stochastic first batch be publishable in full.
const completeRequiredHumanScene = async (request, initialLines) => {
  const completed = [...initialLines];
  for (const persona of request.selected) {
    if (completed.some((line) => line.personaId === persona.id)) continue;
    focusedRetryCount += 1;
    const retry = await lm.generateScene({
      ...request,
      selected: [persona],
      mustReplyIds: [persona.id],
      history: [
        ...(request.history ?? []),
        ...completed.map((line) => ({
          author: byId(line.personaId).name,
          kind: "ai",
          content: line.content,
          createdAt: new Date().toISOString(),
        })),
      ],
      premise: `${request.premise} This is the one bounded focused retry for the omitted required resident. Add a distinct answer; do not paraphrase the already accepted line.`,
    });
    const accepted = retry.find((line) => line.personaId === persona.id);
    if (accepted) completed.push(accepted);
  }
  return completed;
};

const health = await lm.probe();
if (!health.connected) {
  console.error(`Humanity live eval: LM Studio is offline (${health.label}).`);
  process.exitCode = 2;
} else {
  const firstRequest = {
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
  };
  const first = await completeRequiredHumanScene(firstRequest, await lm.generateScene(firstRequest));
  const extendedHistory = [
    ...seedHistory,
    ...first.map((line) => ({
      author: byId(line.personaId).name,
      kind: "ai",
      content: line.content,
      createdAt: new Date().toISOString(),
    })),
  ];
  const secondRequest = {
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
  };
  const second = await completeRequiredHumanScene(secondRequest, await lm.generateScene(secondRequest));

  const consideredSelected = [byId("ai-ibrahim"), byId("ai-tess")];
  const consideredPlan = {
    lead: consideredSelected[0],
    responder: consideredSelected[1],
    responseRole: "example",
  };
  const consideredLimits = consideredConversationWordLimits(consideredPlan, "technical");
  const consideredLead = await lm.generateScene({
    kind: "ambient",
    conversationMode: "considered",
    consideredRole: "lead",
    channelId: "ai-programming",
    channelName: "ai-programming",
    selected: [consideredPlan.lead],
    history: extendedHistory,
    mustReplyIds: [consideredPlan.lead.id],
    wordLimits: { [consideredPlan.lead.id]: consideredLimits.lead },
    languageHint: "Swedish",
    premise: consideredConversationLeadPremise(
      consideredPlan,
      "När blir agentiska kodverktyg svårare att felsöka än vanlig kod, och vilken dold återkopplingsloop orsakar det?",
      "discussion",
      consideredLimits.lead,
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
        wordLimits: { [consideredPlan.responder.id]: consideredLimits.response },
        languageHint: "Swedish",
        premise: consideredConversationResponsePremise(consideredPlan, "discussion", consideredLimits.response),
      })
    : [];
  const considered = [...consideredLead, ...consideredResponse];

  const casualPlan = {
    lead: byId("ai-ibrahim"),
    responder: byId("ai-mira"),
    responseRole: "challenge",
  };
  const casualLimits = consideredConversationWordLimits(casualPlan, "everyday");
  const casualConsidered = await lm.generateScene({
    kind: "ambient",
    conversationMode: "considered",
    consideredRole: "lead",
    channelId: "lobby",
    channelName: "lobby",
    selected: [casualPlan.lead],
    history: [],
    mustReplyIds: [casualPlan.lead.id],
    wordLimits: { [casualPlan.lead.id]: casualLimits.lead },
    languageHint: "Swedish",
    premise: consideredConversationLeadPremise(
      casualPlan,
      "A quiet regular who appears twice a month can make a room steadier than ten daily posters. Name one thing the quiet regular remembers.",
      "casual",
      casualLimits.lead,
    ),
    actorChannelNotes: actorChannels.promptNotes([casualPlan.lead], "lobby"),
    actorExpertiseNotes: actorChannels.expertiseNotes([casualPlan.lead], "lobby"),
  });

  const kim = byId("ai-kim");
  // The same persona/topic-drift regression deliberately crosses scripts and
  // languages. A missing response is actionable; guessing relevance from a
  // Swedish/English motif list is not.
  const kimPrompts = [
    {
      languageTag: "sv-SE",
      content: "Är pseudonymer bra eller dåliga för en liten nätgemenskap? Ta en tydlig sida.",
      premise: "Svara på själva ämnet med en konkret åsikt och ett skäl. Byt inte ämne och använd ingen analogi.",
    },
    {
      languageTag: "es",
      content: "¿Qué hace que un disco antiguo merezca escucharse otra vez de principio a fin?",
      premise: "Responde al tema con una opinión concreta y una razón. No cambies de tema ni uses una analogía.",
    },
    {
      languageTag: "ja",
      content: "細かく計画した旅は、現地では無計画の旅より自由になれると思う？",
      premise: "話題について具体的な意見と理由を一つ返す。話題を変えず、比喩は使わない。",
    },
    {
      languageTag: "ar",
      content: "هل يصبح المشروع الإبداعي أمتع عندما نفرض عليه قيداً صارماً وغريباً؟",
      premise: "أجب عن الموضوع برأي محدد وسبب واحد. لا تغيّر الموضوع ولا تستخدم تشبيهاً.",
    },
    {
      languageTag: "de",
      content: "Helfen Benachrichtigungszähler, oder machen sie Freundschaft zu einer weiteren Aufgabenliste?",
      premise: "Antworte mit einer konkreten Meinung und einem Grund. Wechsle nicht das Thema und benutze keine Analogie.",
    },
    {
      languageTag: "th",
      content: "การกลับไปเล่นเกมเดิมที่คุ้นเคยดีกว่าการไล่ตามเกมใหม่ตลอดเวลาไหม",
      premise: "ตอบตรงประเด็นด้วยความเห็นที่ชัดเจนและเหตุผลหนึ่งข้อ อย่าเปลี่ยนเรื่องและอย่าใช้อุปมา",
    },
  ];
  const kimNonFood = [];
  for (const prompt of kimPrompts) {
    const lines = await lm.generateScene({
      kind: "public",
      channelId: "lobby",
      channelName: "lobby",
      selected: [kim],
      history: [],
      trigger: { author: "guest", content: prompt.content, messageId: `kim-${kimNonFood.length}` },
      mustReplyIds: [kim.id],
      languageHint: prompt.languageTag,
      premise: prompt.premise,
      actorChannelNotes: actorChannels.promptNotes([kim], "lobby"),
      actorExpertiseNotes: actorChannels.expertiseNotes([kim], "lobby"),
    });
    kimNonFood.push(lines[0]);
  }
  const kimFood = await lm.generateScene({
    kind: "public",
    channelId: "the-pub",
    channelName: "the-pub",
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
    actorChannelNotes: actorChannels.promptNotes([kim], "the-pub"),
    actorExpertiseNotes: actorChannels.expertiseNotes([kim], "the-pub"),
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

  const pubAmbientSelected = [byId("ai-juno"), byId("ai-bosse")];
  const pubAmbientSeed = "Put one beloved film on trial for one concrete choice: its ending, performance, pacing or soundtrack. The reply defends that exact choice or names one better alternative; no review summary.";
  const pubAmbient = await lm.generateScene({
    kind: "ambient",
    channelId: "the-pub",
    channelName: "the-pub",
    selected: pubAmbientSelected,
    history: [],
    mustReplyIds: pubAmbientSelected.map((persona) => persona.id),
    wordLimits: ambientSceneWordLimits(pubAmbientSelected[0], pubAmbientSelected[1], false, "banter"),
    languageHint: "Swedish",
    premise: ambientConversationPremise(pubAmbientSeed, pubAmbientSelected[0], pubAmbientSelected[1], false, false, "banter"),
    actorChannelNotes: actorChannels.promptNotes(pubAmbientSelected, "the-pub"),
    actorExpertiseNotes: actorChannels.expertiseNotes(pubAmbientSelected, "the-pub"),
  });

  const pubHumanSelected = [byId("ai-mira"), byId("ai-nox")];
  const pubHumanRequest = {
    kind: "public",
    channelId: "the-pub",
    channelName: "the-pub",
    selected: pubHumanSelected,
    history: pubAmbient.map((line) => ({
      author: byId(line.personaId).name,
      kind: "ai",
      content: line.content,
      createdAt: new Date().toISOString(),
    })),
    trigger: {
      author: "guest",
      content: "Con Air är bättre än National Treasure, och chips slår pommes. Jag är beredd att försvara båda.",
      messageId: "pub-human-control",
    },
    mustReplyIds: pubHumanSelected.map((persona) => persona.id),
    languageHint: "Swedish",
    premise: "Svara som bordssnack, inte rådgivning: en person väljer en konkret sida och den andra gör en distinkt invändning eller torr utvikning. Ingen behöver sammanfatta båda påståendena.",
    actorChannelNotes: actorChannels.promptNotes(pubHumanSelected, "the-pub"),
    actorExpertiseNotes: actorChannels.expertiseNotes(pubHumanSelected, "the-pub"),
  };
  const pubHuman = await completeRequiredHumanScene(pubHumanRequest, await lm.generateScene(pubHumanRequest));

  const issues = [];
  const registerByLabel = {
    first: "technical",
    second: "technical",
    considered: "technical",
    ambientSubstance: "studio",
    pubAmbient: "banter",
    pubHuman: "banter",
  };
  for (const [label, lines] of [["first", first], ["second", second], ["considered", considered], ["ambientSubstance", ambientSubstance], ["pubAmbient", pubAmbient], ["pubHuman", pubHuman]]) {
    if (lines.length !== 2) issues.push(`${label}: expected 2 lines, got ${lines.length}`);
    for (const line of lines) {
      const assessment = assessCandidate({
        personaId: line.personaId,
        text: line.content,
        register: registerByLabel[label],
      });
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
  const leadWords = wordUnits(considered.find((line) => line.personaId === "ai-ibrahim")?.content ?? "", "sv-SE");
  const responseWords = wordUnits(considered.find((line) => line.personaId === "ai-tess")?.content ?? "", "sv-SE");
  if (leadWords < consideredLimits.lead.minimum || leadWords > consideredLimits.lead.maximum) {
    issues.push(`considered lead: ${leadWords} words, expected ${consideredLimits.lead.minimum}–${consideredLimits.lead.maximum}`);
  }
  if (responseWords < consideredLimits.response.minimum || responseWords > consideredLimits.response.maximum) {
    issues.push(`considered response: ${responseWords} words, expected ${consideredLimits.response.minimum}–${consideredLimits.response.maximum}`);
  }
  const casualLeadWords = wordUnits(casualConsidered[0]?.content ?? "", "sv-SE");
  if (casualConsidered.length !== 1) issues.push(`casual considered: expected 1 line, got ${casualConsidered.length}`);
  if (casualLeadWords < casualLimits.lead.minimum || casualLeadWords > casualLimits.lead.maximum) {
    issues.push(`casual considered lead: ${casualLeadWords} words, expected ${casualLimits.lead.minimum}–${casualLimits.lead.maximum}`);
  }
  if (casualConsidered[0]) {
    const assessment = assessCandidate({
      personaId: casualConsidered[0].personaId,
      text: casualConsidered[0].content,
      register: "everyday",
    });
    if (!assessment.acceptable) issues.push(`casual considered/${casualConsidered[0].personaId}: ${assessment.reasonCodes.join(",")}`);
  }
  const kimMissing = kimNonFood.filter((line) => !line).length;
  const kimEmojis = kimNonFood.reduce((total, line) => total + (line ? emojiCount(line.content) : 0), 0);
  if (kimMissing > 0) issues.push(`kim: ${kimMissing}/${kimPrompts.length} non-food replies missing`);
  if (kimEmojis > 2) issues.push(`kim: ${kimEmojis} emoji across ${kimPrompts.length} unrelated replies`);
  if (!kimFood[0]) issues.push("kim control: direct-interest reply missing after multilingual semantic review");
  if (ambientSubstance.some((line) => wordUnits(line.content, "sv-SE") < 8)) {
    issues.push("ambient substance: one contribution was too thin to advance the issue");
  }
  const pubLines = [...pubAmbient, ...pubHuman];
  const pubUrls = pubLines.filter((line) => hasUrl(line.content)).length;
  if (pubUrls > 0) issues.push(`pub: ${pubUrls} line(s) invented or repeated an unsupplied URL`);
  for (const line of pubAmbient) {
    const limit = ambientSceneWordLimits(pubAmbientSelected[0], pubAmbientSelected[1], false, "banter")[line.personaId];
    const count = wordUnits(line.content, "sv-SE");
    if (limit && (count < limit.minimum || count > limit.maximum)) {
      issues.push(`pub ambient/${line.personaId}: ${count} words, expected ${limit.minimum}–${limit.maximum}`);
    }
  }

  const report = {
    model: health.id,
    latencyMs: health.latencyMs,
    semanticPublicationGuard: "Every returned scene line passed LmStudioClient's multilingual candidate review.",
    focusedRetryCount,
    scenes: { first, second, considered, casualConsidered, ambientSubstance, pubAmbient, pubHuman, kimNonFood, kimFood },
    consideredWordCounts: { lead: leadWords, response: responseWords, casualLead: casualLeadWords },
    kimMetrics: {
      prompts: kimPrompts.length,
      missing: kimMissing,
      emoji: kimEmojis,
    },
    pubMetrics: {
      lines: pubLines.length,
      unsuppliedUrls: pubUrls,
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
    console.log(`Kim multilingual metrics: ${kimMissing} missing, ${kimEmojis} emoji / ${kimPrompts.length}`);
    console.log(`Pub metrics: ${pubUrls} unsupplied URLs / ${pubLines.length}`);
    console.log(`Focused retries: ${focusedRetryCount}`);
    console.log(report.passed ? "Result: PASS" : `Result: WARN\n- ${issues.join("\n- ")}`);
  }
  if (strict && issues.length > 0) process.exitCode = 1;
}
