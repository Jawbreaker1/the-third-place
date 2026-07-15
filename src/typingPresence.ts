import type { TypingMemberPayload } from "../shared/types";

export type TypingPresenceState = Record<string, string[]>;

export const TYPING_PRESENCE_TTL_MS = 16_000;

export function reduceTypingPresence(
  current: TypingPresenceState,
  payload: TypingMemberPayload,
): TypingPresenceState {
  const existing = current[payload.channelId] ?? [];
  const containsMember = existing.includes(payload.memberId);
  if (payload.active === containsMember) return current;

  if (payload.active) {
    return { ...current, [payload.channelId]: [...existing, payload.memberId] };
  }

  const remaining = existing.filter((memberId) => memberId !== payload.memberId);
  if (remaining.length > 0) return { ...current, [payload.channelId]: remaining };

  const next = { ...current };
  delete next[payload.channelId];
  return next;
}

export type TypingPresenceTimerHandle = ReturnType<typeof globalThis.setTimeout>;

export interface TypingPresenceTimerApi {
  schedule(callback: () => void, delayMs: number): TypingPresenceTimerHandle;
  cancel(handle: TypingPresenceTimerHandle): void;
}

const browserTimers: TypingPresenceTimerApi = {
  schedule: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  cancel: (handle) => globalThis.clearTimeout(handle),
};

function presenceKey(payload: Pick<TypingMemberPayload, "channelId" | "memberId">): string {
  return JSON.stringify([payload.channelId, payload.memberId]);
}

/**
 * Gives every remote typing event a local upper bound. Socket snapshots do not
 * contain transient typing state, so a missed stop event must never leave a
 * resident composing forever after a brief disconnect.
 */
export class TypingPresenceExpiry {
  private readonly pending = new Map<string, TypingPresenceTimerHandle>();

  constructor(
    private readonly onExpire: (payload: TypingMemberPayload) => void,
    private readonly ttlMs = TYPING_PRESENCE_TTL_MS,
    private readonly timers: TypingPresenceTimerApi = browserTimers,
  ) {}

  observe(payload: TypingMemberPayload): void {
    const key = presenceKey(payload);
    const previous = this.pending.get(key);
    if (previous !== undefined) {
      this.timers.cancel(previous);
      this.pending.delete(key);
    }
    if (!payload.active) return;

    let handle: TypingPresenceTimerHandle;
    handle = this.timers.schedule(() => {
      // A refreshed event owns a different handle; an old callback that was
      // already queued is therefore harmless even if cancellation raced it.
      if (this.pending.get(key) !== handle) return;
      this.pending.delete(key);
      this.onExpire({ ...payload, active: false });
    }, this.ttlMs);
    this.pending.set(key, handle);
  }

  clear(): void {
    for (const handle of this.pending.values()) this.timers.cancel(handle);
    this.pending.clear();
  }
}
