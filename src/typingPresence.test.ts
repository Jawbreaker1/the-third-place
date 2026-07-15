import { describe, expect, it, vi } from "vitest";
import type { TypingMemberPayload } from "../shared/types";
import {
  reduceTypingPresence,
  TypingPresenceExpiry,
  type TypingPresenceTimerApi,
  type TypingPresenceTimerHandle,
} from "./typingPresence";

describe("reduceTypingPresence", () => {
  it("tracks members independently per conversation and removes empty channels", () => {
    const mira = { channelId: "lobby", memberId: "ai-mira", active: true };
    const vale = { channelId: "stock-market", memberId: "ai-vale", active: true };
    const active = reduceTypingPresence(reduceTypingPresence({}, mira), vale);

    expect(active).toEqual({ lobby: ["ai-mira"], "stock-market": ["ai-vale"] });
    expect(reduceTypingPresence(active, { ...mira, active: false })).toEqual({
      "stock-market": ["ai-vale"],
    });
  });

  it("keeps duplicate socket deliveries idempotent", () => {
    const payload = { channelId: "lobby", memberId: "ai-mira", active: true };
    const once = reduceTypingPresence({}, payload);
    expect(reduceTypingPresence(once, payload)).toBe(once);
  });
});

describe("TypingPresenceExpiry", () => {
  it("expires a remote typing event when its stop event is lost", () => {
    vi.useFakeTimers();
    try {
      const expired: TypingMemberPayload[] = [];
      const expiry = new TypingPresenceExpiry((payload) => expired.push(payload), 1_000);
      expiry.observe({ channelId: "lobby", memberId: "ai-mira", active: true });

      vi.advanceTimersByTime(999);
      expect(expired).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(expired).toEqual([{
        channelId: "lobby",
        memberId: "ai-mira",
        active: false,
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes the deadline and ignores an already-queued stale callback", () => {
    const callbacks = new Map<number, () => void>();
    const cancelled: number[] = [];
    let nextHandle = 1;
    const timers: TypingPresenceTimerApi = {
      schedule(callback) {
        const handle = nextHandle++;
        callbacks.set(handle, callback);
        return handle as unknown as TypingPresenceTimerHandle;
      },
      cancel(handle) {
        cancelled.push(handle as unknown as number);
      },
    };
    const expired: TypingMemberPayload[] = [];
    const expiry = new TypingPresenceExpiry((payload) => expired.push(payload), 1_000, timers);
    const payload = { channelId: "lobby", memberId: "ai-mira", active: true };

    expiry.observe(payload);
    expiry.observe(payload);
    callbacks.get(1)?.();
    expect(expired).toEqual([]);
    callbacks.get(2)?.();
    expect(expired).toEqual([{ ...payload, active: false }]);
    expect(cancelled).toContain(1);
  });

  it("cancels the deadline when the matching stop event arrives", () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      const expiry = new TypingPresenceExpiry(onExpire, 1_000);
      const payload = { channelId: "lobby", memberId: "ai-mira", active: true };
      expiry.observe(payload);
      expiry.observe({ ...payload, active: false });

      vi.advanceTimersByTime(2_000);
      expect(onExpire).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels every pending expiry when a socket snapshot replaces transient state", () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      const expiry = new TypingPresenceExpiry(onExpire, 1_000);
      expiry.observe({ channelId: "lobby", memberId: "ai-mira", active: true });
      expiry.observe({ channelId: "the-pub", memberId: "ai-vale", active: true });
      expiry.clear();

      vi.advanceTimersByTime(2_000);
      expect(onExpire).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
