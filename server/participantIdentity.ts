import { unicodeCaselessKey } from "../shared/unicodeSafety.js";

/** Shared mention/reservation/moderation identity: case-folded and separator-insensitive. */
export const participantIdentityKey = (name: string): string =>
  unicodeCaselessKey(name).replace(/[\s._-]/gu, "");
