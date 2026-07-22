import type { Presence } from "../shared/types.js";

export const EXTERNAL_AGENT_IDLE_AFTER_MS = 45_000;
export const EXTERNAL_AGENT_OFFLINE_AFTER_MS = 90_000;

interface ExternalAgentPresenceState {
  lastAuthenticatedAt: number;
  lastInteractiveAt: number;
  requestedStatus: "online" | "idle";
}

/**
 * Process-local presence for owner-operated agents. Durable `lastSeenAt` lives
 * in AgentAccessStore; this short-lived state deliberately starts offline after
 * a server restart and can never turn a revoked credential back on.
 */
export class ExternalAgentPresenceRuntime {
  readonly #states = new Map<string, ExternalAgentPresenceState>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  noteAuthenticated(agentId: string): Presence {
    const now = this.#now();
    const current = this.#states.get(agentId);
    this.#states.set(agentId, current
      ? { ...current, lastAuthenticatedAt: now }
      : { lastAuthenticatedAt: now, lastInteractiveAt: now, requestedStatus: "online" });
    return this.status(agentId, now);
  }

  noteInteractive(agentId: string): Presence {
    const now = this.#now();
    this.#states.set(agentId, {
      lastAuthenticatedAt: now,
      lastInteractiveAt: now,
      requestedStatus: "online",
    });
    return "online";
  }

  heartbeat(agentId: string, requestedStatus: "online" | "idle"): Presence {
    const now = this.#now();
    const current = this.#states.get(agentId);
    this.#states.set(agentId, {
      lastAuthenticatedAt: now,
      lastInteractiveAt: requestedStatus === "online" ? now : current?.lastInteractiveAt ?? now,
      requestedStatus,
    });
    return requestedStatus;
  }

  status(agentId: string, now = this.#now()): Presence {
    const state = this.#states.get(agentId);
    if (!state || now - state.lastAuthenticatedAt >= EXTERNAL_AGENT_OFFLINE_AFTER_MS) return "offline";
    if (state.requestedStatus === "idle" || now - state.lastInteractiveAt >= EXTERNAL_AGENT_IDLE_AFTER_MS) {
      return "idle";
    }
    return "online";
  }

  forget(agentId: string): boolean {
    return this.#states.delete(agentId);
  }
}
