export type VoiceIngestGateErrorCode = "ABORTED" | "QUEUE_FULL";

export class VoiceIngestGateError extends Error {
  readonly code: VoiceIngestGateErrorCode;

  constructor(code: VoiceIngestGateErrorCode, message: string) {
    super(message);
    this.name = "VoiceIngestGateError";
    this.code = code;
  }
}

export type VoiceIngestGateOptions = {
  maxActive?: number;
  maxQueued?: number;
};

export type VoiceIngestRelease = () => void;

type Waiter = {
  signal?: AbortSignal;
  resolve: (release: VoiceIngestRelease) => void;
  reject: (error: VoiceIngestGateError) => void;
  removeAbortListener: () => void;
};

const assertIntegerAtLeast = (name: string, value: number, minimum: number): void => {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be an integer greater than or equal to ${minimum}`);
  }
};

/**
 * Bounds expensive voice transcription work while preserving arrival order.
 *
 * A successful acquire reserves one active slot until its returned release
 * function is called. Callers should always release from a `finally` block.
 */
export class VoiceIngestGate {
  readonly maxActive: number;
  readonly maxQueued: number;

  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(options: VoiceIngestGateOptions = {}) {
    this.maxActive = options.maxActive ?? 2;
    this.maxQueued = options.maxQueued ?? 8;
    assertIntegerAtLeast("maxActive", this.maxActive, 1);
    assertIntegerAtLeast("maxQueued", this.maxQueued, 0);
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.waiters.length;
  }

  acquire(signal?: AbortSignal): Promise<VoiceIngestRelease> {
    if (signal?.aborted) {
      return Promise.reject(new VoiceIngestGateError("ABORTED", "Voice transcription wait was aborted"));
    }

    if (this.active < this.maxActive) {
      this.active += 1;
      return Promise.resolve(this.createRelease());
    }

    if (this.waiters.length >= this.maxQueued) {
      return Promise.reject(new VoiceIngestGateError("QUEUE_FULL", "Voice transcription queue is full"));
    }

    return new Promise<VoiceIngestRelease>((resolve, reject) => {
      const waiter: Waiter = {
        signal,
        resolve,
        reject,
        removeAbortListener: () => undefined,
      };

      if (signal) {
        const onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index < 0) return;
          this.waiters.splice(index, 1);
          waiter.removeAbortListener();
          reject(new VoiceIngestGateError("ABORTED", "Voice transcription wait was aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }

      this.waiters.push(waiter);
    });
  }

  private createRelease(): VoiceIngestRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseOne();
    };
  }

  private releaseOne(): void {
    const waiter = this.waiters.shift();
    if (!waiter) {
      this.active -= 1;
      return;
    }

    waiter.removeAbortListener();
    // Transfer the existing active slot directly to the oldest waiter.
    waiter.resolve(this.createRelease());
  }
}
