import { randomUUID } from "node:crypto";
import type {
  ExternalAgentActivityEvent,
  ExternalAgentActivityPage,
} from "./agentRouter.js";

const DEFAULT_CAPACITY = 5_000;

interface CursorPayload {
  v: 1;
  instanceId: string;
  sequence: number;
}

interface ActivityRecord {
  sequence: number;
  event: ExternalAgentActivityEvent;
}

export class ExternalAgentActivityCursorError extends Error {
  readonly code = "ACTIVITY_CURSOR_EXPIRED";

  constructor() {
    super("The activity cursor is no longer available. Bootstrap again for a fresh cursor.");
    this.name = "ExternalAgentActivityCursorError";
  }
}

/**
 * Bounded, process-local fan-out journal. Durable room history remains the
 * source of truth; after restart or retention expiry clients re-bootstrap and
 * receive recent durable context before continuing from a fresh cursor.
 */
export class ExternalAgentActivityHub {
  readonly #instanceId = randomUUID();
  readonly #capacity: number;
  readonly #records: ActivityRecord[] = [];
  readonly #listeners = new Set<() => void>();
  #sequence = 0;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.#capacity = Math.max(100, Math.min(25_000, Math.floor(capacity)));
  }

  cursor(): string {
    return this.#encode(this.#sequence);
  }

  publish(event: ExternalAgentActivityEvent): void {
    this.#sequence += 1;
    this.#records.push({ sequence: this.#sequence, event });
    if (this.#records.length > this.#capacity) {
      this.#records.splice(0, this.#records.length - this.#capacity);
    }
    for (const listener of [...this.#listeners]) listener();
  }

  async activity(input: {
    cursor?: string;
    channelIds: readonly string[];
    limit: number;
    waitMs: number;
    signal: AbortSignal;
  }): Promise<ExternalAgentActivityPage> {
    const startSequence = input.cursor === undefined ? this.#sequence : this.#decode(input.cursor);
    const first = this.#page(startSequence, input.channelIds, input.limit);
    if (first.events.length > 0 || input.waitMs <= 0 || input.signal.aborted) return first;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal.removeEventListener("abort", finish);
        this.#listeners.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, input.waitMs);
      timer.unref?.();
      input.signal.addEventListener("abort", finish, { once: true });
      this.#listeners.add(finish);
    });
    return this.#page(startSequence, input.channelIds, input.limit);
  }

  #page(afterSequence: number, channelIds: readonly string[], limit: number): ExternalAgentActivityPage {
    const oldestSequence = this.#records[0]?.sequence ?? this.#sequence + 1;
    if (afterSequence < oldestSequence - 1 || afterSequence > this.#sequence) {
      throw new ExternalAgentActivityCursorError();
    }
    const allowed = new Set(channelIds);
    const events: ExternalAgentActivityEvent[] = [];
    let consumedSequence = afterSequence;
    for (const record of this.#records) {
      if (record.sequence <= afterSequence) continue;
      consumedSequence = record.sequence;
      if (allowed.has(record.event.channelId)) events.push(record.event);
      if (events.length >= limit) break;
    }
    // Advancing over inaccessible rooms prevents the same hidden event from
    // keeping every subsequent poll artificially behind.
    if (events.length === 0) consumedSequence = this.#sequence;
    return { cursor: this.#encode(consumedSequence), events };
  }

  #encode(sequence: number): string {
    const payload: CursorPayload = { v: 1, instanceId: this.#instanceId, sequence };
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  }

  #decode(raw: string): number {
    try {
      const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<CursorPayload>;
      if (parsed.v !== 1 || parsed.instanceId !== this.#instanceId ||
          !Number.isSafeInteger(parsed.sequence) || (parsed.sequence ?? -1) < 0) {
        throw new ExternalAgentActivityCursorError();
      }
      return parsed.sequence!;
    } catch (error) {
      if (error instanceof ExternalAgentActivityCursorError) throw error;
      throw new ExternalAgentActivityCursorError();
    }
  }
}
