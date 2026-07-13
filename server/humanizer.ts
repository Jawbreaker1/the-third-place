export type HumanizerMode = "chat" | "voice" | "technical";

export type HumanizerSeverity = "none" | "low" | "medium" | "high";

export type HumanizerReasonCode =
  | "near_duplicate_self"
  | "near_duplicate_peer"
  | "reused_opening"
  | "assistant_cliche"
  | "ai_meta_language"
  | "overly_polished"
  | "list_like_reply"
  | "style_contract";

export interface HumanizerSimilarity {
  /** Dice similarity of ordered word n-grams. */
  tokenNgrams: number;
  /** Dice similarity of Unicode character 4-grams. */
  characterNgrams: number;
  /** Jaccard similarity of unique words. Kept low-weight to avoid topic false positives. */
  vocabulary: number;
  /** Length-aware aggregate in the range 0..1. */
  combined: number;
}

export interface HumanizerReason {
  code: HumanizerReasonCode;
  severity: Exclude<HumanizerSeverity, "none">;
  message: string;
  hint: string;
  similarity?: HumanizerSimilarity;
  matchedText?: string;
  evidence?: readonly string[];
}

export interface HumanizerAssessment {
  /** False only for high-severity failures which should be repaired/regenerated. */
  acceptable: boolean;
  severity: HumanizerSeverity;
  reasons: readonly HumanizerReason[];
  reasonCodes: readonly HumanizerReasonCode[];
  hints: readonly string[];
  protectedFragments: readonly ProtectedFragment[];
  metrics: {
    wordCount: number;
    maximumSelfSimilarity: number;
    maximumPeerSimilarity: number;
  };
}

export interface AssessCandidateInput {
  personaId: string;
  text: string;
  recentOwnTexts?: readonly string[];
  peerTexts?: readonly string[];
  mode?: HumanizerMode;
  /** Set this when a structured answer was explicitly requested by a human. */
  allowList?: boolean;
  /** Set only when the human explicitly asks about the resident's AI identity. */
  allowAiIdentity?: boolean;
}

export type ProtectedFragmentKind = "fenced-code" | "inline-code" | "url";

export interface ProtectedFragment {
  kind: ProtectedFragmentKind;
  placeholder: string;
  value: string;
}

export interface ProtectedText {
  text: string;
  fragments: readonly ProtectedFragment[];
}

const severityRank: Record<HumanizerSeverity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

const SELF_HINT =
  "Tillför en ny tanke eller en tydligt annan vinkel; återanvänd inte personans senaste formulering.";
const PEER_HINT =
  "Svara med personans egen ståndpunkt och rytm i stället för att spegla en annan bots formulering.";
const OPENING_HINT = "Börja direkt i sak med en annan öppning och meningsrytm.";
const CLICHE_HINT = "Ta bort servicefrasen och skriv som en person mitt i ett pågående samtal.";
const META_HINT = "Skriv som personen själv; nämn inte AI, språkmodell, prompt eller hur svaret skapades.";
const POLISHED_HINT = "Gör repliken rakare och mindre uppsatslik; behåll bara den poäng personen faktiskt vill göra.";
const LIST_HINT = "Gör om listan till en eller två naturliga chattrader om ingen uttryckligen bad om en lista.";

const collapseWhitespace = (value: string) => value.replace(/\s+/gu, " ").trim();

const stripUrlTail = (value: string): { value: string; tail: string } => {
  let end = value.length;
  while (end > 0 && /[.,!?;:}\]]/u.test(value[end - 1] ?? "")) end -= 1;
  // A closing parenthesis belongs to the URL only when it balances an opening one.
  while (end > 0 && value[end - 1] === ")") {
    const body = value.slice(0, end);
    const opens = (body.match(/\(/gu) ?? []).length;
    const closes = (body.match(/\)/gu) ?? []).length;
    if (closes <= opens) break;
    end -= 1;
  }
  return { value: value.slice(0, end), tail: value.slice(end) };
};

/**
 * Replaces code and URLs with stable sentinels. This lets a repair pass rewrite
 * prose without silently changing technical material.
 */
