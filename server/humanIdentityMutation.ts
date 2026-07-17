/**
 * A deliberately global coordinator for the small, security-sensitive human
 * identity catalog. Identity creation can prune another retained profile, so a
 * per-actor lock is insufficient: creation, recovery, credential rotation,
 * erasure and retention must share one serial transaction boundary.
 */
export class HumanIdentityMutationCoordinator {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tail = previous.catch(() => undefined).then(() => current);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
