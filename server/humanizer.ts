import { trimTrailingUrlPunctuation } from "../shared/unicodeBoundaries.js";
import { unicodeCaselessKey } from "../shared/unicodeSafety.js";
import { canonicalRegisteredLanguageTag } from "./registeredLanguageTags.js";

export type HumanizerMode = "chat" | "voice" | "technical";

export type HumanizerRegister =
  | "everyday"
  | "banter"
  | "technical"
  | "analytical"
  | "fandom"
  | "studio";

export type HumanizerSeverity = "none" | "low" | "medium" | "high";

export type HumanizerReasonCode =
  | "near_duplicate_self"
  | "near_duplicate_peer"
  | "reused_opening"
  | "assistant_cliche"
  | "ai_meta_language"
  | "overly_polished"
  | "register_mismatch"
  | "list_like_reply"
  | "evidence_denial"
  | "evidence_ungrounded"
  | "room_contract"
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
  /** Room-level formality ceiling. This never replaces the persona's own voice. */
  register?: HumanizerRegister;
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
  "Add a genuinely new thought or angle without reusing the actor's recent wording; keep the candidate's language.";
const PEER_HINT =
  "Use this actor's own stance and rhythm instead of echoing another participant; keep the candidate's language.";
const OPENING_HINT = "Start directly with a different opening and sentence rhythm; keep the candidate's language.";
const LIST_HINT = "Turn the unsolicited list into one or two natural chat lines in the same language.";

const collapseWhitespace = (value: string) => value.replace(/\s+/gu, " ").trim();

const stripUrlTail = (value: string): { value: string; tail: string } => {
  const stripped = trimTrailingUrlPunctuation(value);
  return { value: stripped, tail: value.slice(stripped.length) };
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
    unicodeCaselessKey(input)
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
    const fragmentWords = unicodeCaselessKey(fragment.value)
      .match(/[\p{L}\p{M}\p{N}]+/gu)
      ?.slice(0, 10)
      .join(" ") ?? "";
    analyzable = analyzable
      .split(fragment.placeholder)
      .join(` ${fragment.kind.replace("-", " ")} ${fragmentWords} `);
  }
  return normalizeAnalysisText(analyzable);
};

