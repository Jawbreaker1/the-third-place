import type { ChannelFeedCard } from "../shared/types.js";
import {
  channelFeedConversationCue,
  type ChannelFeedConversationCue,
} from "./channelFeedConversation.js";
import {
  residentChannelFeedFact,
  type ResidentChannelFeedFact,
} from "./channelFeedFacts.js";

export interface ChannelFeedDiscussionControl {
  id: string;
  discussionFrequency: number;
}

export interface ProjectedChannelFeedFact extends ResidentChannelFeedFact {
  conversationCue?: ChannelFeedConversationCue;
  discussionFrequency: number;
}

/**
 * Projects every visible typed feed in one room. Cards remain independent:
 * each cue carries its own revision and admin frequency, while the director
 * owns bounded aggregation and room-level admission policy.
 */
export const projectChannelFeedFactsForRoom = (
  cards: readonly ChannelFeedCard[],
  controls: readonly ChannelFeedDiscussionControl[],
  channelId: string,
): ProjectedChannelFeedFact[] => {
  const controlsById = new Map(controls.map((control) => [control.id, control]));
  return cards
    .filter((card) => card.channelId === channelId)
    .sort((left, right) => left.id.localeCompare(right.id))
    .flatMap((card) => {
      const fact = residentChannelFeedFact(card);
      if (!fact) return [];
      const rawFrequency = controlsById.get(card.id)?.discussionFrequency;
      const discussionFrequency = typeof rawFrequency === "number" && Number.isFinite(rawFrequency)
        ? Math.max(0, Math.min(100, rawFrequency))
        : 0;
      const conversationCue = channelFeedConversationCue(card);
      return [{
        ...fact,
        ...(conversationCue ? { conversationCue } : {}),
        discussionFrequency,
      }];
    });
};
