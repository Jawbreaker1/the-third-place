export const AMBIENT_ACTION_KINDS = [
  "open_topic",
  "advance_claim",
  "specific_example",
  "countertake",
  "hidden_cost",
  "pointed_question",
  "practical_consequence",
  "playful_tangent",
  "source_followup",
] as const;

export type AmbientActionKind = (typeof AMBIENT_ACTION_KINDS)[number];
export type AmbientEpisodeOrigin = "room_seed" | "human_topic" | "autonomous_research";
export type AmbientConversationMode = "discussion" | "casual" | "banter";

export interface AmbientEpisodeShape {
  minimumMessages: number;
  softTargetMessages: number;
  hardMaximumMessages: number;
}

export interface AmbientActionContract {
  episodeId: string;
  causalRootId: string;
  semanticFamily: string;
  kind: AmbientActionKind;
  turnIndex: number;
  targetMessageId?: string;
  openHook: boolean;
  previousActions: AmbientActionKind[];
}

export interface AmbientActionDecision {
  kind: AmbientActionKind;
  continueEpisode: boolean;
  replyToLatest: boolean;
  keepsHookOpen: boolean;
}

const clampUnit = (value: number): number => Math.max(0, Math.min(0.999_999, value));

const weightedChoice = <T>(
  entries: readonly { value: T; weight: number }[],
  rng: () => number,
): T => {
  const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
  if (total <= 0) return entries[0]!.value;
  let roll = clampUnit(rng()) * total;
  for (const entry of entries) {
    roll -= Math.max(0, entry.weight);
    if (roll < 0) return entry.value;
  }
  return entries.at(-1)!.value;
};

/**
 * Samples a bounded episode shape once, when the episode opens. The target is
 * deliberately varied rather than inferred from message wording. A soft
 * target may still end early/late at later scheduler ticks, while the hard cap
 * remains an invariant against room monopolies.
 */
export function sampleAmbientEpisodeShape(input: {
  origin: AmbientEpisodeOrigin;
  mode: AmbientConversationMode;
  debateBeat: boolean;
  alreadyPublished?: number;
  rng: () => number;
}): AmbientEpisodeShape {
  const alreadyPublished = Math.max(0, Math.min(8, Math.floor(input.alreadyPublished ?? 0)));
  const ordinary = input.mode === "banter"
    ? [
        { value: 1, weight: 18 },
        { value: 2, weight: 27 },
        { value: 3, weight: 25 },
        { value: 4, weight: 17 },
        { value: 5, weight: 9 },
        { value: 6, weight: 4 },
      ]
    : input.mode === "casual"
      ? [
          { value: 1, weight: 13 },
          { value: 2, weight: 23 },
          { value: 3, weight: 26 },
          { value: 4, weight: 20 },
          { value: 5, weight: 12 },
          { value: 6, weight: 5 },
          { value: 7, weight: 1 },
        ]
      : [
          { value: 1, weight: 8 },
          { value: 2, weight: 17 },
          { value: 3, weight: 24 },
          { value: 4, weight: 23 },
          { value: 5, weight: 16 },
          { value: 6, weight: 8 },
          { value: 7, weight: 4 },
        ];
  const sampled = weightedChoice(ordinary, input.rng);
  const originMinimum = input.origin === "autonomous_research"
    ? 3
    : input.origin === "human_topic"
      ? alreadyPublished + 1
      : input.debateBeat
        ? 2
        : 1;
  const minimumMessages = Math.min(7, Math.max(1, alreadyPublished, originMinimum));
  const debateExtension = input.debateBeat && sampled < 3 ? 1 : 0;
  const researchExtension = input.origin === "autonomous_research" && sampled < 4 ? 1 : 0;
  const softTargetMessages = Math.min(
    7,
    Math.max(minimumMessages, sampled + debateExtension + researchExtension),
  );
  return {
    minimumMessages,
    softTargetMessages,
    hardMaximumMessages: Math.min(8, Math.max(softTargetMessages + 1, minimumMessages + 1)),
  };
}

const continuationChance = (input: {
  messageCount: number;
  shape: AmbientEpisodeShape;
  origin: AmbientEpisodeOrigin;
  debateBeat: boolean;
  hasOpenHook: boolean;
}): number => {
  if (input.messageCount < input.shape.minimumMessages) return 1;
  if (input.messageCount < input.shape.softTargetMessages) return 0.94;
  const distance = input.messageCount - input.shape.softTargetMessages;
  const base = input.hasOpenHook
    ? 0.48
    : input.origin === "autonomous_research"
      ? 0.36
      : input.debateBeat
        ? 0.3
        : 0.14;
  return Math.max(0.04, base - distance * 0.2);
};

