import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AutonomousPublicationBudgetState } from "./behaviorTuning.js";
import { createMessage, RoomStateLoadError, RoomStore } from "./store.js";

const directories: string[] = [];
const now = Date.parse("2026-10-11T19:30:00.000Z");
const checkpoint = (): AutonomousPublicationBudgetState => ({
  tokens: 1.25,
  updatedAt: now,
  refillPerMinute: 10,
  burstCapacity: 3,
});

const fixture = async () => {
  const directory = await mkdtemp(join(tmpdir(), "third-place-budget-store-"));
  directories.push(directory);
  const path = join(directory, "room-state.json");
  const store = new RoomStore(path, { now: () => now });
  await store.load();
  return { directory, path, store };
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("persistent autonomous publication budget", () => {
  it("persists the checkpoint with its publication and restores it without exposing it as chat data", async () => {
    const { path, store } = await fixture();
    const state = checkpoint();
    const message = createMessage("lobby", "ai-mira", "A concrete resident contribution.", {
      createdAt: new Date(now).toISOString(),
      generation: "lm",
    });
    store.setAutonomousPublicationBudget(state);
    store.addUncommittedPublicMessage(message, { kind: "ambient", attendance: "unattended" });
    await store.flush();

    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved).toMatchObject({ version: 8, autonomousPublicationBudget: state });
    expect(saved.autonomousPublications).toContainEqual(expect.objectContaining({ messageId: message.id }));
    const restored = new RoomStore(path, { now: () => now });
    await restored.load();
    expect(restored.getAutonomousPublicationBudget()).toEqual(state);
    expect(restored.getMessage(message.id)?.content).toBe(message.content);
    expect(JSON.stringify(restored.getAllMessages())).not.toContain("autonomousPublicationBudget");
  });

  it("copies checkpoint inputs and outputs instead of leaking mutable accounting", async () => {
    const { path, store } = await fixture();
    const input = checkpoint();
    store.setAutonomousPublicationBudget(input);
    input.tokens = 0;
    input.refillPerMinute = 0;
    const returned = store.getAutonomousPublicationBudget()!;
    returned.tokens = 3;
    returned.updatedAt = 0;
    expect(store.getAutonomousPublicationBudget()).toEqual(checkpoint());
    await store.flush();
    expect(JSON.parse(await readFile(path, "utf8")).autonomousPublicationBudget).toEqual(checkpoint());
  });

  it("loads earlier version-8 snapshots without a checkpoint or a migration backup", async () => {
    const { directory, path, store } = await fixture();
    const oldBytes = await readFile(path, "utf8");
    expect(JSON.parse(oldBytes)).not.toHaveProperty("autonomousPublicationBudget");
    store.setAutonomousPublicationBudget(checkpoint());
    await store.flush();
    await writeFile(path, oldBytes, "utf8");

    await store.load();
    expect(store.getAutonomousPublicationBudget()).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(oldBytes);
    expect(await readdir(directory)).toEqual(["room-state.json"]);
  });

  it.each([
    ["null", null],
    ["array", []],
    ["missing fields", {}],
    ["negative tokens", { ...checkpoint(), tokens: -1 }],
    ["nonfinite tokens", { ...checkpoint(), tokens: Number.NaN }],
    ["tokens beyond capacity", { ...checkpoint(), tokens: 4 }],
    ["negative timestamp", { ...checkpoint(), updatedAt: -1 }],
    ["infinite timestamp", { ...checkpoint(), updatedAt: Infinity }],
    ["negative refill", { ...checkpoint(), refillPerMinute: -1 }],
    ["string refill", { ...checkpoint(), refillPerMinute: "10" }],
    ["infinite refill", { ...checkpoint(), refillPerMinute: Infinity }],
    ["fractional capacity", { ...checkpoint(), burstCapacity: 3.5 }],
    ["negative capacity", { ...checkpoint(), burstCapacity: -1 }],
    ["unsafe capacity", { ...checkpoint(), burstCapacity: Number.MAX_SAFE_INTEGER + 1 }],
    ["unknown fields", { ...checkpoint(), privateInstruction: "not checkpoint data" }],
  ])("rejects %s on mutation and load without overwriting the invalid snapshot", async (_label, invalid) => {
    const { path, store } = await fixture();
    store.setAutonomousPublicationBudget(checkpoint());
    await store.flush();
    expect(() => store.setAutonomousPublicationBudget(invalid as AutonomousPublicationBudgetState))
      .toThrow(TypeError);
    expect(store.getAutonomousPublicationBudget()).toEqual(checkpoint());

    const snapshot = JSON.parse(await readFile(path, "utf8"));
    snapshot.autonomousPublicationBudget = invalid;
    const invalidBytes = JSON.stringify(snapshot);
    await writeFile(path, invalidBytes, "utf8");
    await expect(store.load()).rejects.toBeInstanceOf(RoomStateLoadError);
    expect(store.getAutonomousPublicationBudget()).toBeUndefined();
    expect(store.getAllMessages()).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(invalidBytes);
  });

  it("clears the checkpoint when loading a missing room-state file", async () => {
    const { path, store } = await fixture();
    store.setAutonomousPublicationBudget(checkpoint());
    await store.flush();
    await unlink(path);
    await store.load();
    expect(store.getAutonomousPublicationBudget()).toBeUndefined();
    expect(JSON.parse(await readFile(path, "utf8"))).not.toHaveProperty("autonomousPublicationBudget");
  });

  it("does not resurrect spent tokens when an earlier speculative publication rolls back", async () => {
    const { path, store } = await fixture();
    const first = createMessage("lobby", "ai-mira", "First speculative contribution.", {
      createdAt: new Date(now).toISOString(),
      generation: "lm",
    });
    const second = createMessage("the-pub", "ai-bosse", "Later contribution in another room.", {
      createdAt: new Date(now + 1).toISOString(),
      generation: "lm",
    });
    store.setAutonomousPublicationBudget({ ...checkpoint(), tokens: 2 });
    const firstAppend = store.addUncommittedPublicMessage(first, { kind: "ambient", attendance: "unattended" });
    store.setAutonomousPublicationBudget({ ...checkpoint(), tokens: 1 });
    store.addUncommittedPublicMessage(second, { kind: "ambient", attendance: "unattended" });
    expect(store.rollbackUncommittedPublicMessage(firstAppend)).toBe("rolled_back");
    expect(store.getAutonomousPublicationBudget()?.tokens).toBe(1);
    await store.flush();

    const restored = new RoomStore(path, { now: () => now });
    await restored.load();
    expect(restored.getAutonomousPublicationBudget()?.tokens).toBe(1);
    expect(restored.getMessage(first.id)).toBeUndefined();
    expect(restored.getMessage(second.id)).toBeDefined();
    expect(restored.getAutonomousPublicationHistory().map((entry) => entry.messageId)).toEqual([second.id]);
  });
});
