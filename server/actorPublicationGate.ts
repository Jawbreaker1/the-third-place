export interface ActorPublicationLease {
  readonly actorId: string;
  readonly epoch: number;
}

/**
 * Small actor-scoped commit gate for HTTP work that can outlive the session
 * check which admitted it. Invalidation is synchronous; a fetch/decode/model
 * continuation carrying an older lease can therefore never commit afterwards.
 */
export class ActorPublicationGate {
  readonly #epochs = new Map<string, number>();

  capture(actorId: string): ActorPublicationLease {
    return Object.freeze({ actorId, epoch: this.#epochs.get(actorId) ?? 0 });
  }

  invalidate(actorId: string): number {
    const epoch = (this.#epochs.get(actorId) ?? 0) + 1;
    this.#epochs.set(actorId, epoch);
    return epoch;
  }

  isCurrent(lease: ActorPublicationLease): boolean {
    return (this.#epochs.get(lease.actorId) ?? 0) === lease.epoch;
  }
}
