/**
 * Server-authored considered or explicitly detailed turns may be longer than a human composer turn,
 * but every persistence and review boundary must agree on the same ceiling.
 */
export const MAX_PERSISTED_CHAT_MESSAGE_CHARACTERS = 1_600;
