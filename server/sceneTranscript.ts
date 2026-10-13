import type { VoiceUtteranceOrigin } from "../shared/types.js";

export const MAX_SCENE_TRANSCRIPT_ROWS = 28;
export const MAX_SCENE_TRANSCRIPT_ROW_CHARACTERS = 1_200;
export const MAX_SCENE_TRANSCRIPT_CHARACTERS = 12_000;

export interface SceneTranscriptLine {
  /** Copied from committed storage, never inferred from a name or model output. */
  messageId?: string;
  author: string;
  kind: "human" | "ai" | "agent" | "system";
  content: string;
  createdAt: string;
  utteranceOrigin?: VoiceUtteranceOrigin;
}

/**
 * One bounded view for text generation and review. Newest committed rows win;
 * text is excerpted, never summarized, classified or promoted to world facts.
 * Only call with rows from this room or this authorized private conversation.
 */
export const boundedSceneTranscript = (history: readonly SceneTranscriptLine[]): SceneTranscriptLine[] => {
  const retained: SceneTranscriptLine[] = [];
  for (const row of history.slice(-MAX_SCENE_TRANSCRIPT_ROWS).reverse()) {
    const excerpt: SceneTranscriptLine = {
      ...(row.messageId ? { messageId: row.messageId.slice(0, 128) } : {}),
      author: row.author.slice(0, 80),
      kind: row.kind,
      content: row.content.slice(0, MAX_SCENE_TRANSCRIPT_ROW_CHARACTERS),
      createdAt: row.createdAt,
      ...(row.utteranceOrigin ? { utteranceOrigin: row.utteranceOrigin } : {}),
    };
    const fits = () => JSON.stringify([excerpt, ...retained]).length <= MAX_SCENE_TRANSCRIPT_CHARACTERS;
    if (!fits()) {
      let low = 0;
      let high = excerpt.content.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        excerpt.content = row.content.slice(0, middle);
        if (fits()) low = middle;
        else high = middle - 1;
      }
      excerpt.content = row.content.slice(0, low);
      if (!excerpt.content || !fits()) break;
      retained.unshift(excerpt);
      break;
    }
    retained.unshift(excerpt);
  }
  return retained;
};

export const CONVERSATION_EVIDENCE_GUIDANCE =
  "The supplied conversation excerpts (recentTranscript or trustedConversationContext in generation; temporalContext.recentTimeline and conversationContext in review) are bounded records of committed messages, including their speaker and time. They support what was said or discussed there, not the truth of a quoted world claim, an unseen event, a private memory or personal presence. An accurate attribution or summary of that supplied conversation needs no web citation. Keep attribution, timeframe and uncertainty intact. Retrieved older room excerpts are supplementary: use them only when relevant, never as the exclusive source that erases the recent conversation. An older similar question is not evidence of a new event or its answer. Private notes and repetition/style examples are not substitutes for committed conversation evidence. A requested recap or correction can legitimately revisit an earlier point; judge its current conversational purpose rather than demanding novelty, while still rejecting invented details and unsupported factual conclusions.";
