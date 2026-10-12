import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RoomStore } from "./store.js";

const fixture = async (options: ConstructorParameters<typeof RoomStore>[1] = {}) => {
  const path = join(await mkdtemp(join(tmpdir(), "third-place-private-outbox-")), "rooms.json");
  const store = new RoomStore(path, options);
  await store.load();
  const thread = store.openDm("human-one", "ai-mira");
  return { path, store, thread };
};

describe("durable private resident obligations", () => {
  it("restores only explicitly accepted obligations and releases process-local claims on restart", async () => {
    const { path, store, thread } = await fixture();
    const older = store.addDmMessage(thread.id, "human-one", "An old unmarked conversation.")!;
    const message = await store.addDmMessageDurably(thread.id, "human-one", "Please answer after restart.", {
      pendingResidentId: "ai-mira",
    });
    expect(message).toBeDefined();
    expect(store.claimPendingDirectTurn(message!.id)).toBe(true);
    expect(store.claimPendingDirectTurn(message!.id)).toBe(false);
    const restarted = new RoomStore(path);
    await restarted.load();
    expect(restarted.listPendingDirectTurns()).toEqual([expect.objectContaining({
      messageId: message!.id, threadId: thread.id, authorId: "human-one", personaId: "ai-mira",
    })]);
    expect(restarted.claimPendingDirectTurn(message!.id)).toBe(true);
    expect(restarted.claimPendingDirectTurn(older.id)).toBe(false);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted.version).toBe(8);
    expect(persisted.pendingDirectTurns[0]).not.toHaveProperty("content");
    expect(store.getAllMessages().some((entry) => entry.id === message!.id)).toBe(false);
  });

  it("does not invent private obligations when migrating version 7 history", async () => {
    const { path, store, thread } = await fixture();
    store.addDmMessage(thread.id, "human-one", "An old deliberately unanswered question.");
    await store.flush();
    const persisted = JSON.parse(await readFile(path, "utf8"));
    persisted.version = 7;
    delete persisted.pendingDirectTurns;
    await writeFile(path, JSON.stringify(persisted));
    const restarted = new RoomStore(path);
    await restarted.load();
    expect(restarted.listPendingDirectTurns()).toEqual([]);
    expect(restarted.getDmMessages(thread.id)).toHaveLength(1);
  });

  it("settles a coalesced batch in the same snapshot as its actual resident reply", async () => {
    const { path, store, thread } = await fixture();
    const first = await store.addDmMessageDurably(thread.id, "human-one", "First question", { pendingResidentId: "ai-mira" });
    const second = await store.addDmMessageDurably(thread.id, "human-one", "And another detail", { pendingResidentId: "ai-mira" });
    expect(store.completePendingDirectTurns([first!.id], "ai-sana")).toBe(0);
    const reply = store.addDmMessage(thread.id, "ai-mira", "Here is the answer to both.", second!.id);
    expect(store.completePendingDirectTurns([first!.id, second!.id], "ai-mira")).toBe(2);
    await store.flush();
    const restarted = new RoomStore(path);
    await restarted.load();
    expect(restarted.listPendingDirectTurns()).toEqual([]);
    expect(restarted.getDmMessages(thread.id).at(-1)?.id).toBe(reply!.id);
  });

  it("rolls back a failed durable append and its retention removals without deleting attachments", async () => {
    const { path, store, thread } = await fixture({ dmHistoryHardLimit: 160, dmHistoryTrimTo: 120 });
    for (let index = 0; index < 160; index += 1) store.addDmMessage(thread.id, "human-one", `Retained ${index}`);
    await store.flush();
    const before = store.getDmMessages(thread.id).map((message) => message.id);
    const removed = vi.fn();
    store.onMessagesRemoved(removed);
    const flush = vi.spyOn(store, "flush").mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(store.addDmMessageDurably(thread.id, "human-one", "Never accepted", {
      pendingResidentId: "ai-mira",
    })).rejects.toThrow("disk unavailable");
    expect(store.getDmMessages(thread.id).map((message) => message.id)).toEqual(before);
    expect(store.listPendingDirectTurns()).toEqual([]);
    expect(removed).not.toHaveBeenCalled();
    flush.mockRestore();
    await store.flush();
    const restarted = new RoomStore(path);
    await restarted.load();
    expect(restarted.getDmMessages(thread.id).map((message) => message.id)).toEqual(before);
  });

  it("does not resurrect a retired or replaced private thread during failed append rollback", async () => {
    const { store, thread } = await fixture();
    store.addDmMessage(thread.id, "human-one", "Private old context");
    await store.flush();
    let fail!: (error: Error) => void;
    const flush = vi.spyOn(store, "flush").mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const pending = store.addDmMessageDurably(thread.id, "human-one", "In flight", { pendingResidentId: "ai-mira" });
    store.forgetDmParticipant("human-one");
    store.openDm("human-one", "ai-mira");
    fail(new Error("disk unavailable"));
    await expect(pending).rejects.toThrow("disk unavailable");
    expect(store.getDmMessages(thread.id)).toEqual([]);
    expect(store.listPendingDirectTurns()).toEqual([]);
    flush.mockRestore();
    await store.flush();
  });

  it("durably cancels actor obligations and forgets them with their private threads", async () => {
    const { path, store, thread } = await fixture();
    await store.addDmMessageDurably(thread.id, "human-one", "Awaiting a reply", { pendingResidentId: "ai-mira" });
    expect(store.cancelPendingDirectTurnsForActor("ai-mira")).toBe(1);
    await store.flush();
    const afterReset = new RoomStore(path);
    await afterReset.load();
    expect(afterReset.listPendingDirectTurns()).toEqual([]);
    expect(afterReset.getDmMessages(thread.id)).toHaveLength(1);
    await afterReset.addDmMessageDurably(thread.id, "human-one", "A genuinely later turn", { pendingResidentId: "ai-mira" });
    afterReset.forgetDmParticipant("human-one");
    await afterReset.flush();
    const afterErasure = new RoomStore(path);
    await afterErasure.load();
    expect(afterErasure.listPendingDirectTurns()).toEqual([]);
    expect(afterErasure.getDmThreads("human-one")).toEqual([]);
  });

  it("bounds unanswered work by count and expiry while preserving the private transcript", async () => {
    let now = Date.now();
    const { store, thread } = await fixture({ now: () => now });
    for (let index = 0; index < 32; index += 1) {
      await store.addDmMessageDurably(thread.id, "human-one", `Question ${index}`, { pendingResidentId: "ai-mira" });
    }
    await expect(store.addDmMessageDurably(thread.id, "human-one", "Over capacity", { pendingResidentId: "ai-mira" }))
      .rejects.toThrow("private reply queue is full");
    expect(store.getDmMessages(thread.id)).toHaveLength(32);
    now += 8 * 24 * 60 * 60_000;
    expect(store.listPendingDirectTurns()).toEqual([]);
    expect(store.getDmMessages(thread.id)).toHaveLength(32);
    await store.flush();
  });

  it("rejects invalid explicit targets without adding a row or guessing a resident", async () => {
    const { store, thread } = await fixture();
    await expect(store.addDmMessageDurably(thread.id, "human-one", "Wrong target", { pendingResidentId: "ai-sana" }))
      .rejects.toThrow("other thread participant");
    expect(store.getDmMessages(thread.id)).toEqual([]);
    expect(store.listPendingDirectTurns()).toEqual([]);
    await store.flush();
  });
});
