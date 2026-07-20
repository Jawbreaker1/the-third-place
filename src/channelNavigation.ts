import { activePublicChannelId } from "../shared/channelLifecycle";

/** Keeps a browser on a valid conversation when the server catalog changes. */
export const resolveSnapshotConversationId = (
  currentId: string,
  channelIds: readonly string[],
  dmThreadIds: readonly string[],
): string | undefined => {
  if (channelIds.includes(currentId) || dmThreadIds.includes(currentId)) return currentId;
  const replacementId = activePublicChannelId(currentId);
  if (replacementId && channelIds.includes(replacementId)) return replacementId;
  return channelIds.includes("lobby")
    ? "lobby"
    : channelIds[0] ?? dmThreadIds[0];
};
