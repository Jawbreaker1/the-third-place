import type { ChatMessage, Member } from "../shared/types";

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export type ChannelNotice = { unread: boolean; mentions: number };
export type ChannelNotices = Record<string, ChannelNotice | undefined>;

export const messageAddressesMember = (message: ChatMessage, member: Member): boolean => {
  if (message.authorId === member.id || message.system) return false;
  if (message.replyPreview?.authorId === member.id) return true;

  const name = member.name.trim().normalize("NFKC");
  if (!name || !message.content) return false;
  const mention = new RegExp(
    `(^|[^\\p{L}\\p{N}._%+\\-])@${escapeRegExp(name)}(?=$|[^\\p{L}\\p{N}_])`,
    "iu",
  );
  const contentWithoutLinks = message.content
    .normalize("NFKC")
    .replace(/(?:https?:\/\/|www\.)[^\s<>"']+/giu, " ");
  return mention.test(contentWithoutLinks);
};

export const noteChannelMessage = (
  current: ChannelNotices,
  message: ChatMessage,
  activeChannelId: string,
  member: Member | null,
): ChannelNotices => {
  if (message.channelId === activeChannelId || message.authorId === member?.id) return current;
  const previous = current[message.channelId] ?? { unread: false, mentions: 0 };
  return {
    ...current,
    [message.channelId]: {
      unread: true,
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

export const nextDmUnread = (
  previous: number,
  message: ChatMessage | undefined,
  threadId: string,
  activeChannelId: string,
  memberId: string | undefined,
): number => {
  if (threadId === activeChannelId) return 0;
  if (!message || message.authorId === memberId) return previous;
  return Math.min(99, previous + 1);
};