const actionPool = (input: {
  mode: AmbientConversationMode;
  debateBeat: boolean;
  hasResearch: boolean;
  previousActions: readonly AmbientActionKind[];
}): AmbientActionKind[] => {
  const used = new Set(input.previousActions);
  const latest = input.previousActions.at(-1);
  const preferred: AmbientActionKind[] = [];
  if (input.hasResearch && !used.has("source_followup")) preferred.push("source_followup");
  if (input.debateBeat && !used.has("countertake")) preferred.push("countertake");
  if (input.mode === "banter") {
    preferred.push("specific_example", "playful_tangent", "pointed_question", "countertake", "advance_claim");
  } else if (input.mode === "casual") {
    preferred.push("specific_example", "pointed_question", "countertake", "practical_consequence", "advance_claim");
  } else {
    preferred.push("hidden_cost", "specific_example", "practical_consequence", "pointed_question", "countertake", "advance_claim");
  }
  const withoutImmediateRepeat = preferred.filter((kind, index) => kind !== latest && preferred.indexOf(kind) === index);
  const unused = withoutImmediateRepeat.filter((kind) => !used.has(kind));
  return unused.length > 0 ? unused : withoutImmediateRepeat;
};

/**
 * Chooses one conversational move for one scheduler tick. It never examines
 * user language. Meaning remains model-owned; the director only supplies a
 * trusted structural role and may elect silence by closing the episode.
 */
export function decideAmbientAction(input: {
  messageCount: number;
  shape: AmbientEpisodeShape;
  origin: AmbientEpisodeOrigin;
  mode: AmbientConversationMode;
  debateBeat: boolean;
  hasResearch: boolean;
  hasOpenHook: boolean;
  previousActions: readonly AmbientActionKind[];
  rng: () => number;
}): AmbientActionDecision {
  const messageCount = Math.max(0, Math.floor(input.messageCount));
  if (messageCount === 0) {
    return {
      kind: "open_topic",
      continueEpisode: true,
      replyToLatest: false,
      keepsHookOpen: input.shape.minimumMessages > 1 || input.hasOpenHook,
    };
  }
  if (messageCount >= input.shape.hardMaximumMessages) {
    return {
      kind: input.previousActions.at(-1) ?? "advance_claim",
      continueEpisode: false,
      replyToLatest: false,
      keepsHookOpen: false,
    };
  }
  if (clampUnit(input.rng()) >= continuationChance({ ...input, messageCount })) {
    return {
      kind: input.previousActions.at(-1) ?? "advance_claim",
      continueEpisode: false,
      replyToLatest: false,
      keepsHookOpen: false,
    };
  }
  const pool = actionPool(input);
  const kind = pool[Math.floor(clampUnit(input.rng()) * pool.length)] ?? "advance_claim";
  return {
    kind,
    continueEpisode: true,
    replyToLatest: true,
    keepsHookOpen: messageCount + 1 < input.shape.softTargetMessages || input.hasOpenHook,
  };
}

export function ambientActionInstruction(
  action: AmbientActionKind,
  mode: AmbientConversationMode,
): string {
  const common = "Make exactly one conversational move and leave the result chat-shaped; do not summarize the whole thread or invite the room to perform.";
  const instruction: Record<AmbientActionKind, string> = {
    open_topic: "Open with one concrete claim, preference, problem, recommendation or joke-shaped hook that another person could answer specifically.",
    advance_claim: "Advance the live subject with one new concrete reason or distinction; never restate the setup.",
    specific_example: "Add one recognizable example or specific case that changes how the preceding point lands.",
    countertake: "Give one genuinely incompatible countertake aimed at the claim or taste, not the person; do not soften it into agreement.",
    hidden_cost: "Name one concrete hidden cost, failure mode or trade-off the latest line missed.",
    pointed_question: "Ask one pointed, answerable question about the latest concrete claim; no broad room invitation.",
    practical_consequence: "Push the latest point into one practical consequence or decision someone could dispute.",
    playful_tangent: "Follow one recognizable association into a short playful tangent while keeping an obvious link back to the live subject.",
    source_followup: "Use the supplied source to add one supported consequence, disagreement or precise unresolved question; never merely announce that the source exists.",
  };
  const register = mode === "banter"
    ? "Fragments, dry timing and blunt taste are welcome; do not explain the joke."
    : mode === "casual"
      ? "Use ordinary wording and one thought at a time, not panel-discussion language."
      : "Specific reasoning is welcome, but keep it peer chat rather than an essay.";
  return `${instruction[action]} ${common} ${register}`;
}
