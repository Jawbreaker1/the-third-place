import { participantIdentityKey } from "./participantIdentity.js";

export interface AdminModerationGuardOptions {
  now?: () => number;
  kickCooldownMs?: number;
}

interface KickRecord {
  memberId: string;
  nameKey: string;
  expiresAt: number;
}

/** Ephemeral reconnect cooldowns. No network address is collected or stored. */
export class AdminModerationGuard {
  private readonly now: () => number;
  private readonly kickCooldownMs: number;
  private readonly kicks = new Map<string, KickRecord>();

  constructor(options: AdminModerationGuardOptions = {}) {
    this.now = options.now ?? Date.now;
    const configuredCooldown = options.kickCooldownMs ?? 5 * 60_000;
    this.kickCooldownMs = Number.isFinite(configuredCooldown)
      ? Math.max(5_000, Math.min(configuredCooldown, 60 * 60_000))
      : 5 * 60_000;
  }

  kick(memberId: string, name: string): number {
    const expiresAt = this.now() + this.kickCooldownMs;
    this.kicks.set(memberId, { memberId, nameKey: participantIdentityKey(name), expiresAt });
    return expiresAt;
  }

  isKicked(memberId: string | undefined, name: string): boolean {
    this.prune();
    const nameKey = participantIdentityKey(name);
    return [...this.kicks.values()].some((kick) =>
      (memberId && kick.memberId === memberId) || kick.nameKey === nameKey,
    );
  }

  clear(memberId: string): void {
    this.kicks.delete(memberId);
  }

  prune(now = this.now()): void {
    for (const [memberId, kick] of this.kicks) {
      if (kick.expiresAt <= now) this.kicks.delete(memberId);
    }
  }
}
