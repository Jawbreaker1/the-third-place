export type PersonaCasing = "sentence" | "relaxed" | "lowercase";
export type PersonaPunctuation = "minimal" | "plain" | "precise" | "expressive" | "deadpan";
export type PersonaCorrectionMode = "let-go" | "soft-question" | "specific-fix" | "evidence-first" | "boundary-only";
export type PersonaDisagreementMode =
  | "rare-gentle"
  | "curious-pushback"
  | "practical-objection"
  | "steelman-counterpoint"
  | "blunt-challenge"
  | "playful-provocation";

export interface PersonaStyleFingerprint {
  /** The normal range, not a target that every message must fill. */
  typicalWords: readonly [number, number];
  /** A hard ceiling for ordinary text chat. Voice mode can impose a lower ceiling. */
  hardMaxWords: number;
  typicalSentences: readonly [number, number];
  casing: PersonaCasing;
  punctuation: PersonaPunctuation;
  /** Approximate share of eligible messages containing one emoji. Zero means never. */
  emojiRate: number;
  emojiPalette?: readonly string[];
  /** 0 = one plain reaction, 1 = occasionally sustain a nuanced multi-part thought. */
  complexityAppetite: number;
  correctionMode: PersonaCorrectionMode;
  disagreementMode: PersonaDisagreementMode;
  /** Options to rotate between, never mandatory tics. */
  conversationHabits: readonly string[];
  /** Persona-specific crutches in addition to the community-wide assistantisms. */
  avoidPhrases: readonly string[];
}

export interface StyledPersonaLike {
  id: string;
  name: string;
  style: PersonaStyleFingerprint;
}

export interface PersonaStyleTurnPolicy {
  /** A palette value is present only on turns where one emoji is permitted. */
  emoji?: string;
  /** A single optional habit is exposed to the model; the other habits stay hidden. */
  habit?: string;
  ending: "statement" | "question-allowed" | "question-required";
}

export const GENERIC_ASSISTANT_PHRASES = [
  "As an AI",
  "Absolutely!",
  "Great point",
  "It's important to note",
  "That being said",
  "I completely agree",
  "Let's dive in",
  "in conclusion",
] as const;

const casingNotes: Record<PersonaCasing, string> = {
  sentence: "Normal sentence casing; fragments may still be fragments.",
  relaxed: "Relaxed chat casing: usually sentence case, sometimes a lowercase opening when it feels spontaneous.",
  lowercase: "Write lowercase, including the opening, except where code or a proper name truly needs capitals.",
};

const punctuationNotes: Record<PersonaPunctuation, string> = {
  minimal: "Minimal punctuation; often no final period on a short line. Never stack punctuation.",
  plain: "Plain punctuation. Prefer periods or a single question mark; no ornamental dashes.",
  precise: "Clean, precise punctuation. Parentheses are rare and only carry real information.",
  expressive: "Expressive but believable chat punctuation; an occasional ! or ? is enough, never !!! or ?!?!.",
  deadpan: "Flat, deadpan punctuation. A period can carry the joke; do not explain it.",
};

const correctionNotes: Record<PersonaCorrectionMode, string> = {
  "let-go": "Let harmless inaccuracies pass unless they change the point.",
  "soft-question": "Correct by asking one natural clarifying question rather than delivering a fact-check speech.",
  "specific-fix": "If correction matters, name the exact wrong detail and the replacement in one compact line.",
  "evidence-first": "Challenge factual claims only with a concrete reason or evidence; openly say when the evidence is missing.",
  "boundary-only": "Ignore ordinary errors; intervene only when a safety or community boundary actually matters.",
};

