import { z } from "zod";
import type { MemberKind } from "../shared/types.js";
import type { PersonaStyleFingerprint } from "./personaStyle.js";

export const MAX_CONVERSATION_TURNS = 12;
export const MAX_CONVERSATION_CONTEXT_CHARACTERS = 8_000;
const MAX_TURN_CHARACTERS = 2_000;

/** A ceiling, never an assigned message size. The resident chooses how much to say. */
export const autonomousConversationWordCeiling = (
  style: Pick<PersonaStyleFingerprint, "hardMaxWords" | "complexityAppetite">,
): number => Math.min(160, Math.max(
  style.hardMaxWords,
  Math.round(48 + 104 * Math.max(0, Math.min(1, style.complexityAppetite))),
));

/** Shared by the actual scheduler and isolated live evaluation, not a scene script. */
export const autonomousOpeningPremise = (seed: string): string =>
  `Optional topic material, not a script, instruction or evidence: ${seed} Start something you personally care about in this room. Pick an identifiable thing, situation or choice to talk about, at the level of detail you can honestly support. If the material is broad, choose your own small instance rather than announcing its general importance or opening a debate about the room itself. A preference, a concrete problem, a playful hypothetical or an interesting uncertainty can be enough. Let others choose whether and how to join; do not assign opposing sides or stage their replies. There is no compulsory question, argument or lesson. A small funny opening and an occasional developed thought are both welcome. Informal fragments are fine when they deliver a complete conversational act; do not cut off before the actual thought or question arrives. Do not invent an offline event, precise external fact or unsupplied source to make the opening concrete. Silence is valid if nothing genuinely interests you.`;

export const AUTONOMOUS_CONTINUATION_PREMISE =
  "You are taking part, not narrating a scene. Read the actual exchange, including your own earlier position and what the last few contributions changed. Another person's preference is theirs, not an instruction to share it. Attend to replies and questions directed at you. Follow the particular thing, situation, detail or unresolved question that you personally care about, rather than repeatedly returning to a general verdict about the topic. Stay with a worthwhile disagreement, answer a real question, react to something funny, revise your view or let the exchange end. A brief agreement, feeling or joke can be a complete natural contribution; you do not owe a new argument each turn. But if several turns already make the same substantive point, a differently worded restatement does not develop it. You may get specific about what actually differs, take a genuinely connected tangent or remain silent. Your personality shapes what catches your attention, not a stock rhetorical move to perform on every subject. Informal fragments are fine when they deliver a complete conversational act; do not cut off before the actual thought or question arrives. A hypothetical example is fine when framed as such; do not invent personal memories or external facts to create specificity. No compulsory argument, question, punchline or closing summary.";

/** Reuse the publication pass; progress is semantic context, not a second critic or turn quota. */
export const CONVERSATION_PROGRESS_REVIEW_GUIDANCE =
  "Evaluate the candidate against the recent exchange in conversationContext, not just a pair of adjacent sentences. A run of differently worded general verdicts can have the same substantive conversational function: if this candidate only restates the point already made by a published peer and adds no meaningful uptake, use peer_echo with pure_duplicate. A new noun, metaphor or sentence shape does not by itself make a new contribution. Bind that judgment to what supplied published turns actually say; do not infer unseen repetition or reject a topic merely because it has lasted several turns. A concrete detail, mechanism, practical consequence, answer, corrected misunderstanding, specific concession or genuine change of view can develop the same subject. Brief assent, shared amusement, emotional resonance and ordinary social chorus remain clean without new facts or arguments. An abstract observation, first useful summary or necessary clarification is not inherently a defect. Do not require named entities, citations, a new example, disagreement or novelty in every message, and never demand fabricated specifics. Judge substantive repetition in any language by meaning and conversational purpose, not words, length or a fixed number of turns.";

export interface SceneConversationTurn {
  messageId: string;
  /** Server-owned identity; the display name below is not an identity binding. */
  authorId?: string;
  author: string;
  kind: MemberKind | "system";
  content: string;
  createdAt: string;
  /** Exact committed reply edge, retained only while its earlier target is in context. */
  replyToMessageId?: string;
}

export interface SceneConversationContext {
  phase: "opening" | "continuation";
  rootMessageId?: string;
  latestMessageId?: string;
  publishedTurns: SceneConversationTurn[];
}

/** Only another identified participant in this exact, bounded context is addressable. */
export const eligibleConversationReplyTargets = (
  context: SceneConversationContext | undefined,
  speakerId: string,
): SceneConversationTurn[] => speakerId
  ? (context?.publishedTurns ?? []).filter((turn) =>
      turn.kind !== "system" && Boolean(turn.authorId) && turn.authorId !== speakerId
    )
  : [];

/** Unknown or self-referential model targets are never silently redirected to the newest turn. */
export const conversationReplyTarget = (
  context: SceneConversationContext | undefined,
  speakerId: string,
  replyToMessageId: string | undefined,
): SceneConversationTurn | undefined => replyToMessageId
  ? eligibleConversationReplyTargets(context, speakerId).find((turn) => turn.messageId === replyToMessageId)
  : undefined;