export const segmentWords = (input: string, languageTag?: string): string[] => {
  const text = input.normalize("NFKC").trim();
  if (!text) return [];
  const locale = canonicalRegisteredLanguageTag(languageTag);
  try {
    const segmenter = new Intl.Segmenter(locale, { granularity: "word" });
    return [...segmenter.segment(text)]
      .filter((segment) => segment.isWordLike)
      .map((segment) => unicodeCaselessKey(segment.segment));
  } catch {
    return unicodeCaselessKey(text).match(/[\p{L}\p{M}\p{N}]+(?:['-][\p{L}\p{M}\p{N}]+)*/gu) ?? [];
  }
};

const wordsOf = (input: string): string[] => segmentWords(textForAnalysis(input));

const similarityWordsOf = (input: string): string[] => segmentWords(textForSimilarityAnalysis(input));

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

const nonCodeLines = (input: string): string[] => {
  const protectedText = protectTechnicalFragments(input);
  let masked = protectedText.text;
  for (const fragment of protectedText.fragments) masked = masked.split(fragment.placeholder).join("");
  return masked.split(/\r?\n/gu);
};

const listItemCount = (input: string): number =>
  nonCodeLines(input).filter((line) => /^\s*(?:[-*\u2022]|\p{Nd}{1,2}[.)])\s+\S/u.test(line)).length;

const headingCount = (input: string): number =>
  nonCodeLines(input).filter((line) => /^\s{0,3}#{1,4}\s+\S/u.test(line)).length;

export interface ConversationRegisterAnalysis {
  wordCount: number;
  structureSignals: readonly string[];
  abstractionSignals: readonly string[];
}

/**
 * Language-neutral structural preflight. Meaning and register are reviewed by
 * the model; this layer only catches conspicuously essay-shaped typography and
 * density without maintaining Swedish/English vocabulary lists.
 */
export const analyzeConversationRegister = (input: string): ConversationRegisterAnalysis => {
  const protectedText = protectTechnicalFragments(input);
  let prose = protectedText.text;
  for (const fragment of protectedText.fragments) prose = prose.split(fragment.placeholder).join(" ");
  const words = segmentWords(normalizeAnalysisText(prose));
  const structureSignals: string[] = [];
  const abstractionSignals: string[] = [];
  const sentences = prose.split(/[.!?。！？]+/u).map((sentence) => sentence.trim()).filter(Boolean);
  const averageSentenceWords = words.length / Math.max(1, sentences.length);
  const commaCount = (prose.match(/[,،，]/gu) ?? []).length;
  const semicolonCount = (prose.match(/[;；]/gu) ?? []).length;
  const paragraphCount = prose.split(/\n\s*\n/gu).filter((paragraph) => paragraph.trim()).length;

  if (words.length >= 28 && averageSentenceWords >= 18) structureSignals.push("long-sentence-density");
  if (words.length >= 28 && commaCount >= 3) structureSignals.push("multi-clause-density");
  if (words.length >= 24 && semicolonCount >= 1) structureSignals.push("semicolon-structure");
  if (paragraphCount >= 3) structureSignals.push("multi-paragraph-structure");
  if (words.length >= 42 && sentences.length <= 2) structureSignals.push("compressed-essay-block");

  return { wordCount: words.length, structureSignals, abstractionSignals };
};

export const conversationRegisterMismatch = (
  input: string,
  register: HumanizerRegister,
): ConversationRegisterAnalysis & { mismatch: boolean } => {
  const analysis = analyzeConversationRegister(input);
  if (register === "technical" || register === "analytical") return { ...analysis, mismatch: false };
  const minimumWords = register === "banter" ? 24 : register === "everyday" ? 28 : 32;
  const minimumStructures = register === "banter" || register === "everyday" ? 2 : 3;
  const strongEssayShape =
    analysis.structureSignals.includes("semicolon-structure") ||
    analysis.structureSignals.includes("multi-paragraph-structure") ||
    analysis.structureSignals.length >= 4;
  return {
    ...analysis,
    mismatch:
      analysis.wordCount >= minimumWords &&
      analysis.structureSignals.length >= minimumStructures &&
      strongEssayShape,
  };
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
        message: `The candidate is too close to this actor's earlier line (${ownMatch.similarity.combined.toFixed(2)}).`,
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
        message: `The candidate echoes another participant's wording (${peerMatch.similarity.combined.toFixed(2)}).`,
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
        message: `The actor recently used the same opening: “${opening4 ?? opening3}”.`,
        hint: OPENING_HINT,
        evidence: [opening4 ?? opening3],
      });
    }
  }

  const lists = listItemCount(input.text);
  const headings = headingCount(input.text);
  if (!input.allowList && (lists >= 3 || headings >= 2)) {
    addReason(reasons, {
      code: "list_like_reply",
      severity: lists >= 5 || headings >= 3 ? "high" : "low",
      message: `The candidate has unsolicited answer formatting (${lists} list items, ${headings} headings).`,
      hint: LIST_HINT,
      evidence: [`listpunkter:${lists}`, `rubriker:${headings}`],
    });
  }

  let severity = reasons.reduce<HumanizerSeverity>(
    (current, reason) => severityRank[reason.severity] > severityRank[current] ? reason.severity : current,
    "none",
  );
  const reasonCodes = new Set(reasons.map((reason) => reason.code));
  const repeatedPerformance =
    reasonCodes.has("near_duplicate_self") && reasonCodes.has("reused_opening");
  if (severity !== "high" && repeatedPerformance) severity = "high";
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
