import { describe, expect, it } from "vitest";
import { createMessage, RoomStore } from "./store.js";
import { CHANNELS } from "./channels.js";

const tempStore = () => new RoomStore(`/tmp/third-place-store-${Date.now()}-${Math.random()}.json`);

describe("room history", () => {
  it("seeds every configured channel so newly added rooms do not open empty", async () => {
    const store = tempStore();
    await store.load();
    for (const channel of CHANNELS) {
      expect(store.getRecent(channel.id, 10).length).toBeGreaterThanOrEqual(2);
    }
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
});
