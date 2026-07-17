import { describe, expect, it } from "vitest";
import { HumanIdentityMutationCoordinator } from "./humanIdentityMutation.js";

describe("HumanIdentityMutationCoordinator", () => {
  it("keeps overlapping identity mutations strictly serial", async () => {
    const coordinator = new HumanIdentityMutationCoordinator();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });

    const first = coordinator.run(async () => {
      events.push("first:start");
      markFirstStarted();
      await firstGate;
      events.push("first:end");
    });
    const second = coordinator.run(async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await firstStarted;
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("does not let a failed mutation poison later identity work", async () => {
    const coordinator = new HumanIdentityMutationCoordinator();
    await expect(coordinator.run(async () => { throw new Error("disk failed"); })).rejects.toThrow("disk failed");
    await expect(coordinator.run(async () => "recovered")).resolves.toBe("recovered");
  });
});
