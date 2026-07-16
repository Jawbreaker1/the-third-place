import { describe, expect, it } from "vitest";
import { chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
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

  it("migrates existing history with a lively football opening exactly once", async () => {
    const filePath = tempStorePath();
    const existing = createMessage("lobby", "human-returning", "preserve this pre-football history");
    await writeFile(filePath, JSON.stringify({ version: 1, messages: [existing] }), "utf8");

    const migrated = new RoomStore(filePath);
    await migrated.load();
    const footballMessages = migrated.getRecent("football-talk", 50);
    const firstFootballIds = footballMessages.map((message) => message.id);

    expect(footballMessages.length).toBeGreaterThanOrEqual(3);
    expect(new Set(footballMessages.map((message) => message.authorId))).toEqual(
      new Set(["ai-bosse", "ai-vale", "ai-linnea"]),
    );
    expect(footballMessages.some((message) =>
      message.reactions?.some((reaction) => reaction.emoji === "⚽"),
    )).toBe(true);
    expect(migrated.getRecent("lobby", 50).some((message) => message.id === existing.id)).toBe(true);

    const reloaded = new RoomStore(filePath);
    await reloaded.load();
    expect(reloaded.getRecent("football-talk", 50).map((message) => message.id)).toEqual(firstFootballIds);
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

  it("persists private conversations across a restart without exposing them as public history", async () => {
    const filePath = tempStorePath();
    const first = new RoomStore(filePath);
    await first.load();
    const thread = first.openDm("human-johan", "ai-mira");
    const humanMessage = first.addDmMessage(thread.id, "human-johan", "Minns du det här efter omstart?");
    const residentMessage = first.addDmMessage(thread.id, "ai-mira", "Japp, den här tråden ligger kvar.", humanMessage?.id, "lm");
    expect(residentMessage).toBeDefined();
    await first.flush();

    const restored = new RoomStore(filePath);
    await restored.load();
    expect(restored.openDm("human-johan", "ai-mira").messages.map((message) => message.content)).toEqual([
      "Minns du det här efter omstart?",
      "Japp, den här tråden ligger kvar.",
    ]);
    expect(restored.getAllMessages().some((message) => message.channelId === thread.id)).toBe(false);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({ version: 2 });
  });

  it("restricts a legacy room-state file before it can contain persisted DMs", async () => {
    const filePath = tempStorePath();
    await writeFile(filePath, JSON.stringify({ version: 1, messages: [
      createMessage("lobby", "human-returning", "legacy history"),
    ] }), "utf8");
    await chmod(filePath, 0o644);

    const restored = new RoomStore(filePath);
    await restored.load();

    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("retains quiet-channel history when a different channel becomes busy", async () => {
    const store = new RoomStore(tempStorePath(), {
      publicHistoryHardLimit: 600,
      publicHistoryTrimTo: 500,
    });
    store.addPublicMessage(createMessage("ai-lab", "ai-zed", "keep me"));
    for (let index = 0; index <= 600; index += 1) {
      store.addPublicMessage(createMessage("lobby", "ai-mira", `busy ${index}`));
    }
    expect(store.getRecent("ai-lab", 10).map((message) => message.content)).toEqual(["keep me"]);
    expect(store.getRecent("lobby", 1)[0]?.content).toBe("busy 600");
    expect(store.getAllMessages().filter((message) => message.channelId === "lobby").length).toBe(500);
    await store.flush();
  });

  it("keeps private autonomous accounting after visible history trimming and reload", async () => {
    const filePath = tempStorePath();
    const retention = { publicHistoryHardLimit: 600, publicHistoryTrimTo: 500 };
    const store = new RoomStore(filePath, retention);
    const tracked = createMessage("lobby", "ai-mira", "tracked unattended post");
    store.addPublicMessage(tracked, { kind: "ambient", attendance: "unattended" });
    for (let index = 0; index < 650; index += 1) {
      store.addPublicMessage(createMessage("lobby", "human-busy", `busy ${index}`));
    }

    expect(store.getMessage(tracked.id)).toBeUndefined();
    expect(store.getAutonomousPublicationHistory()).toEqual([expect.objectContaining({
      messageId: tracked.id,
      attendance: "unattended",
    })]);
    expect(tracked).not.toHaveProperty("autonomousPublication");
    await store.flush();

    const restored = new RoomStore(filePath, retention);
    await restored.load();
    expect(restored.getAutonomousPublicationHistory()).toEqual([expect.objectContaining({
      messageId: tracked.id,
      attendance: "unattended",
    })]);
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
    expect(persisted.version).toBe(2);
    expect(persisted.messages.map((message) => message.id)).toEqual(expectedIds);

    const temporaryPrefix = `${basename(filePath)}.`;
    const leftovers = (await readdir(dirname(filePath))).filter(
      (entry) => entry.startsWith(temporaryPrefix) && entry.endsWith(".tmp"),
    );
    expect(leftovers).toEqual([]);
  });
});