export const protectTechnicalFragments = (input: string): ProtectedText => {
  const fragments: ProtectedFragment[] = [];
  let namespace = 0;
  while (input.includes(`\u27e6HUMANIZER_${namespace}_`)) namespace += 1;
  const pattern = /```[\s\S]*?```|`[^`\n]+`|https?:\/\/[^\s<>"'`]+/giu;
  const text = input.replace(pattern, (raw) => {
    let value = raw;
    let tail = "";
    let kind: ProtectedFragmentKind;
    if (raw.startsWith("```")) kind = "fenced-code";
    else if (raw.startsWith("`")) kind = "inline-code";
    else {
      kind = "url";
      ({ value, tail } = stripUrlTail(raw));
    }
    if (!value) return raw;
    const placeholder = `\u27e6HUMANIZER_${namespace}_${fragments.length}\u27e7`;
    fragments.push({ kind, placeholder, value });
    return `${placeholder}${tail}`;
  });
  return { text, fragments };
};

export const restoreTechnicalFragments = (
  input: string,
  fragments: readonly ProtectedFragment[],
): string => {
  let restored = input;
  for (const fragment of fragments) restored = restored.split(fragment.placeholder).join(fragment.value);
  return restored;
};

const normalizeAnalysisText = (input: string): string =>
  collapseWhitespace(
    input
      .normalize("NFKC")
      .toLocaleLowerCase("sv-SE")
      .replace(/[’']/gu, "'")
      .replace(/[\p{Pd}-]+/gu, " ")
      .replace(/[_*~#>|]/gu, " "),
  );

const textForAnalysis = (input: string): string => {
  const protectedText = protectTechnicalFragments(input);
  let prose = protectedText.text;
  for (const fragment of protectedText.fragments) prose = prose.split(fragment.placeholder).join(" ");
  return normalizeAnalysisText(prose);
};

const textForSimilarityAnalysis = (input: string): string => {
  const protectedText = protectTechnicalFragments(input);
  let analyzable = protectedText.text;
  for (const fragment of protectedText.fragments) {
    const fragmentWords = fragment.value
      .normalize("NFKC")
      .toLocaleLowerCase("sv-SE")
      .match(/[\p{L}\p{M}\p{N}]+/gu)
      ?.slice(0, 10)
      .join(" ") ?? "";
    analyzable = analyzable
      .split(fragment.placeholder)
      .join(` ${fragment.kind.replace("-", " ")} ${fragmentWords} `);
  }
  return normalizeAnalysisText(analyzable);
};

const wordsOf = (input: string): string[] =>
  textForAnalysis(input).match(/[\p{L}\p{M}\p{N}]+(?:['-][\p{L}\p{M}\p{N}]+)*/gu) ?? [];

const similarityWordsOf = (input: string): string[] =>
  textForSimilarityAnalysis(input).match(/[\p{L}\p{M}\p{N}]+(?:['-][\p{L}\p{M}\p{N}]+)*/gu) ?? [];

const setOfNgrams = (parts: readonly string[], size: number): Set<string> => {
  if (parts.length === 0) return new Set();
  if (parts.length < size) return new Set([parts.join("\u241f")]);
  const result = new Set<string>();
  for (let index = 0; index <= parts.length - size; index += 1) {
    result.add(parts.slice(index, index + size).join("\u241f"));
  }
  return result;
};

const dice = (left: ReadonlySet<string>, right: ReadonlySet<string>): number => {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const value of left) if (right.has(value)) overlap += 1;
  return (2 * overlap) / (left.size + right.size);
};

const jaccard = (left: ReadonlySet<string>, right: ReadonlySet<string>): number => {
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const value of left) if (right.has(value)) overlap += 1;
  return overlap / (left.size + right.size - overlap);
};

const characterNgrams = (input: string): Set<string> => {
  const characters = [...textForSimilarityAnalysis(input).replace(/\s+/gu, " ")];
  return setOfNgrams(characters, 4);
};

export const compareHumanizerSimilarity = (left: string, right: string): HumanizerSimilarity => {
  const leftWords = similarityWordsOf(left);
  const rightWords = similarityWordsOf(right);
  if (leftWords.length === 0 || rightWords.length === 0) {
    return { tokenNgrams: 0, characterNgrams: 0, vocabulary: 0, combined: 0 };
  }
  const ngramSize = Math.min(leftWords.length, rightWords.length) >= 12 ? 3 : 2;
  const tokenNgrams = dice(setOfNgrams(leftWords, ngramSize), setOfNgrams(rightWords, ngramSize));
  const characterScore = dice(characterNgrams(left), characterNgrams(right));
  const vocabulary = jaccard(new Set(leftWords), new Set(rightWords));
  const lengthRatio = Math.min(leftWords.length, rightWords.length) / Math.max(leftWords.length, rightWords.length);
  const combined = (tokenNgrams * 0.52 + characterScore * 0.33 + vocabulary * 0.15) *
    (0.82 + lengthRatio * 0.18);
  return {
    tokenNgrams,
    characterNgrams: characterScore,
    vocabulary,
    combined: Math.min(1, Math.max(0, combined)),
  };
};

interface TextMatch {
  text: string;
  similarity: HumanizerSimilarity;
}

const strongestMatch = (candidate: string, references: readonly string[]): TextMatch | undefined => {
  let result: TextMatch | undefined;
  for (const text of references.slice(-24)) {
    const similarity = compareHumanizerSimilarity(candidate, text);
    if (!result || similarity.combined > result.similarity.combined) result = { text, similarity };
  }
  return result;
};

const duplicateThreshold = (wordCount: number, peer: boolean): { medium: number; high: number } => {
  if (wordCount < 6) return { medium: 0.97, high: 0.995 };
  if (wordCount < 9) return { medium: peer ? 0.88 : 0.84, high: peer ? 0.96 : 0.94 };
  return { medium: peer ? 0.69 : 0.64, high: peer ? 0.84 : 0.8 };
};

const openingKey = (input: string, size: number): string | undefined => {
  const words = wordsOf(input);
  return words.length >= Math.max(7, size) ? words.slice(0, size).join(" ") : undefined;
};

interface PhraseRule {
  pattern: RegExp;
  label: string;
  severity: "medium" | "high";
  minWords: number;
}

const clicheRules: readonly PhraseRule[] = [
  { pattern: /^(?:absolut|sj\u00e4lvklart)[!,.]?\s+(?:h\u00e4r|jag|det|l\u00e5t)/iu, label: "Absolut/Sj\u00e4lvklart \u2026", severity: "medium", minWords: 7 },
  { pattern: /^bra (?:fr\u00e5ga|po\u00e4ng)[!,.]?\s/iu, label: "Bra fr\u00e5ga/po\u00e4ng \u2026", severity: "medium", minWords: 7 },
  { pattern: /\bdet (?:\u00e4r|kan vara) viktigt att (?:notera|komma ih\u00e5g)\b/iu, label: "viktigt att notera", severity: "medium", minWords: 8 },
  { pattern: /\bl\u00e5t oss (?:dyka ner|utforska|titta n\u00e4rmare)\b/iu, label: "L\u00e5t oss dyka ner", severity: "medium", minWords: 7 },
  { pattern: /\bjag (?:hj\u00e4lper|hj\u00e4lper dig) g\u00e4rna\b/iu, label: "hj\u00e4lper g\u00e4rna", severity: "medium", minWords: 7 },
  { pattern: /^(?:absolutely|certainly)[!,.]?\s+(?:here|i|that|let)/iu, label: "Absolutely/Certainly \u2026", severity: "medium", minWords: 7 },
  { pattern: /^great (?:question|point)[!,.]?\s/iu, label: "Great question/point \u2026", severity: "medium", minWords: 7 },
  { pattern: /\bit(?:'|\u2019)s important to (?:note|remember)\b/iu, label: "It is important to note", severity: "medium", minWords: 8 },
  { pattern: /\blet(?:'|\u2019)s (?:dive in|explore|break (?:it|this) down)\b/iu, label: "Let's dive in", severity: "medium", minWords: 7 },
  { pattern: /\bi(?:'|\u2019)d be happy to\b/iu, label: "I'd be happy to", severity: "medium", minWords: 7 },
];

const metaRules: readonly PhraseRule[] = [
  { pattern: /\bsom (?:en )?(?:ai|artificiell intelligens|spr\u00e5kmodell)\b/iu, label: "som en AI/spr\u00e5kmodell", severity: "high", minWords: 1 },
  { pattern: /\b(?:min|mitt) (?:tr\u00e4ningsdata|kunskapsgr\u00e4ns|systemprompt|prompt)\b/iu, label: "tr\u00e4ningsdata/prompt", severity: "high", minWords: 1 },
  { pattern: /\bjag (?:kan inte|har ingen m\u00f6jlighet att) (?:surfa|webbl\u00e4sa|ha k\u00e4nslor)\b/iu, label: "AI-begr\u00e4nsning", severity: "high", minWords: 1 },
  { pattern: /\bas an (?:ai|artificial intelligence|language model)\b/iu, label: "as an AI/language model", severity: "high", minWords: 1 },
  { pattern: /\bmy (?:training data|knowledge cutoff|system prompt|prompt)\b/iu, label: "training data/prompt", severity: "high", minWords: 1 },
  { pattern: /\bi (?:cannot|can(?:'|\u2019)t|do not) (?:browse|have feelings)\b/iu, label: "AI limitation", severity: "high", minWords: 1 },
];

const findRules = (text: string, rules: readonly PhraseRule[], wordCount: number): PhraseRule[] =>
  rules.filter((rule) => wordCount >= rule.minWords && rule.pattern.test(text));

const nonCodeLines = (input: string): string[] => {
  const protectedText = protectTechnicalFragments(input);
  let masked = protectedText.text;
  for (const fragment of protectedText.fragments) masked = masked.split(fragment.placeholder).join("");
  return masked.split(/\r?\n/gu);
};

const listItemCount = (input: string): number =>
  nonCodeLines(input).filter((line) => /^\s*(?:[-*\u2022]|\d{1,2}[.)])\s+\S/u.test(line)).length;

const headingCount = (input: string): number =>
  nonCodeLines(input).filter((line) => /^\s{0,3}#{1,4}\s+\S/u.test(line)).length;

const transitionLabels = (input: string): string[] => {
  const plain = textForAnalysis(input);
  const transitions: Array<[RegExp, string]> = [
    [/\bf\u00f6r det f\u00f6rsta\b/iu, "f\u00f6r det f\u00f6rsta"],
    [/\bf\u00f6r det andra\b/iu, "f\u00f6r det andra"],
    [/\bdessutom\b/iu, "dessutom"],
    [/\bsammanfattningsvis\b/iu, "sammanfattningsvis"],
    [/\b\u00e5 ena sidan\b/iu, "\u00e5 ena sidan"],
    [/\b\u00e5 andra sidan\b/iu, "\u00e5 andra sidan"],
    [/\bfirst(?:ly)?\b/iu, "firstly"],
    [/\bsecond(?:ly)?\b/iu, "secondly"],
    [/\bmoreover\b/iu, "moreover"],
    [/\bin conclusion\b/iu, "in conclusion"],
    [/\bon the one hand\b/iu, "on the one hand"],
    [/\bon the other hand\b/iu, "on the other hand"],
  ];
  return transitions.filter(([pattern]) => pattern.test(plain)).map(([, label]) => label);
};

const addReason = (reasons: HumanizerReason[], reason: HumanizerReason): void => {
  if (!reasons.some((candidate) => candidate.code === reason.code)) reasons.push(reason);
};

export const assessCandidate = (input: AssessCandidateInput): HumanizerAssessment => {
  const mode = input.mode ?? "chat";
  const reasons: HumanizerReason[] = [];
  const ownTexts = (input.recentOwnTexts ?? []).filter((text) => text.trim()).slice(-24);
  const peerTexts = (input.peerTexts ?? []).filter((text) => text.trim()).slice(-24);
  const candidateWords = wordsOf(input.text);
  const wordCount = candidateWords.length;
  const ownMatch = strongestMatch(input.text, ownTexts);
  const peerMatch = strongestMatch(input.text, peerTexts);

  if (ownMatch) {
    const threshold = duplicateThreshold(wordCount, false);
    const severity = ownMatch.similarity.combined >= threshold.high
      ? "high"
      : ownMatch.similarity.combined >= threshold.medium
        ? "medium"
        : undefined;
    if (severity) {
      addReason(reasons, {
        code: "near_duplicate_self",
        severity,
        message: `Repliken ligger f\u00f6r n\u00e4ra personans eget tidigare inl\u00e4gg (${ownMatch.similarity.combined.toFixed(2)}).`,
        hint: SELF_HINT,
        similarity: ownMatch.similarity,
        matchedText: ownMatch.text,
      });
    }
  }

  if (peerMatch) {
    const threshold = duplicateThreshold(wordCount, true);
    const severity = peerMatch.similarity.combined >= threshold.high
      ? "high"
      : peerMatch.similarity.combined >= threshold.medium
        ? "medium"
        : undefined;
    if (severity) {
      addReason(reasons, {
        code: "near_duplicate_peer",
        severity,
        message: `Repliken speglar en annan deltagares formulering (${peerMatch.similarity.combined.toFixed(2)}).`,
        hint: PEER_HINT,
        similarity: peerMatch.similarity,
        matchedText: peerMatch.text,
      });
    }
  }

  const opening3 = openingKey(input.text, 3);
  const opening4 = openingKey(input.text, 4);
  if (opening3) {
    const matchingOpenings = ownTexts.filter((text) => openingKey(text, 3) === opening3);
    const distinctiveOpeningMatch = opening4 && ownTexts.some((text) => openingKey(text, 4) === opening4);
    if (matchingOpenings.length >= 2 || distinctiveOpeningMatch) {
      addReason(reasons, {
        code: "reused_opening",
        severity: matchingOpenings.length >= 2 ? "medium" : "low",
        message: `Personan har nyligen anv\u00e4nt samma \u00f6ppning: \u201d${opening4 ?? opening3}\u201d.`,
        hint: OPENING_HINT,
        evidence: [opening4 ?? opening3],
      });
    }
  }

  const plainText = textForAnalysis(input.text);
  const clichés = findRules(plainText, clicheRules, wordCount);
  if (clichés.length > 0) {
    addReason(reasons, {
      code: "assistant_cliche",
      severity: clichés.some((rule) => rule.severity === "high") ? "high" : "medium",
      message: `Repliken anv\u00e4nder en typisk assistentfras: ${clichés.map((rule) => rule.label).join(", ")}.`,
      hint: CLICHE_HINT,
      evidence: clichés.map((rule) => rule.label),
    });
  }

  const meta = input.allowAiIdentity ? [] : findRules(plainText, metaRules, wordCount);
  if (meta.length > 0) {
    addReason(reasons, {
      code: "ai_meta_language",
      severity: "high",
      message: `Repliken bryter illusionen med AI-meta: ${meta.map((rule) => rule.label).join(", ")}.`,
      hint: META_HINT,
      evidence: meta.map((rule) => rule.label),
    });
  }

  const lists = listItemCount(input.text);
  const headings = headingCount(input.text);
  if (!input.allowList && mode !== "technical" && (lists >= 3 || headings >= 2)) {
    addReason(reasons, {
      code: "list_like_reply",
      severity: lists >= 5 || headings >= 3 ? "medium" : "low",
      message: `Repliken ser ut som ett assistentsvar (${lists} listpunkter, ${headings} rubriker).`,
      hint: LIST_HINT,
      evidence: [`listpunkter:${lists}`, `rubriker:${headings}`],
    });
  }

  const transitions = transitionLabels(input.text);
  const polishedLimit = mode === "voice" ? 2 : 3;
  if (wordCount >= (mode === "voice" ? 24 : 38) && transitions.length >= polishedLimit) {
    addReason(reasons, {
      code: "overly_polished",
      severity: transitions.length >= polishedLimit + 1 ? "medium" : "low",
      message: `Repliken l\u00e5ter mer som en uppsats \u00e4n spontan chatt: ${transitions.join(", ")}.`,
      hint: POLISHED_HINT,
      evidence: transitions,
    });
  }

  let severity = reasons.reduce<HumanizerSeverity>(
    (current, reason) => severityRank[reason.severity] > severityRank[current] ? reason.severity : current,
    "none",
  );
  const reasonCodes = new Set(reasons.map((reason) => reason.code));
  const clearlyAssistantShaped =
    reasonCodes.has("assistant_cliche") &&
    (reasonCodes.has("list_like_reply") || reasonCodes.has("overly_polished"));
  const repeatedPerformance =
    reasonCodes.has("near_duplicate_self") && reasonCodes.has("reused_opening");
  // Two independent medium signals are more trustworthy than aggressively
  // rejecting one common chat phrase. This is the only composite escalation.
  if (severity !== "high" && (clearlyAssistantShaped || repeatedPerformance)) severity = "high";
  const hints = [...new Set(reasons.map((reason) => reason.hint))];
  const protectedFragments = protectTechnicalFragments(input.text).fragments;
  return {
    acceptable: severity !== "high",
    severity,
    reasons,
    reasonCodes: [...reasonCodes],
    hints,
    protectedFragments,
    metrics: {
      wordCount,
      maximumSelfSimilarity: ownMatch?.similarity.combined ?? 0,
      maximumPeerSimilarity: peerMatch?.similarity.combined ?? 0,
    },
  };
};

export const buildHumanizerRepairInstruction = (
  assessment: HumanizerAssessment,
): string | undefined => {
  if (assessment.severity !== "high") return undefined;
  const lines = [
    "Rewrite only the candidate chat message. Keep its intended claim, facts and language.",
    ...assessment.hints.map((hint) => `- ${hint}`),
  ];
  if (assessment.protectedFragments.length > 0) {
    lines.push(
      `- Keep every immutable technical token exactly once: ${assessment.protectedFragments
        .map((fragment) => fragment.placeholder)
        .join(", ")}.`,
    );
  }
  lines.push("Return only the rewritten message, with no explanation or quotation marks.");
  return lines.join("\n");
};

export interface HumanStyleMemoryOptions {
  maxEntriesPerPersona?: number;
  maxPersonas?: number;
  maxEntryCharacters?: number;
}

interface HumanStyleMemoryEntry {
  text: string;
  sequence: number;
}

/** Bounded in-memory history intended for recent style comparison, not factual memory. */
export class HumanStyleMemory {
  private readonly entries = new Map<string, HumanStyleMemoryEntry[]>();
  private sequence = 0;
  private readonly maxEntriesPerPersona: number;
  private readonly maxPersonas: number;
  private readonly maxEntryCharacters: number;

  constructor(options: HumanStyleMemoryOptions = {}) {
    this.maxEntriesPerPersona = Math.max(1, Math.min(100, Math.trunc(options.maxEntriesPerPersona ?? 16)));
    this.maxPersonas = Math.max(1, Math.min(1_000, Math.trunc(options.maxPersonas ?? 128)));
    this.maxEntryCharacters = Math.max(64, Math.min(20_000, Math.trunc(options.maxEntryCharacters ?? 2_000)));
  }

  remember(personaId: string, text: string): void {
    const cleanId = personaId.trim();
    const cleanText = text.trim().slice(0, this.maxEntryCharacters);
    if (!cleanId || !cleanText) return;
    const current = this.entries.get(cleanId) ?? [];
    current.push({ text: cleanText, sequence: ++this.sequence });
    if (current.length > this.maxEntriesPerPersona) current.splice(0, current.length - this.maxEntriesPerPersona);
    this.entries.delete(cleanId);
    this.entries.set(cleanId, current);
    while (this.entries.size > this.maxPersonas) {
      const oldestPersona = this.entries.keys().next().value as string | undefined;
      if (!oldestPersona) break;
      this.entries.delete(oldestPersona);
    }
  }

  recent(personaId: string, limit = this.maxEntriesPerPersona): string[] {
    const safeLimit = Math.max(0, Math.min(this.maxEntriesPerPersona, Math.trunc(limit)));
    if (safeLimit === 0) return [];
    return (this.entries.get(personaId) ?? []).slice(-safeLimit).map((entry) => entry.text);
  }

  assess(input: Omit<AssessCandidateInput, "recentOwnTexts"> & { recentOwnTexts?: readonly string[] }): HumanizerAssessment {
    return assessCandidate({
      ...input,
      recentOwnTexts: [...this.recent(input.personaId), ...(input.recentOwnTexts ?? [])].slice(-24),
    });
  }

  forget(personaId: string): void {
    this.entries.delete(personaId);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
