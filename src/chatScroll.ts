export type ConversationViewport = {
  messageId: string;
  offsetTop: number;
  atBottom: boolean;
};

export type PendingConversationEntry =
  | { channelId: string; kind: "bottom" }
  | { channelId: string; kind: "message"; messageId: string; offsetTop: number };

export const conversationEntryTarget = (
  channelId: string,
  firstUnreadMessageId: string | undefined,
  savedViewport: ConversationViewport | undefined,
): PendingConversationEntry => {
  if (firstUnreadMessageId) {
    return { channelId, kind: "message", messageId: firstUnreadMessageId, offsetTop: 28 };
  }
  if (savedViewport && !savedViewport.atBottom) {
    return {
      channelId,
      kind: "message",
      messageId: savedViewport.messageId,
      offsetTop: savedViewport.offsetTop,
    };
  }
  return { channelId, kind: "bottom" };
};
