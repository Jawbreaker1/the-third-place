import {
  PUBLIC_REACTION_EMOJIS,
  PUBLIC_REACTION_LABELS,
  type PublicReactionEmoji,
} from "../shared/reactions";

export const filterPublicReactionEmojis = (query: string): readonly PublicReactionEmoji[] => {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return PUBLIC_REACTION_EMOJIS;
  return PUBLIC_REACTION_EMOJIS.filter((emoji) =>
    `${emoji} ${PUBLIC_REACTION_LABELS[emoji]}`.toLocaleLowerCase().includes(needle),
  );
};

export const insertEmojiAtSelection = (
  value: string,
  emoji: string,
  selectionStart: number,
  selectionEnd: number,
  maxLength: number,
): { value: string; caret: number } | undefined => {
  const start = Math.max(0, Math.min(value.length, selectionStart));
  const end = Math.max(start, Math.min(value.length, selectionEnd));
  const next = `${value.slice(0, start)}${emoji}${value.slice(end)}`;
  if (next.length > maxLength) return undefined;
  return { value: next, caret: start + emoji.length };
};
