import { describe, expect, it } from "vitest";
import { VoiceIngestGate, VoiceIngestGateError } from "./voiceIngestGate.js";

const expectGateError = async (
  promise: Promise<unknown>,
  code: VoiceIngestGateError["code"],
): Promise<VoiceIngestGateError> => {
  try {
    await promise;
    throw new Error("Expected voice ingest gate operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(VoiceIngestGateError);
    expect((error as VoiceIngestGateError).code).toBe(code);
    return error as VoiceIngestGateError;
  }
};

describe("VoiceIngestGate", () => {
  it("allows two active transcriptions by default and queues later arrivals", async () => {
    const gate = new VoiceIngestGate();
    const releaseOne = await gate.acquire();
    const releaseTwo = await gate.acquire();
    let thirdStarted = false;
    const third = gate.acquire().then((release) => {
      thirdStarted = true;
      return release;
    });

    await Promise.resolve();
    expect(gate.maxActive).toBe(2);
    expect(gate.maxQueued).toBe(8);
    expect(gate.activeCount).toBe(2);
    expect(gate.queuedCount).toBe(1);
    expect(thirdStarted).toBe(false);

    releaseOne();
    const releaseThree = await third;
    expect(thirdStarted).toBe(true);
    expect(gate.activeCount).toBe(2);
    expect(gate.queuedCount).toBe(0);

    releaseTwo();
    releaseThree();
    expect(gate.activeCount).toBe(0);
  });

  it("grants queued slots in strict FIFO order", async () => {
    const gate = new VoiceIngestGate({ maxActive: 1, maxQueued: 3 });
    const firstRelease = await gate.acquire();
    const starts: string[] = [];
    const second = gate.acquire().then((release) => {
      starts.push("second");
      return release;
    });
    const third = gate.acquire().then((release) => {
      starts.push("third");
      return release;
    });
    const fourth = gate.acquire().then((release) => {
      starts.push("fourth");
      return release;
    });

    firstRelease();
    const secondRelease = await second;
    expect(starts).toEqual(["second"]);
    secondRelease();
    const thirdRelease = await third;
    expect(starts).toEqual(["second", "third"]);
    thirdRelease();
    const fourthRelease = await fourth;
    expect(starts).toEqual(["second", "third", "fourth"]);
    fourthRelease();

    expect(gate.activeCount).toBe(0);
    expect(gate.queuedCount).toBe(0);
  });

  it("rejects excess work without disturbing active or queued reservations", async () => {
    const gate = new VoiceIngestGate({ maxActive: 1, maxQueued: 1 });
    const firstRelease = await gate.acquire();
    const second = gate.acquire();

    await expectGateError(gate.acquire(), "QUEUE_FULL");
    expect(gate.activeCount).toBe(1);
    expect(gate.queuedCount).toBe(1);

    firstRelease();
    const secondRelease = await second;
    expect(gate.activeCount).toBe(1);
    expect(gate.queuedCount).toBe(0);
    secondRelease();
    expect(gate.activeCount).toBe(0);
  });

  it("removes an aborted waiter and lets the next waiter keep its FIFO position", async () => {
    const gate = new VoiceIngestGate({ maxActive: 1, maxQueued: 3 });
    const firstRelease = await gate.acquire();
    const abortController = new AbortController();
    const aborted = gate.acquire(abortController.signal);
    const third = gate.acquire();

    expect(gate.queuedCount).toBe(2);
    abortController.abort();
    await expectGateError(aborted, "ABORTED");
    expect(gate.queuedCount).toBe(1);

    firstRelease();
    const thirdRelease = await third;
    expect(gate.activeCount).toBe(1);
    expect(gate.queuedCount).toBe(0);
    thirdRelease();
    expect(gate.activeCount).toBe(0);
  });

  it("rejects an already-aborted request without occupying queue capacity", async () => {
    const gate = new VoiceIngestGate({ maxActive: 1, maxQueued: 1 });
    const controller = new AbortController();
    controller.abort();

    await expectGateError(gate.acquire(controller.signal), "ABORTED");
    expect(gate.activeCount).toBe(0);
    expect(gate.queuedCount).toBe(0);

    const release = await gate.acquire();
    release();
  });

  it("makes release idempotent without over-releasing a transferred slot", async () => {
    const gate = new VoiceIngestGate({ maxActive: 1, maxQueued: 1 });
    const firstRelease = await gate.acquire();
    const second = gate.acquire();

    firstRelease();
    firstRelease();
    const secondRelease = await second;
    expect(gate.activeCount).toBe(1);

    const third = gate.acquire();
    expect(gate.queuedCount).toBe(1);
    secondRelease();
    secondRelease();
    const thirdRelease = await third;
    expect(gate.activeCount).toBe(1);
    expect(gate.queuedCount).toBe(0);

    thirdRelease();
    thirdRelease();
    expect(gate.activeCount).toBe(0);
  });

  it("detaches a granted waiter's abort listener without auto-releasing its slot", async () => {
    const gate = new VoiceIngestGate({ maxActive: 1, maxQueued: 1 });
    const firstRelease = await gate.acquire();
    const controller = new AbortController();
    const second = gate.acquire(controller.signal);

    firstRelease();
    const secondRelease = await second;
    controller.abort();
    expect(gate.activeCount).toBe(1);
    expect(gate.queuedCount).toBe(0);

    secondRelease();
    expect(gate.activeCount).toBe(0);
  });

  it("accepts a zero-length queue and validates integer limits", async () => {
    const gate = new VoiceIngestGate({ maxActive: 1, maxQueued: 0 });
    const release = await gate.acquire();
    await expectGateError(gate.acquire(), "QUEUE_FULL");
    release();

    expect(() => new VoiceIngestGate({ maxActive: 0 })).toThrow(RangeError);
    expect(() => new VoiceIngestGate({ maxActive: 1.5 })).toThrow(RangeError);
    expect(() => new VoiceIngestGate({ maxQueued: -1 })).toThrow(RangeError);
    expect(() => new VoiceIngestGate({ maxQueued: 0.5 })).toThrow(RangeError);
  });
});
