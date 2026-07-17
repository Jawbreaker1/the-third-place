/**
 * Curated public reaction catalog shared by the browser and the socket
 * boundary. Keeping this finite gives people a useful picker without turning
 * reaction payloads into an arbitrary-text channel.
 */
export const PUBLIC_REACTION_EMOJIS = [
  "👍", "👎", "❤️", "💛", "😂", "😭", "💀", "👀",
  "🤔", "😮", "😬", "😅", "🥳", "🤯", "😡", "🔥",
  "✨", "🙌", "👏", "🫡", "🤝", "💡", "🚀", "✅",
  "❌", "⚽", "🍿", "🎉", "🥂", "🍻", "🌿", "🧠",
  "🎵", "🎬", "🐐", "🧂", "🤡", "🙄", "🫠", "🥹",
  "😍", "🤨", "🛠️", "📉", "⚡", "⚔️", "🤫", "🛑", "🙃",
  "🛡️", "⚠️", "🧪", "🔍",
] as const;

export type PublicReactionEmoji = (typeof PUBLIC_REACTION_EMOJIS)[number];

/** Short locale-neutral fallback labels; clients may localize these later. */
export const PUBLIC_REACTION_LABELS: Record<PublicReactionEmoji, string> = {
  "👍": "Thumbs up", "👎": "Thumbs down", "❤️": "Love", "💛": "Yellow heart",
  "😂": "Laughing", "😭": "Crying", "💀": "Dead", "👀": "Eyes",
  "🤔": "Thinking", "😮": "Surprised", "😬": "Grimacing", "😅": "Nervous laugh",
  "🥳": "Celebrating", "🤯": "Mind blown", "😡": "Angry", "🔥": "Fire",
  "✨": "Sparkles", "🙌": "Hands raised", "👏": "Applause", "🫡": "Salute",
  "🤝": "Handshake", "💡": "Idea", "🚀": "Rocket", "✅": "Approved",
  "❌": "No", "⚽": "Football", "🍿": "Popcorn", "🎉": "Party",
  "🥂": "Cheers", "🍻": "Beers", "🌿": "Leaf", "🧠": "Brain",
  "🎵": "Music", "🎬": "Film", "🐐": "Greatest of all time", "🧂": "Salty",
  "🤡": "Clown", "🙄": "Eye roll", "🫠": "Melting", "🥹": "Holding back tears",
  "😍": "Heart eyes", "🤨": "Raised eyebrow", "🛠️": "Tools", "📉": "Chart falling",
  "⚡": "Lightning", "⚔️": "Crossed swords", "🤫": "Quiet", "🛑": "Stop",
  "🙃": "Upside-down face", "🛡️": "Shield", "⚠️": "Warning",
  "🧪": "Lab", "🔍": "Search",
};

const PUBLIC_REACTION_SET: ReadonlySet<string> = new Set(PUBLIC_REACTION_EMOJIS);

export const isPublicReactionEmoji = (value: string): value is PublicReactionEmoji =>
  PUBLIC_REACTION_SET.has(value);
