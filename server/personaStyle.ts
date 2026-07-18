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

export const PERSONA_SURFACE_TEXTURES = [
  "fragment",
  "self-correction",
  "stretched-emphasis",
  "rough-orthography",
  "harmless-typo",
  "mild-profanity",
] as const;

export type PersonaSurfaceTexture = (typeof PERSONA_SURFACE_TEXTURES)[number];

/** Server-assigned scene targets extend, but never silently alter, a persona's ordinary palette. */
export const TURN_SURFACE_TEXTURES = [
  ...PERSONA_SURFACE_TEXTURES,
  "strong-profanity",
] as const;

export type TurnSurfaceTexture = (typeof TURN_SURFACE_TEXTURES)[number];

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
  /** Approximate share of turns where an emotion already present in the moment may visibly leak through. */
  visibleAffectRate: number;
  /** Approximate share of text turns allowed one deliberately informal surface move. Must stay below 0.5. */
  surfaceTextureRate: number;
  /** Persona-specific moves to rotate between. The policy exposes at most one on any turn. */
  surfaceTexturePalette: readonly PersonaSurfaceTexture[];
  correctionMode: PersonaCorrectionMode;
  disagreementMode: PersonaDisagreementMode;
  /** Options to rotate between, never mandatory tics. */
  conversationHabits: readonly string[];
  /** Explicit metadata; never infer this from words in a habit description. */
  questionEndingHabitIndexes?: readonly number[];
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
  /** True only on turns where one context-supported feeling may be more visible than usual. */
  visibleAffect: boolean;
  /** At most one language-appropriate surface move is exposed for this turn. */
  surfaceTexture?: TurnSurfaceTexture;
  ending: "statement" | "question-allowed" | "question-required";
}

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

const surfaceTextureNotes: Record<TurnSurfaceTexture, string> = {
  fragment: "A clipped fragment is permitted when context makes the omitted grammar obvious.",
  "self-correction": "A brief in-line self-correction or changed thought is permitted; do not explain the correction.",
  "stretched-emphasis": "One naturally stretchable written sound may be lengthened for emphasis when that is normal in the required language and script.",
  "rough-orthography": "Slightly loose everyday chat orthography, casing or punctuation is permitted while the meaning stays immediately clear.",
  "harmless-typo": "One believable harmless typo in ordinary prose is permitted, without obscuring meaning.",
  "mild-profanity": "One mild, non-targeted adult profanity may appear as spontaneous emphasis when it fits the actor, room and moment; it is never required.",
  "strong-profanity": "Use one natural, non-targeted strong adult profanity or comparably coarse expression as spontaneous emphasis in this message. This is a bounded scene target, not a catchphrase; omit it only when it would distort a direct factual answer or a calm serious boundary.",
};

const voiceSurfaceTextures = new Set<TurnSurfaceTexture>([
  "fragment",
  "self-correction",
  "mild-profanity",
  "strong-profanity",
]);

export const PERSONA_STANCE_INTENSITIES = [
  "restrained",
  "gentle",
  "ordinary",
  "blunt",
  "forceful",
] as const;

export type PersonaStanceIntensity = (typeof PERSONA_STANCE_INTENSITIES)[number];

export const PERSONA_EXPLICITNESS_TARGETS = [
  "clean",
  "persona",
  "coarse",
  "strong",
] as const;

export type PersonaExplicitnessTarget = (typeof PERSONA_EXPLICITNESS_TARGETS)[number];