const disagreementNotes: Record<PersonaDisagreementMode, string> = {
  "rare-gentle": "Usually build on the other person; when disagreeing, soften it without becoming vague.",
  "curious-pushback": "Push back through one sharp question or alternate reading, not a full debate brief.",
  "practical-objection": "Disagree by naming one concrete constraint and, when natural, a smaller workable option.",
  "steelman-counterpoint": "State the strongest missing counterpoint fairly, without pretending both sides are equally strong.",
  "blunt-challenge": "Challenge the claim directly and briefly, never the speaker's intelligence or motives.",
  "playful-provocation": "Use a teasing counterclaim or absurd comparison, then leave space for someone else to answer.",
};

const emojiNote = (style: PersonaStyleFingerprint): string => {
  if (style.emojiRate <= 0) return "Use no emoji.";
  const every = Math.max(2, Math.round(1 / style.emojiRate));
  const palette = style.emojiPalette?.length ? ` If one fits, prefer ${style.emojiPalette.join(" ")}.` : "";
  return `Emoji are genuinely rare: roughly one eligible message in ${every}, never more than one and never as a personality badge.${palette}`;
};

const complexityNote = (appetite: number): string => {
  if (appetite < 0.25) return "Keep to one plain reaction or observation; do not unpack every implication.";
  if (appetite < 0.55) return "Usually make one point; occasionally add a short reason when the topic deserves it.";
  if (appetite < 0.8) return "Can carry a specific claim plus one supporting reason, while staying chat-sized.";
  return "May occasionally introduce a nuanced or second-order thought, but never turn it into an essay.";
};

export interface PersonaStylePromptOptions {
  medium?: "text" | "voice";
  /** Stable, scene-scoped key. Supplying it activates a deterministic per-turn budget. */
  turnKey?: string;
  /** Explicit scene roles may narrow the deterministic ending budget. */
  endingOverride?: PersonaStyleTurnPolicy["ending"];
}

const hashUnit = (value: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
};

/**
 * Converts statistical persona traits into one concrete turn budget. It is
 * deliberately derived from opaque scene metadata rather than shared style
 * memory, so nothing written in one room is carried into another room.
 */
export const derivePersonaStyleTurnPolicy = (
  persona: StyledPersonaLike,
  turnKey: string,
  medium: "text" | "voice" = "text",
  endingOverride?: PersonaStyleTurnPolicy["ending"],
): PersonaStyleTurnPolicy => {
  const key = `${turnKey}\u0000${persona.id}`;
  const palette = persona.style.emojiPalette ?? [];
  const emojiAllowed = medium !== "voice"
    && persona.style.emojiRate > 0
    && hashUnit(`${key}\u0000emoji`) < persona.style.emojiRate;
  const emoji = emojiAllowed && palette.length > 0
    ? palette[Math.floor(hashUnit(`${key}\u0000emoji-choice`) * palette.length)]
    : undefined;
  const questionRate = persona.style.correctionMode === "soft-question"
    || persona.style.disagreementMode === "curious-pushback"
    ? 0.3
    : 0.18;
  const ending = endingOverride
    ?? (hashUnit(`${key}\u0000question-budget`) < questionRate ? "question-allowed" : "statement");
  const eligibleHabits = ending === "statement"
    ? persona.style.conversationHabits.filter((habit) => !/\b(?:ask|question)\b/iu.test(habit))
    : persona.style.conversationHabits;
  const habitAllowed = eligibleHabits.length > 0 && hashUnit(`${key}\u0000habit-budget`) < 0.3;
  const habit = habitAllowed
    ? eligibleHabits[
        Math.floor(hashUnit(`${key}\u0000habit-choice`) * eligibleHabits.length)
      ]
    : undefined;

  return {
    ...(emoji ? { emoji } : {}),
    ...(habit ? { habit } : {}),
    ending,
  };
};

const correctionNoteForTurn = (
  style: PersonaStyleFingerprint,
  policy?: PersonaStyleTurnPolicy,
): string => {
  if (policy?.ending === "statement" && style.correctionMode === "soft-question") {
    return "If correction matters, flag the exact uncertainty gently in one compact statement rather than giving a fact-check speech.";
  }
  return correctionNotes[style.correctionMode];
};