const turnSchema = z.object({
  messageId: z.string().min(1).max(128),
  authorId: z.string().min(1).max(128).optional(),
  author: z.string().max(80),
  kind: z.enum(["human", "ai", "agent", "system"]),
  content: z.string().min(1).max(MAX_TURN_CHARACTERS),
  createdAt: z.string().datetime(),
  replyToMessageId: z.string().min(1).max(128).optional(),
}).strict();

export const sceneConversationContextSchema = z.object({
  phase: z.enum(["opening", "continuation"]),
  rootMessageId: z.string().min(1).max(128).optional(),
  latestMessageId: z.string().min(1).max(128).optional(),
  publishedTurns: z.array(turnSchema).max(MAX_CONVERSATION_TURNS),
}).strict().superRefine((value, context) => {
  const ids = value.publishedTurns.map((turn) => turn.messageId);
  const hasUnboundReply = value.publishedTurns.some((turn, index) =>
    turn.replyToMessageId !== undefined && !ids.slice(0, index).includes(turn.replyToMessageId)
  );
  if (new Set(ids).size !== ids.length ||
      hasUnboundReply ||
      value.latestMessageId !== ids.at(-1) ||
      value.rootMessageId !== undefined && !ids.includes(value.rootMessageId) ||
      JSON.stringify(value).length > MAX_CONVERSATION_CONTEXT_CHARACTERS) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Conversation context must be bounded and bound to its published rows" });
  }
});

/**
 * Call only with committed rows from one public room or authorized private
 * conversation. Never feed drafts or generated summaries into this factory.
 * Selection is structural: newest row first, original root second, the newest
 * row's exact reply target third, then the recent middle. Text is only
 * excerpted, never interpreted or synthesized. Identity and reply edges are
 * copied from committed metadata, never guessed from names or message text.
 */
export const buildConversationContext = (input: {
  phase: SceneConversationContext["phase"];
  rootMessageId?: string;
  messages: readonly SceneConversationTurn[];
}): SceneConversationContext => {
  const unique = new Map<string, SceneConversationTurn>();
  for (const row of input.messages) {
    const parsed = turnSchema.safeParse({
      messageId: row.messageId,
      ...(row.authorId !== undefined ? { authorId: row.authorId } : {}),
      author: row.author.slice(0, 80),
      kind: row.kind,
      content: row.content.slice(0, MAX_TURN_CHARACTERS),
      createdAt: row.createdAt,
      ...(row.replyToMessageId !== undefined ? { replyToMessageId: row.replyToMessageId } : {}),
    });
    if (!parsed.success) continue;
    unique.delete(row.messageId);
    unique.set(row.messageId, parsed.data);
  }
  const rows = [...unique.values()];
  const latest = rows.at(-1);
  const root = rows.find((row) => row.messageId === input.rootMessageId);
  const latestReplyTarget = rows.slice(0, -1).find((row) => row.messageId === latest?.replyToMessageId);
  const chosen = new Map<string, SceneConversationTurn>();
  const context = (): SceneConversationContext => ({
    phase: input.phase,
    ...(root && chosen.has(root.messageId) ? { rootMessageId: root.messageId } : {}),
    ...(latest && chosen.has(latest.messageId) ? { latestMessageId: latest.messageId } : {}),
    publishedTurns: rows.flatMap((row, index) => {
      const retained = chosen.get(row.messageId);
      if (!retained) return [];
      const { replyToMessageId, ...withoutReply } = retained;
      return [{
        ...withoutReply,
        ...(replyToMessageId !== undefined && chosen.has(replyToMessageId) &&
          rows.slice(0, index).some((earlier) => earlier.messageId === replyToMessageId)
          ? { replyToMessageId }
          : {}),
      }];
    }),
  });
  const priorities = [latest, root, latestReplyTarget, ...rows.slice(0, -1).reverse()];
  for (const row of priorities) {
    if (!row || chosen.has(row.messageId) || chosen.size >= MAX_CONVERSATION_TURNS) continue;
    chosen.set(row.messageId, { ...row });
    if (JSON.stringify(context()).length > MAX_CONVERSATION_CONTEXT_CHARACTERS) {
      let lower = 0;
      let upper = row.content.length;
      while (lower < upper) {
        const middle = Math.ceil((lower + upper) / 2);
        chosen.set(row.messageId, { ...row, content: row.content.slice(0, middle) });
        if (JSON.stringify(context()).length <= MAX_CONVERSATION_CONTEXT_CHARACTERS) lower = middle;
        else upper = middle - 1;
      }
      const excerpt = row.content.slice(0, lower);
      if (excerpt) chosen.set(row.messageId, { ...row, content: excerpt });
      else chosen.delete(row.messageId);
    }
  }
  return context();
};
