import { describe, expect, it } from "vitest";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createMessage, RoomStore } from "./store.js";
import { CHANNELS } from "./channels.js";

const tempStorePath = () => `/tmp/third-place-store-${Date.now()}-${Math.random()}.json`;
const tempStore = () => new RoomStore(tempStorePath());

describe("room history", () => {
  it("seeds every configured channel so newly added rooms do not open empty", async () => {
    const store = tempStore();
    await store.load();
    for (const channel of CHANNELS) {
      expect(store.getRecent(channel.id, 10).length).toBeGreaterThanOrEqual(2);
    }
  });

  it("migrates an existing seven-room history by adding the pub exactly once", async () => {
    const filePath = tempStorePath();
    const existing = createMessage("lobby", "human-returning", "keep this old history");
    await writeFile(filePath, JSON.stringify({ version: 1, messages: [existing] }), "utf8");

    const migrated = new RoomStore(filePath);
    await migrated.load();
    const firstPubIds = migrated.getRecent("the-pub", 50).map((message) => message.id);
    expect(firstPubIds.length).toBeGreaterThanOrEqual(2);
    expect(migrated.getRecent("lobby", 50).some((message) => message.id === existing.id)).toBe(true);

    const reloaded = new RoomStore(filePath);
    await reloaded.load();
    expect(reloaded.getRecent("the-pub", 50).map((message) => message.id)).toEqual(firstPubIds);
    expect(reloaded.getRecent("lobby", 50).some((message) => message.id === existing.id)).toBe(true);
  });

  it("returns stable chronological pages before a composite cursor", async () => {
    const store = tempStore();
    for (let index = 0; index < 95; index += 1) {
      const message = createMessage("lobby", "ai-mira", `message ${index}`);
      message.createdAt = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
      store.addPublicMessage(message);
    }
    const latest = store.getHistoryPage("lobby", undefined, 40);
    expect(latest.messages).toHaveLength(40);
    expect(latest.messages[0]?.content).toBe("message 55");
    expect(latest.hasMore).toBe(true);
    const first = latest.messages[0]!;
    const older = store.getHistoryPage("lobby", { createdAt: first.createdAt, id: first.id }, 40);
    expect(older.messages).toHaveLength(40);
    expect(older.messages[0]?.content).toBe("message 15");
    expect(older.messages.at(-1)?.content).toBe("message 54");
    await store.flush();
  });

  it("retains quiet-channel history when a different channel becomes busy", async () => {
    const store = tempStore();
    store.addPublicMessage(createMessage("ai-lab", "ai-zed", "keep me"));
    for (let index = 0; index <= 600; index += 1) {
      store.addPublicMessage(createMessage("lobby", "ai-mira", `busy ${index}`));
    }
    expect(store.getRecent("ai-lab", 10).map((message) => message.content)).toEqual(["keep me"]);
    expect(store.getRecent("lobby", 1)[0]?.content).toBe("busy 600");
    expect(store.getAllMessages().filter((message) => message.channelId === "lobby").length).toBe(500);
    await store.flush();
  });

  it("serializes overlapping flushes and atomically leaves the latest state on disk", async () => {
    const filePath = tempStorePath();
    const store = new RoomStore(filePath);
    const expectedIds: string[] = [];
    const flushes: Array<Promise<void>> = [];

    for (let index = 0; index < 12; index += 1) {
      const message = createMessage("lobby", "ai-mira", `overlap ${index}`);
      expectedIds.push(message.id);
      store.addPublicMessage(message);
      flushes.push(store.flush());
    }

    await expect(Promise.all(flushes)).resolves.toHaveLength(12);
    const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
      version: number;
      messages: Array<{ id: string }>;
    };
    expect(persisted.version).toBe(1);
    expect(persisted.messages.map((message) => message.id)).toEqual(expectedIds);

    const temporaryPrefix = `${basename(filePath)}.`;
    const leftovers = (await readdir(dirname(filePath))).filter(
      (entry) => entry.startsWith(temporaryPrefix) && entry.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });
});
