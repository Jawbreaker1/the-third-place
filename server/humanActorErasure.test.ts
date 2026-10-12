import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HumanMemoryStore } from "./humanMemory.js";
import { reconcileHumanActorErasure } from "./humanActorErasure.js";
import { RoomStore } from "./store.js";

describe("human actor erasure durability", () => {
  it("flushes idempotent same-process retries before acknowledging an erasure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "third-place-erasure-retry-"));
    const humanPath = join(directory, "humans.json");
    const roomPath = join(directory, "rooms.json");
    const memory = new HumanMemoryStore({ filePath: humanPath, persistDelayMs: 60_000 });
    await memory.load();
    memory.confirmContinuityBaseline();
    const rooms = new RoomStore(roomPath);
    await rooms.load();
    const thread = rooms.openDm("human-retired", "ai-mira");
    rooms.addDmMessage(thread.id, "human-retired", "Erase this private conversation.");
    await rooms.flush();
    memory.queuePendingActorForget("human-retired");

    const flush = vi.spyOn(rooms, "flush").mockRejectedValueOnce(new Error("temporary disk failure"));
    const erase = () => reconcileHumanActorErasure({
      memory,
      rooms,
      forgetIdentity: async () => undefined,
      forgetSocialMemory: async () => undefined,
      removeImage: async () => undefined,
      onThreadRemoved: () => undefined,
    });

    await expect(erase()).rejects.toThrow("temporary disk failure");
    expect(rooms.getDmThreads("human-retired")).toEqual([]);
    expect(memory.listPendingActorForgets()).toEqual(["human-retired"]);
    const beforeRetry = new RoomStore(roomPath);
    await beforeRetry.load();
    expect(beforeRetry.getDmThreads("human-retired")).toHaveLength(1);

    await expect(erase()).resolves.toBe(1);
    expect(flush).toHaveBeenCalledTimes(2);
    const restartedRooms = new RoomStore(roomPath);
    await restartedRooms.load();
    expect(restartedRooms.getDmThreads("human-retired")).toEqual([]);
    const restartedMemory = new HumanMemoryStore({ filePath: humanPath, persistDelayMs: 60_000 });
    expect((await restartedMemory.load()).pendingActorForgetIds).toEqual([]);
    flush.mockRestore();
  });
});
