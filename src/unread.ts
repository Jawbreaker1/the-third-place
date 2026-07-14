import type { ChatMessage, DmThread, Member } from "../shared/types";
import { containsExactMention } from "../shared/unicodeBoundaries";

export type ChannelNotice = { unread: boolean; mentions: number; firstUnreadMessageId?: string };
export type ChannelNotices = Record<string, ChannelNotice | undefined>;

export const messageAddressesMember = (message: ChatMessage, member: Member): boolean => {
  if (message.authorId === member.id || message.system) return false;
  if (message.replyPreview?.authorId === member.id) return true;

  return containsExactMention(message.content, member.name);
};

export const noteChannelMessage = (
  current: ChannelNotices,
  message: ChatMessage,
  activeChannelId: string,
  member: Member | null,
  activeChannelIsRead = true,
): ChannelNotices => {
  if (
    message.authorId === member?.id ||
    (message.channelId === activeChannelId && activeChannelIsRead)
  ) return current;
  const previous = current[message.channelId] ?? { unread: false, mentions: 0 };
  return {
    ...current,
    [message.channelId]: {
      unread: true,
      firstUnreadMessageId: previous.firstUnreadMessageId ?? message.id,
      mentions: member && messageAddressesMember(message, member)
        ? Math.min(99, previous.mentions + 1)
        : previous.mentions,
    },
  };
};

export const clearChannelNotice = (current: ChannelNotices, channelId: string): ChannelNotices => {
  if (!current[channelId]?.unread && !current[channelId]?.mentions) return current;
  return { ...current, [channelId]: { unread: false, mentions: 0 } };
};

export const firstUnreadDmMessageId = (thread: DmThread | undefined): string | undefined => {
  if (!thread || thread.unread < 1 || thread.messages.length === 0) return undefined;
  const unreadCount = Math.min(thread.unread, thread.messages.length);
  return thread.messages.at(-unreadCount)?.id;
};

export const nextDmUnread = (
  previous: number,
  message: ChatMessage | undefined,
  threadId: string,
  activeChannelId: string,
  memberId: string | undefined,
  activeThreadIsRead = true,
): number => {
  if (threadId === activeChannelId && activeThreadIsRead) return 0;
  if (!message || message.authorId === memberId) return previous;
  return Math.min(99, previous + 1);
};
