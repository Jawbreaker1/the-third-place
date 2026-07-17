import { describe, expect, it } from "vitest";
import { ActorPublicationGate } from "./actorPublicationGate.js";

describe("actor publication gate", () => {
  it("rejects a continuation captured before actor erasure while allowing a new epoch", async () => {
    const gate = new ActorPublicationGate();
    const admitted = gate.capture("human-a");
    let release!: () => void;
    const slowWork = new Promise<void>((resolve) => { release = resolve; });
    const commit = slowWork.then(() => gate.isCurrent(admitted));

    gate.invalidate("human-a");
    release();

    await expect(commit).resolves.toBe(false);
    expect(gate.isCurrent(gate.capture("human-a"))).toBe(true);
    expect(gate.isCurrent(gate.capture("human-b"))).toBe(true);
  });
});