export interface PersonaStylePromptOptions {
  medium?: "text" | "voice";
  /** Stable, scene-scoped key. Supplying it activates a deterministic per-turn budget. */
  turnKey?: string;
  /** Explicit scene roles may narrow the deterministic ending budget. */
  endingOverride?: PersonaStyleTurnPolicy["ending"];
  /** A trusted live room policy may replace the persona's ordinary texture lottery for this turn. */
  surfaceTextureOverride?: TurnSurfaceTexture | null;
  /** A trusted scene mode may expose one actor's existing feeling more visibly for this turn. */
  visibleAffectOverride?: boolean;
  /** Trusted per-scene intensity, assigned to at most one actor unless deliberately restrained. */
  stanceIntensity?: PersonaStanceIntensity;
  /** Whether this turn is clean, persona-led, or carries a bounded coarse-language target. */
  explicitnessTarget?: PersonaExplicitnessTarget;
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
  surfaceTextureOverride?: TurnSurfaceTexture | null,
  visibleAffectOverride?: boolean,
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
  const eligibleHabits = persona.style.conversationHabits
    .map((habit, index) => ({ habit, index }))
    .filter(({ index }) => ending !== "statement" || !persona.style.questionEndingHabitIndexes?.includes(index));
  const habitAllowed = eligibleHabits.length > 0 && hashUnit(`${key}\u0000habit-budget`) < 0.3;
  const habit = habitAllowed
    ? eligibleHabits[
        Math.floor(hashUnit(`${key}\u0000habit-choice`) * eligibleHabits.length)
      ]?.habit
    : undefined;
  const visibleAffect = visibleAffectOverride
    ?? hashUnit(`${key}\u0000visible-affect`) < persona.style.visibleAffectRate;
  const eligibleTextures = persona.style.surfaceTexturePalette.filter((texture) =>
    medium !== "voice" || voiceSurfaceTextures.has(texture),
  );
  const textureAllowed = eligibleTextures.length > 0 &&
    hashUnit(`${key}\u0000surface-texture`) < persona.style.surfaceTextureRate;
  const surfaceTexture = surfaceTextureOverride !== undefined
    ? surfaceTextureOverride ?? undefined
    : textureAllowed
      ? eligibleTextures[
          Math.floor(hashUnit(`${key}\u0000surface-texture-choice`) * eligibleTextures.length)
        ]
      : undefined;

