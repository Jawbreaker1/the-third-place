import type { Presence } from "../shared/types.js";

export interface HumanPresenceSignal {
  visible: boolean;
  active: boolean;
}

interface SocketPresenceState {
  visible: boolean;
  lastActivityAt: number;
  voiceConnected: boolean;
}

export type HumanRuntimePresence = Extract<Presence, "online" | "idle" | "offline">;

/**
 * Session-scoped, server-authoritative human presence.
 *
 * Browser packets never carry timestamps. They can report visibility and a
 * bounded activity hint, while the server clock owns expiry. Keeping the
 * state session-scoped also prevents delayed packets from a revoked identity
 * from changing its replacement session.
 */
export class HumanPresenceRuntime {
  private readonly sockets = new Map<string, SocketPresenceState>();

  constructor(private readonly idleAfterMs: number) {
    if (!Number.isFinite(idleAfterMs) || idleAfterMs <= 0) {
      throw new Error("idleAfterMs must be a positive finite duration");
    }
  }

  connect(socketId: string, signal: HumanPresenceSignal, now: number): void {
    this.sockets.set(socketId, {
      visible: signal.visible,
      lastActivityAt: signal.visible && signal.active ? now : Number.NEGATIVE_INFINITY,
      voiceConnected: false,
    });
  }

  update(socketId: string, signal: HumanPresenceSignal, now: number): boolean {
    const socket = this.sockets.get(socketId);
    if (!socket) return false;
    socket.visible = signal.visible;
    // Hidden/background documents cannot keep themselves active merely by
    // emitting synthetic activity. Returning to visible is itself activity.
    if (signal.visible && signal.active) socket.lastActivityAt = now;
    return true;
  }

  setVoiceConnected(socketId: string, connected: boolean): boolean {
    const socket = this.sockets.get(socketId);
    if (!socket) return false;
    socket.voiceConnected = connected;
    return true;
  }

  disconnect(socketId: string): boolean {
    return this.sockets.delete(socketId);
  }

  clear(): void {
    this.sockets.clear();
  }

  status(now: number): HumanRuntimePresence {
    if (this.sockets.size === 0) return "offline";
    for (const socket of this.sockets.values()) {
      if (socket.voiceConnected) return "online";
      if (socket.visible && now - socket.lastActivityAt < this.idleAfterMs) return "online";
    }
    return "idle";
  }
}
