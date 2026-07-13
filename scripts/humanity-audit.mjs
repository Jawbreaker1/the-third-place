#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_PAIR_WINDOW = 200;
const NEAR_DUPLICATE_THRESHOLD = 0.72;
const MAX_EXAMPLES = 12;
const OPENING_LENGTHS = [2, 3, 4];

const ASSISTANT_CLICHES = [
  { language: "en", label: "sure/certainly/absolutely opener", pattern: /^\s*(?:sure|certainly|absolutely)[!,.]?\s/iu },
  { language: "en", label: "great question", pattern: /\b(?:great|good|excellent) question\b/iu },
  { language: "en", label: "here's the thing/breakdown", pattern: /\bhere(?:'|’)?s (?:the thing|a (?:quick )?breakdown)\b/iu },
  { language: "en", label: "let's dive/explore/break it down", pattern: /\blet(?:'|’)?s (?:dive (?:in|into)|explore|break (?:it|this) down)\b/iu },
  { language: "en", label: "important/worth noting", pattern: /\b(?:it(?:'|’)?s (?:important|worthwhile)|worth) to (?:note|remember|mention)\b/iu },
  { language: "en", label: "hope this helps", pattern: /\bhope (?:this|that) helps\b/iu },
  { language: "en", label: "feel free to", pattern: /\bfeel free to\b/iu },
  { language: "en", label: "happy to help", pattern: /\bhappy to help\b/iu },
  { language: "en", label: "as an AI", pattern: /\bas an ai\b/iu },
  { language: "en", label: "in conclusion", pattern: /\bin conclusion\b/iu },
  { language: "en", label: "you've got this", pattern: /\byou(?:'|’)?ve got this\b/iu },
  { language: "en", label: "game-changer", pattern: /\bgame[- ]changer\b/iu },
  { language: "sv", label: "absolut/självklart opener", pattern: /^\s*(?:absolut|självklart)[!,.]?\s/iu },
  { language: "sv", label: "bra fråga", pattern: /\b(?:bra|utmärkt) fråga\b/iu },
  { language: "sv", label: "här kommer", pattern: /\bhär kommer (?:en|ett|några)\b/iu },
  { language: "sv", label: "låt oss dyka/utforska/bryta ner", pattern: /\blåt oss (?:dyka (?:in|ner)|utforska|bryta ner)\b/iu },
  { language: "sv", label: "viktigt/värt att notera", pattern: /\b(?:det är viktigt|värt) att (?:notera|komma ihåg|nämna)\b/iu },
  { language: "sv", label: "hoppas det hjälper", pattern: /\bhoppas (?:det|detta|det här) hjälper\b/iu },
  { language: "sv", label: "hör gärna av dig", pattern: /\bhör gärna av dig\b/iu },
  { language: "sv", label: "jag hjälper gärna", pattern: /\bjag hjälper gärna\b/iu },
  { language: "sv", label: "som en AI", pattern: /\bsom en ai\b/iu },
  { language: "sv", label: "sammanfattningsvis", pattern: /\bsammanfattningsvis\b/iu },
  { language: "sv", label: "du klarar det", pattern: /\bdu klarar det(?: här)?\b/iu },
];

const STRICT_THRESHOLDS = {
  globalMedianWords: 55,
  globalAssistantClicheMessageRate: 0.25,
  globalEmojiMessageRate: 0.55,
  globalExactPairsPerMessage: 0.2,
  globalNearPairsPerMessage: 0.35,
  globalCrossPersonaEchoPairsPerMessage: 0.4,
  globalDominantTwoWordOpeningShare: 0.28,
  personaMinimumMessages: 12,
  personaAssistantClicheMessageRate: 0.45,
  personaEmojiMessageRate: 0.98,
  personaExactPairsPerMessage: 0.5,
  personaNearPairsPerMessage: 0.75,
  personaDominantTwoWordOpeningShare: 0.5,
};

const round = (value, digits = 3) => Number(value.toFixed(digits));
const rate = (numerator, denominator) => (denominator > 0 ? round(numerator / denominator) : 0);

const words = (content) =>
  String(content ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("sv-SE")
    .replaceAll("’", "'")
    .match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? [];

const normalizeContent = (content) => words(content).join(" ");

const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : round((sorted[middle - 1] + sorted[middle]) / 2, 1);
};

const excerpt = (content, maxLength = 112) => {
  const compact = String(content ?? "").replace(/\s+/gu, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
};

const isAiMessage = (message) =>
  message &&
  message.system !== true &&
  typeof message.authorId === "string" &&
  message.authorId.startsWith("ai-");

const findCliches = (content) =>
  ASSISTANT_CLICHES.filter(({ pattern }) => pattern.test(String(content ?? ""))).map(({ language, label }) => ({
    language,
    label,
  }));

const prepareMessage = (message, index) => {
  const content = typeof message.content === "string" ? message.content : "";
  const tokenList = words(content);
  return {
    id: typeof message.id === "string" ? message.id : `message-${index + 1}`,
    personaId: message.authorId,
    channelId: typeof message.channelId === "string" ? message.channelId : "unknown",
    createdAt: typeof message.createdAt === "string" ? message.createdAt : "",
    content,
    words: tokenList,
    normalized: tokenList.join(" "),
    emojiCount: (content.match(/\p{Extended_Pictographic}/gu) ?? []).length,
    clicheHits: findCliches(content),
    originalIndex: index,
  };
};

const comparePreparedMessages = (left, right) =>
  left.createdAt.localeCompare(right.createdAt) || left.originalIndex - right.originalIndex;

const openingReport = (messages) => {
  const result = {};
  for (const length of OPENING_LENGTHS) {
    const counts = new Map();
    for (const message of messages) {
      if (message.words.length < length) continue;
      const phrase = message.words.slice(0, length).join(" ");
      const entry = counts.get(phrase) ?? { count: 0, personaIds: new Set() };
      entry.count += 1;
      entry.personaIds.add(message.personaId);
      counts.set(phrase, entry);
    }
    const repeated = [...counts.entries()]
      .filter(([, entry]) => entry.count >= 2)
      .map(([phrase, entry]) => ({ phrase, count: entry.count, personaCount: entry.personaIds.size }))
      .sort((left, right) => right.count - left.count || left.phrase.localeCompare(right.phrase, "sv"));
    result[String(length)] = {
      repeatedPhraseCount: repeated.length,
      dominantShare: rate(repeated[0]?.count ?? 0, messages.length),
      top: repeated.slice(0, 10),
    };
  }
  return result;
};

const clicheReport = (messages) => {
  const byPhrase = new Map();
  const examples = [];
  let messageCount = 0;
  let hitCount = 0;
  for (const message of messages) {
    if (message.clicheHits.length === 0) continue;
    messageCount += 1;
    hitCount += message.clicheHits.length;
    for (const hit of message.clicheHits) {
      const key = `${hit.language}\u0000${hit.label}`;
      const entry = byPhrase.get(key) ?? { ...hit, count: 0 };
      entry.count += 1;
      byPhrase.set(key, entry);
    }
    if (examples.length < MAX_EXAMPLES) {
      examples.push({ id: message.id, personaId: message.personaId, hits: message.clicheHits, excerpt: excerpt(message.content) });
    }
  }
  return {
    messageCount,
    messageRate: rate(messageCount, messages.length),
    hitCount,
    byPhrase: [...byPhrase.values()].sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)),
    examples,
  };
};

const baseMessageReport = (messages) => {
  const emojiCount = messages.reduce((total, message) => total + message.emojiCount, 0);
  const messagesWithEmoji = messages.filter((message) => message.emojiCount > 0).length;
  return {
    messageCount: messages.length,
    medianWords: median(messages.map((message) => message.words.length)),
    repeatedOpenings: openingReport(messages),
    assistantCliches: clicheReport(messages),
    emoji: {
      messagesWithEmoji,
      messageRate: rate(messagesWithEmoji, messages.length),
      emojiCount,
      emojisPerMessage: rate(emojiCount, messages.length),
    },
  };
};

const frequencyDice = (left, right) => {
  if (left.length === 0 || right.length === 0) return 0;
  const leftCounts = new Map();
  for (const item of left) leftCounts.set(item, (leftCounts.get(item) ?? 0) + 1);
  const rightCounts = new Map();
  for (const item of right) rightCounts.set(item, (rightCounts.get(item) ?? 0) + 1);
  let overlap = 0;
  for (const [item, count] of leftCounts) overlap += Math.min(count, rightCounts.get(item) ?? 0);
  return (2 * overlap) / (left.length + right.length);
};

const bigrams = (items) => items.slice(1).map((item, index) => `${items[index]}\u0001${item}`);

const nearSimilarity = (leftWords, rightWords) => {
  const shortest = Math.min(leftWords.length, rightWords.length);
  const longest = Math.max(leftWords.length, rightWords.length);
  if (shortest < 5 || shortest / longest < 0.55) return 0;
  const wordSimilarity = frequencyDice(leftWords, rightWords);
  const bigramSimilarity = frequencyDice(bigrams(leftWords), bigrams(rightWords));
  return 0.35 * wordSimilarity + 0.65 * bigramSimilarity;
};

const pairExample = (left, right, kind, similarity) => ({
  kind,
  similarity: round(similarity),
  left: {
    id: left.id,
    personaId: left.personaId,
    channelId: left.channelId,
    createdAt: left.createdAt,
    excerpt: excerpt(left.content),
  },
  right: {
    id: right.id,
    personaId: right.personaId,
    channelId: right.channelId,
    createdAt: right.createdAt,
    excerpt: excerpt(right.content),
  },
});

const addBestExample = (examples, candidate) => {
  examples.push(candidate);
  examples.sort((left, right) => right.similarity - left.similarity || left.left.createdAt.localeCompare(right.left.createdAt));
  if (examples.length > MAX_EXAMPLES) examples.length = MAX_EXAMPLES;
};

const emptyPersonaPairReport = () => ({
  exactCount: 0,
  nearCount: 0,
  crossPersonaEchoCount: 0,
  crossPersonaExactCount: 0,
  crossPersonaNearCount: 0,
  exactExamples: [],
  nearExamples: [],
  crossPersonaEchoExamples: [],
});

const analysePairs = (messages, pairWindow) => {
  let comparisons = 0;
  let exactCount = 0;
  let nearCount = 0;
  let crossPersonaExactCount = 0;
  let crossPersonaNearCount = 0;
  const exactExamples = [];
  const nearExamples = [];
  const crossPersonaEchoExamples = [];
  const byPersona = new Map(messages.map((message) => [message.personaId, emptyPersonaPairReport()]));

  for (let rightIndex = 0; rightIndex < messages.length; rightIndex += 1) {
    const right = messages[rightIndex];
    const firstLeftIndex = Math.max(0, rightIndex - pairWindow);
    for (let leftIndex = firstLeftIndex; leftIndex < rightIndex; leftIndex += 1) {
      const left = messages[leftIndex];
      if (!left.normalized || !right.normalized) continue;
      comparisons += 1;

      let kind;
      let similarity;
      if (left.normalized === right.normalized) {
        kind = "exact";
        similarity = 1;
      } else {
        similarity = nearSimilarity(left.words, right.words);
        if (similarity < NEAR_DUPLICATE_THRESHOLD) continue;
        kind = "near";
      }

      const example = pairExample(left, right, kind, similarity);
      if (kind === "exact") {
        exactCount += 1;
        addBestExample(exactExamples, example);
      } else {
        nearCount += 1;
        addBestExample(nearExamples, example);
      }

      const involvedPersonas = new Set([left.personaId, right.personaId]);
      for (const personaId of involvedPersonas) {
        const persona = byPersona.get(personaId);
        if (kind === "exact") {
          persona.exactCount += 1;
          addBestExample(persona.exactExamples, example);
        } else {
          persona.nearCount += 1;
          addBestExample(persona.nearExamples, example);
        }
      }

      if (left.personaId === right.personaId) continue;
      if (kind === "exact") crossPersonaExactCount += 1;
      else crossPersonaNearCount += 1;
      addBestExample(crossPersonaEchoExamples, example);
      for (const personaId of involvedPersonas) {
        const persona = byPersona.get(personaId);
        persona.crossPersonaEchoCount += 1;
        if (kind === "exact") persona.crossPersonaExactCount += 1;
        else persona.crossPersonaNearCount += 1;
        addBestExample(persona.crossPersonaEchoExamples, example);
      }
    }
  }

  return {
    comparisons,
    exactCount,
    nearCount,
    crossPersonaExactCount,
    crossPersonaNearCount,
    exactExamples,
    nearExamples,
    crossPersonaEchoExamples,
    byPersona,
  };
};

const duplicateReport = (pairData, messageCount) => ({
  exact: {
    count: pairData.exactCount,
    pairsPerMessage: rate(pairData.exactCount, messageCount),
    examples: pairData.exactExamples,
  },
  near: {
    count: pairData.nearCount,
    pairsPerMessage: rate(pairData.nearCount, messageCount),
    threshold: NEAR_DUPLICATE_THRESHOLD,
    examples: pairData.nearExamples,
  },
});

const personaDuplicateReport = (pairData, messageCount) => ({
  exact: {
    count: pairData.exactCount,
    pairsPerMessage: rate(pairData.exactCount, messageCount),
    examples: pairData.exactExamples,
  },
  near: {
    count: pairData.nearCount,
    pairsPerMessage: rate(pairData.nearCount, messageCount),
    threshold: NEAR_DUPLICATE_THRESHOLD,
    examples: pairData.nearExamples,
  },
});

const crossPersonaReport = (pairData, messageCount) => ({
  count: pairData.crossPersonaExactCount + pairData.crossPersonaNearCount,
  exactCount: pairData.crossPersonaExactCount,
  nearCount: pairData.crossPersonaNearCount,
  pairsPerMessage: rate(pairData.crossPersonaExactCount + pairData.crossPersonaNearCount, messageCount),
  examples: pairData.crossPersonaEchoExamples,
});

const personaCrossPersonaReport = (pairData, messageCount) => ({
  count: pairData.crossPersonaEchoCount,
  exactCount: pairData.crossPersonaExactCount,
  nearCount: pairData.crossPersonaNearCount,
  pairsPerMessage: rate(pairData.crossPersonaEchoCount, messageCount),
  examples: pairData.crossPersonaEchoExamples,
});

const strictEvaluation = (report, enabled) => {
  const issues = [];
  const global = report.global;
  const add = (scope, metric, value, threshold) => {
    issues.push({ scope, metric, value, threshold, comparison: ">" });
  };

  if (global.medianWords > STRICT_THRESHOLDS.globalMedianWords) {
    add("global", "medianWords", global.medianWords, STRICT_THRESHOLDS.globalMedianWords);
  }
  if (global.assistantCliches.messageRate > STRICT_THRESHOLDS.globalAssistantClicheMessageRate) {
    add("global", "assistantCliches.messageRate", global.assistantCliches.messageRate, STRICT_THRESHOLDS.globalAssistantClicheMessageRate);
  }
  if (global.emoji.messageRate > STRICT_THRESHOLDS.globalEmojiMessageRate) {
    add("global", "emoji.messageRate", global.emoji.messageRate, STRICT_THRESHOLDS.globalEmojiMessageRate);
  }
  if (global.duplicatePairs.exact.pairsPerMessage > STRICT_THRESHOLDS.globalExactPairsPerMessage) {
    add("global", "duplicatePairs.exact.pairsPerMessage", global.duplicatePairs.exact.pairsPerMessage, STRICT_THRESHOLDS.globalExactPairsPerMessage);
  }
  if (global.duplicatePairs.near.pairsPerMessage > STRICT_THRESHOLDS.globalNearPairsPerMessage) {
    add("global", "duplicatePairs.near.pairsPerMessage", global.duplicatePairs.near.pairsPerMessage, STRICT_THRESHOLDS.globalNearPairsPerMessage);
  }
  if (global.crossPersonaEcho.pairsPerMessage > STRICT_THRESHOLDS.globalCrossPersonaEchoPairsPerMessage) {
    add("global", "crossPersonaEcho.pairsPerMessage", global.crossPersonaEcho.pairsPerMessage, STRICT_THRESHOLDS.globalCrossPersonaEchoPairsPerMessage);
  }
  const dominantGlobalOpening = global.repeatedOpenings["2"];
  if (
    (dominantGlobalOpening.top[0]?.count ?? 0) >= 10 &&
    dominantGlobalOpening.dominantShare > STRICT_THRESHOLDS.globalDominantTwoWordOpeningShare
  ) {
    add(
      "global",
      "repeatedOpenings.2.dominantShare",
      dominantGlobalOpening.dominantShare,
      STRICT_THRESHOLDS.globalDominantTwoWordOpeningShare,
    );
  }

  for (const persona of report.personas) {
    if (persona.messageCount < STRICT_THRESHOLDS.personaMinimumMessages) continue;
    if (persona.assistantCliches.messageRate > STRICT_THRESHOLDS.personaAssistantClicheMessageRate) {
      add(persona.personaId, "assistantCliches.messageRate", persona.assistantCliches.messageRate, STRICT_THRESHOLDS.personaAssistantClicheMessageRate);
    }
    if (persona.emoji.messageRate > STRICT_THRESHOLDS.personaEmojiMessageRate) {
      add(persona.personaId, "emoji.messageRate", persona.emoji.messageRate, STRICT_THRESHOLDS.personaEmojiMessageRate);
    }
    if (persona.duplicatePairs.exact.pairsPerMessage > STRICT_THRESHOLDS.personaExactPairsPerMessage) {
      add(persona.personaId, "duplicatePairs.exact.pairsPerMessage", persona.duplicatePairs.exact.pairsPerMessage, STRICT_THRESHOLDS.personaExactPairsPerMessage);
    }
    if (persona.duplicatePairs.near.pairsPerMessage > STRICT_THRESHOLDS.personaNearPairsPerMessage) {
      add(persona.personaId, "duplicatePairs.near.pairsPerMessage", persona.duplicatePairs.near.pairsPerMessage, STRICT_THRESHOLDS.personaNearPairsPerMessage);
    }
    const dominantOpening = persona.repeatedOpenings["2"];
    if (
      (dominantOpening.top[0]?.count ?? 0) >= 6 &&
      dominantOpening.dominantShare > STRICT_THRESHOLDS.personaDominantTwoWordOpeningShare
    ) {
      add(
        persona.personaId,
        "repeatedOpenings.2.dominantShare",
        dominantOpening.dominantShare,
        STRICT_THRESHOLDS.personaDominantTwoWordOpeningShare,
      );
    }
  }

  return { enabled, passed: issues.length === 0, thresholds: STRICT_THRESHOLDS, issues };
};

export const auditState = (state, options = {}) => {
  if (!state || typeof state !== "object" || !Array.isArray(state.messages)) {
    throw new TypeError("Room state must be an object with a messages array.");
  }
  const pairWindow = Number.isSafeInteger(options.pairWindow) && options.pairWindow > 0 ? options.pairWindow : DEFAULT_PAIR_WINDOW;
  const aiMessages = state.messages.filter(isAiMessage).map(prepareMessage).sort(comparePreparedMessages);
  const grouped = new Map();
  for (const message of aiMessages) {
    const messages = grouped.get(message.personaId) ?? [];
    messages.push(message);
    grouped.set(message.personaId, messages);
  }

  const pairData = analysePairs(aiMessages, pairWindow);
  const global = {
    ...baseMessageReport(aiMessages),
    personaCount: grouped.size,
    duplicatePairs: duplicateReport(pairData, aiMessages.length),
    crossPersonaEcho: crossPersonaReport(pairData, aiMessages.length),
  };
  const personas = [...grouped.entries()]
    .map(([personaId, messages]) => {
      const personaPairs = pairData.byPersona.get(personaId) ?? emptyPersonaPairReport();
      return {
        personaId,
        ...baseMessageReport(messages),
        duplicatePairs: personaDuplicateReport(personaPairs, messages.length),
        crossPersonaEcho: personaCrossPersonaReport(personaPairs, messages.length),
      };
    })
    .sort((left, right) => right.messageCount - left.messageCount || left.personaId.localeCompare(right.personaId));

  const report = {
    schemaVersion: 1,
    source: options.source ?? null,
    filter: "authorId starts with ai- and system !== true",
    inputMessageCount: state.messages.length,
    ignoredMessageCount: state.messages.length - aiMessages.length,
    configuration: {
      pairWindow,
      nearDuplicateThreshold: NEAR_DUPLICATE_THRESHOLD,
      maximumExamplesPerMetric: MAX_EXAMPLES,
    },
    global,
    personas,
  };
  report.strict = strictEvaluation(report, options.strict === true);
  return report;
};

const percent = (value) => `${round(value * 100, 1).toFixed(1)}%`;

const describeOpening = (report, length) => {
  const top = report.repeatedOpenings[String(length)].top[0];
  return top ? `“${top.phrase}” ×${top.count}` : "—";
};

const renderPairExample = (example) =>
  `${example.left.personaId} ↔ ${example.right.personaId} (${percent(example.similarity)}): “${example.right.excerpt}”`;

export const renderHumanReport = (report) => {
  const lines = [
    "Humanity audit",
    `Source: ${report.source ?? "in-memory state"}`,
    `Filter: ${report.filter}`,
    `AI messages: ${report.global.messageCount} across ${report.global.personaCount} personas (${report.ignoredMessageCount} ignored)`,
    `Pair window: ${report.configuration.pairWindow} preceding AI messages; near threshold: ${percent(report.configuration.nearDuplicateThreshold)}`,
    "",
    "Global",
    `  Messages / median words: ${report.global.messageCount} / ${report.global.medianWords}`,
    `  Emoji: ${percent(report.global.emoji.messageRate)} of messages (${report.global.emoji.emojiCount} total)`,
    `  Assistant clichés (sv/en): ${report.global.assistantCliches.messageCount} messages (${percent(report.global.assistantCliches.messageRate)}), ${report.global.assistantCliches.hitCount} hits`,
    `  Duplicate pairs: ${report.global.duplicatePairs.exact.count} exact / ${report.global.duplicatePairs.near.count} near`,
    `  Cross-persona echo: ${report.global.crossPersonaEcho.count} pairs (${report.global.crossPersonaEcho.exactCount} exact / ${report.global.crossPersonaEcho.nearCount} near)`,
    "  Repeated openings:",
    ...OPENING_LENGTHS.map((length) => `    ${length} words: ${describeOpening(report.global, length)}`),
  ];

  if (report.global.assistantCliches.byPhrase.length > 0) {
    lines.push(
      `  Top clichés: ${report.global.assistantCliches.byPhrase
        .slice(0, 5)
        .map((entry) => `${entry.language}:${entry.label} ×${entry.count}`)
        .join("; ")}`,
    );
  }
  if (report.global.duplicatePairs.exact.examples.length > 0) {
    lines.push("  Exact duplicate examples:");
    for (const example of report.global.duplicatePairs.exact.examples.slice(0, 3)) lines.push(`    - ${renderPairExample(example)}`);
  }
  if (report.global.duplicatePairs.near.examples.length > 0) {
    lines.push("  Near duplicate examples:");
    for (const example of report.global.duplicatePairs.near.examples.slice(0, 3)) lines.push(`    - ${renderPairExample(example)}`);
  }

  lines.push("", "Per persona");
  for (const persona of report.personas) {
    lines.push(
      `${persona.personaId}`,
      `  Messages / median words: ${persona.messageCount} / ${persona.medianWords}`,
      `  Repeated openings: 2w ${describeOpening(persona, 2)}; 3w ${describeOpening(persona, 3)}; 4w ${describeOpening(persona, 4)}`,
      `  Duplicate pairs: ${persona.duplicatePairs.exact.count} exact / ${persona.duplicatePairs.near.count} near`,
      `  Assistant clichés: ${persona.assistantCliches.messageCount} messages (${percent(persona.assistantCliches.messageRate)}), ${persona.assistantCliches.hitCount} hits`,
      `  Emoji: ${percent(persona.emoji.messageRate)} of messages (${persona.emoji.emojiCount} total)`,
      `  Cross-persona echo: ${persona.crossPersonaEcho.count} pairs (${persona.crossPersonaEcho.exactCount} exact / ${persona.crossPersonaEcho.nearCount} near)`,
    );
  }

  lines.push("");
  if (report.strict.passed) {
    lines.push(report.strict.enabled ? "Strict gross-regression guard: PASS" : "Gross-regression guard: PASS (advisory; use --strict to enforce)");
  } else {
    lines.push(report.strict.enabled ? "Strict gross-regression guard: FAIL" : "Gross-regression guard: would FAIL (advisory)");
    for (const issue of report.strict.issues) {
      lines.push(`  - ${issue.scope} ${issue.metric}: ${issue.value} > ${issue.threshold}`);
    }
  }
  return `${lines.join("\n")}\n`;
};

const usage = `Usage: npm run audit:humanity -- [options]

Reads ROOM_STATE_PATH or ./data/room-state.json without modifying it.

Options:
  --json                 Print the complete machine-readable report
  --strict               Exit 1 only when a gross-regression threshold is crossed
  --state <path>         Override ROOM_STATE_PATH
  --pair-window <count>  Compare each AI message with this many predecessors (default: ${DEFAULT_PAIR_WINDOW})
  --help                  Show this help
`;

const parseArguments = (argv) => {
  const options = {
    json: false,
    strict: false,
    statePath: process.env.ROOM_STATE_PATH ?? "data/room-state.json",
    pairWindow: DEFAULT_PAIR_WINDOW,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--strict") options.strict = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--state") {
      const value = argv[index + 1];
      if (!value) throw new Error("--state requires a path.");
      options.statePath = value;
      index += 1;
    } else if (argument === "--pair-window") {
      const value = Number(argv[index + 1]);
      if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
        throw new Error("--pair-window must be an integer from 1 to 10000.");
      }
      options.pairWindow = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage);
    return;
  }
  const statePath = resolve(process.cwd(), options.statePath);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const report = auditState(state, { source: statePath, pairWindow: options.pairWindow, strict: options.strict });
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : renderHumanReport(report));
  if (options.strict && !report.strict.passed) process.exitCode = 1;
};

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`humanity-audit: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