const disagreementNoteForTurn = (
  style: PersonaStyleFingerprint,
  policy?: PersonaStyleTurnPolicy,
): string => {
  if (policy?.ending === "statement" && style.disagreementMode === "curious-pushback") {
    return "Push back with one alternate reading or concrete doubt, not a full debate brief.";
  }
  return disagreementNotes[style.disagreementMode];
};

const turnPolicyNote = (policy: PersonaStyleTurnPolicy): string => {
  const emoji = policy.emoji
    ? `One ${policy.emoji} is permitted if it genuinely adds tone; using none is better than forcing it.`
    : "Use no emoji in this message.";
  const habit = policy.habit
    ? `The only signature habit permitted is “${policy.habit}”, and it remains optional.`
    : "Use no signature habit in this message.";
  const ending = policy.ending === "question-required"
    ? "End with exactly one precise, genuine question required by this scene role; do not add a second question."
    : policy.ending === "question-allowed"
      ? "A genuine question is permitted but not required; never add one merely to keep the chat moving."
      : "End with a statement, fragment or observation; do not ask a question in this message.";
  return `- Turn policy / emoji: ${emoji}
- Turn policy / habit: ${habit}
- Turn policy / ending: ${ending}`;
};

/**
 * Produces a compact, stable writing contract for a local model. The final line is
 * deliberately anti-mimicry: traits are distributions, not boxes to tick in every turn.
 */
export const buildPersonaStylePromptNote = (
  persona: StyledPersonaLike,
  options: PersonaStylePromptOptions = {},
): string => {
  const style = persona.style;
  const maxWords = options.medium === "voice" ? Math.min(25, style.hardMaxWords) : style.hardMaxWords;
  const habits = style.conversationHabits.map((habit) => `“${habit}”`).join("; ");
  const derivedPolicy = options.turnKey
    ? derivePersonaStyleTurnPolicy(
        persona,
        options.turnKey,
        options.medium ?? "text",
        options.endingOverride,
      )
    : undefined;
  const policy = derivedPolicy;
  const avoid = [...GENERIC_ASSISTANT_PHRASES, ...style.avoidPhrases]
    .map((phrase) => `“${phrase}”`)
    .join(", ");

  return `Stable voice for ${persona.name}:
- Length: usually ${style.typicalWords[0]}–${Math.min(style.typicalWords[1], maxWords)} words and ${style.typicalSentences[0]}–${style.typicalSentences[1]} sentence(s); hard maximum ${maxWords} words. Fragments are allowed when natural.
- Casing/punctuation: ${casingNotes[style.casing]} ${punctuationNotes[style.punctuation]}
- Emoji: ${policy ? "Follow this turn's explicit emoji budget below; do not infer a broader allowance from the persona." : emojiNote(style)}
- Thought density: ${complexityNote(style.complexityAppetite)}
- Corrections: ${correctionNoteForTurn(style, policy)}
- Disagreement: ${disagreementNoteForTurn(style, policy)}
${policy ? turnPolicyNote(policy) : `- Optional habits to rotate, at most one per message: ${habits}.`}
- Avoid these canned openings or crutches: ${avoid}.
- Do not perform every trait every time, announce the style, reuse the same opening, or turn a habit into a catchphrase.`;
};

export const buildPersonaStylePromptNotes = (
  personas: readonly StyledPersonaLike[],
  options: PersonaStylePromptOptions = {},
): Record<string, string> =>
  Object.fromEntries(personas.map((persona) => [persona.id, buildPersonaStylePromptNote(persona, options)]));

/** A deterministic representation useful for diagnostics and regression tests. */
export const personaStyleSignature = (style: PersonaStyleFingerprint): string =>
  [
    style.typicalWords.join("-"),
    style.hardMaxWords,
    style.typicalSentences.join("-"),
    style.casing,
    style.punctuation,
    style.emojiRate,
    style.complexityAppetite,
    style.correctionMode,
    style.disagreementMode,
    style.conversationHabits.join("|"),
  ].join(":");
