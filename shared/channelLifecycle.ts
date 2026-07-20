/**
 * Declarative lifecycle rules for built-in public rooms.
 *
 * Keep channel renames and retirements here instead of scattering one-off
 * string checks through persistence, the server and the browser. Unknown IDs
 * are deliberately preserved because administrators may create custom rooms.
 */
export const PUBLIC_CHANNEL_REPLACEMENTS: Readonly<Record<string, string>> = Object.freeze({
  "ai-lab": "ai-programming",
});

export const RETIRED_PUBLIC_CHANNEL_IDS: ReadonlySet<string> = new Set([
  "side-quests",
]);

/** Returns the canonical successor, or the original ID when it was never renamed. */
export const replacementPublicChannelId = (channelId: string): string => {
  let current = channelId;
  const visited = new Set<string>();
  while (PUBLIC_CHANNEL_REPLACEMENTS[current] && !visited.has(current)) {
    visited.add(current);
    current = PUBLIC_CHANNEL_REPLACEMENTS[current]!;
  }
  return current;
};

/**
 * Resolves an old public-room ID for live navigation. Retired rooms have no
 * destination; renamed rooms return their surviving successor.
 */
export const activePublicChannelId = (channelId: string): string | undefined => {
  if (RETIRED_PUBLIC_CHANNEL_IDS.has(channelId)) return undefined;
  const replacement = replacementPublicChannelId(channelId);
  return RETIRED_PUBLIC_CHANNEL_IDS.has(replacement) ? undefined : replacement;
};
