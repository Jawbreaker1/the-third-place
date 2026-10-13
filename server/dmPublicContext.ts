import type { ChatMessage } from "../shared/types.js";
import { recallChannelHistory, type ChannelRecallResult } from "./channelRecall.js";

/** Exact public evidence, never an inference that a resident knows the whole server. */
export const recallWitnessedPublicConversation = (input: {
  messages: readonly ChatMessage[];
  channels: readonly { id: string; name: string }[];
  ownerId: string;
  subjects: readonly { id: string; displayLabel: string }[];
  trigger: { id: string; createdAt: string };
}): { sourceChannel: { id: string; name: string }; recall: ChannelRecallResult } | undefined => {
  const subjects = input.subjects.slice(0, 2);
  if (!subjects.length) return undefined;
  const triggerTime = Date.parse(input.trigger.createdAt);
  if (!Number.isFinite(triggerTime)) return undefined;
  const publicChannels = new Map(input.channels.map((channel) => [channel.id, { id: channel.id, name: channel.name }]));
  const messages = input.messages.filter((message) =>
    !message.system && publicChannels.has(message.channelId) &&
    // The DM trigger has no shared channel ordering with these rows. Do not
    // infer the order of same-timestamp messages from unrelated IDs.
    Date.parse(message.createdAt) < triggerTime
  );
  const subjectIds = new Set(subjects.map((subject) => subject.id));
  const candidateChannels = new Set(messages.filter((message) =>
    subjectIds.has(message.authorId)
  ).map((message) => message.channelId));
  const candidates = [...candidateChannels].flatMap((channelId) => {
    const recall = recallChannelHistory({
      messages,
      // Identity is semantically resolved upstream. The query is only a
      // retrieval label; anchors must have the exact supplied author IDs.
      query: subjects.map((subject) => subject.displayLabel).join(" "),
      participantSubjects: subjects,
      trigger: { ...input.trigger, channelId },
      recentMessageIds: [],
      allowedPersonaIds: [input.ownerId],
      maxMessages: 8,
      selectionPolicy: "latest_witnessed",
    });
    if (!recall?.witnessPersonaIds.includes(input.ownerId)) return [];
    return [{ sourceChannel: publicChannels.get(channelId)!, recall }];
  });
  // Prefer the latest actual encounter, not a larger or more verbose room.
  // This does not invent a relationship or resolve the question's meaning.
  return candidates.sort((left, right) => {
    const latestAnchor = (recall: ChannelRecallResult) => Math.max(...recall.messages
      .filter((message) => recall.anchorMessageIds.includes(message.id))
      .map((message) => Date.parse(message.createdAt)));
    return latestAnchor(right.recall) - latestAnchor(left.recall) ||
      left.sourceChannel.id.localeCompare(right.sourceChannel.id);
  })[0];
};