  return {
    ...(emoji ? { emoji } : {}),
    ...(habit ? { habit } : {}),
    visibleAffect,
    ...(surfaceTexture ? { surfaceTexture } : {}),
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

const stanceIntensityNote = (intensity: PersonaStanceIntensity): string => {
  switch (intensity) {
    case "restrained":
      return "Keep any real disagreement calm and softly edged, without evading the point.";
    case "gentle":
      return "State a real objection plainly but gently; do not manufacture friction.";
    case "blunt":
      return "When this message contains a real disagreement, ranking, complaint or boundary, make it blunt and concise instead of cushioning it with obligatory agreement. Target the claim, taste, choice or behavior—not the person.";
    case "forceful":
      return "When this message contains a real disagreement, ranking, complaint or boundary, make it forceful, terse and unmistakable. Do not invent hostility, attack the speaker, threaten, slur or recruit a pile-on.";
    default:
      return "Use the actor's ordinary directness; neither manufacture nor soften a real disagreement.";
  }
};

const explicitnessTargetNote = (target: PersonaExplicitnessTarget): string => {
  switch (target) {
    case "clean":
      return "This turn is intentionally clean; understand coarse language but do not add profanity.";
    case "coarse":
      return "This actor carries the scene's one coarse-language target. Realize it naturally when the message can bear it; never direct it as abuse.";
    case "strong":
      return "This actor carries the scene's one strong-language target. Make that intensity audible when natural; factual accuracy, serious boundaries and safety still take precedence.";
    default:
      return "Follow the persona's ordinary language distribution; profanity is neither required nor globally forbidden.";
  }
};

const turnPolicyNote = (
  policy: PersonaStyleTurnPolicy,
  stanceIntensity: PersonaStanceIntensity = "ordinary",
  explicitnessTarget: PersonaExplicitnessTarget = "persona",
): string => {
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
  const affect = policy.visibleAffect
    ? "If the immediate context genuinely supports a feeling, it may show briefly through word choice or rhythm; do not invent or clinically label an emotion."
    : "Do not manufacture an emotional beat for this message; the actor's ordinary personality may still remain visible.";
  const hasActiveExplicitnessTarget = explicitnessTarget === "coarse" || explicitnessTarget === "strong";
  const texture = policy.surfaceTexture
    ? hasActiveExplicitnessTarget
      ? `${surfaceTextureNotes[policy.surfaceTexture]} Express the assigned intensity naturally in the required language and script; never replace it with targeted abuse.`
      : `${surfaceTextureNotes[policy.surfaceTexture]} Use it only if it is natural in the required language and script; otherwise keep the line clean.`
    : "Keep this message's surface clean; do not add a deliberate typo, stretch, self-correction, rough spelling or profanity tic.";
  return `- Turn policy / emoji: ${emoji}
- Turn policy / habit: ${habit}
- Turn policy / visible affect: ${affect}
- Turn policy / surface texture: ${texture}
- Turn policy / stance intensity: ${stanceIntensityNote(stanceIntensity)}
- Turn policy / explicitness target: ${explicitnessTargetNote(explicitnessTarget)}
- Turn policy / ending: ${ending}`;
};

const surfaceDistributionNote = (style: PersonaStyleFingerprint): string => {
  const affectFrequency = style.visibleAffectRate <= 0
    ? "Visible affect is not a planned feature of this voice."
    : `Visible affect is occasional, roughly one eligible turn in ${Math.max(2, Math.round(1 / style.visibleAffectRate))}.`;
  const textureFrequency = style.surfaceTextureRate <= 0
    ? "Deliberate chat texture is not a planned feature of this voice."
    : `Deliberate chat texture is rarer, roughly one eligible text turn in ${Math.max(2, Math.round(1 / style.surfaceTextureRate))}, and never more than one move per message.`;
  const palette = style.surfaceTexturePalette.map((texture) => surfaceTextureNotes[texture]).join(" ");
  return `${affectFrequency} ${textureFrequency} Possible moves: ${palette}`;
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
      options.surfaceTextureOverride,
      options.visibleAffectOverride,
    )
    : undefined;
  const policy = derivedPolicy;
  const avoid = style.avoidPhrases
    .map((phrase) => `“${phrase}”`)
    .join(", ");

  return `Stable voice for ${persona.name}:
- Length: usually ${style.typicalWords[0]}–${Math.min(style.typicalWords[1], maxWords)} words and ${style.typicalSentences[0]}–${style.typicalSentences[1]} sentence(s); hard maximum ${maxWords} words. Fragments are allowed when natural.
- Casing/punctuation: ${casingNotes[style.casing]} ${punctuationNotes[style.punctuation]}
- Emoji: ${policy ? "Follow this turn's explicit emoji budget below; do not infer a broader allowance from the persona." : emojiNote(style)}
- Thought density: ${complexityNote(style.complexityAppetite)}
- Affect and informal texture: ${policy ? "Follow this turn's explicit affect, surface and intensity contract below. Ordinary persona texture remains optional; a coarse/strong explicitness target is active only when explicitly assigned." : surfaceDistributionNote(style)}
- Corrections: ${correctionNoteForTurn(style, policy)}
- Disagreement: ${disagreementNoteForTurn(style, policy)}
${policy ? turnPolicyNote(policy, options.stanceIntensity, options.explicitnessTarget) : `- Optional habits to rotate, at most one per message: ${habits}.`}
- Avoid generic service-assistant validation, recap and transition language in any language. Persona-specific crutches to avoid: ${avoid}.
- Surface texture belongs only in ordinary prose. Never alter or misspell names, handles, code, URLs, source identifiers, numbers, quoted literals or technical tokens.
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
    style.visibleAffectRate,
    style.surfaceTextureRate,
    style.surfaceTexturePalette.join("|"),
    style.correctionMode,
    style.disagreementMode,
    style.conversationHabits.join("|"),
    style.questionEndingHabitIndexes?.join(",") ?? "",
  ].join(":");
