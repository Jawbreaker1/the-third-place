import { describe, expect, it } from "vitest";
import type { ChatMessage, HistoryPage } from "../shared/types";
import { encodeHistoryCursor } from "../shared/historyCursor";
import { CLIENT_CHANNEL_MESSAGE_LIMIT, emptyPublicHistory, reducePublicHistory } from "./publicHistoryWindow";

const message = (index: number, channelId = "lobby"): ChatMessage => ({
  id: `${channelId}-${index}`,
  channelId,
  authorId: "human-1",
  content: `Message ${index}`,
  createdAt: new Date(Date.UTC(2026, 0, 1) + index * 1_000).toISOString(),
  reactions: [],
});
const rows = (start: number, end: number, channelId = "lobby"): ChatMessage[] =>
  Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => message(start + index, channelId));
const page = (start: number, end: number, channelId = "lobby"): HistoryPage => ({
  channelId,
  messages: rows(start, end, channelId),
  hasMore: start > 0,
  before: encodeHistoryCursor(message(start, channelId)),
});
const snapshot = (start: number, end: number) => reducePublicHistory(emptyPublicHistory(), {
  type: "snapshot", messages: rows(start, end), pages: { lobby: page(start, end) },
});

describe("bounded public history windows", () => {
  it("pages past 600 messages without discarding the page it just fetched", () => {
    let state = snapshot(960, 999);
    for (let start = 920; start >= 0; start -= 40) {
      const previousFirst = state.messages[0]!;
      state = reducePublicHistory(state, { type: "older", page: page(start, start + 39) });
      expect(state.messages[0]?.id).toBe(`lobby-${start}`);
      expect(state.messages.some((row) => row.id === previousFirst.id)).toBe(true);
      expect(state.messages.length).toBeLessThanOrEqual(CLIENT_CHANNEL_MESSAGE_LIMIT);
      expect(state.pages.lobby?.before).toBe(encodeHistoryCursor(state.messages[0]!));
    }
    expect(state.messages.at(-1)?.id).toBe("lobby-599");
    expect(state.pages.lobby?.hasMore).toBe(false);
    expect(state.detached.lobby).toBe(true);
  });

  it("retains the visible scroll anchor when adding older rows and trimming the newer edge", () => {
    const before = snapshot(400, 999);
    const anchor = before.messages[12]!;
    const after = reducePublicHistory(before, { type: "older", page: page(360, 399) });
    expect(after.messages[52]).toBe(anchor);
    expect(after.messages).toHaveLength(600);
    expect(after.messages.at(-1)?.id).toBe("lobby-959");
  });

  it("does not delete viewed history when live messages arrive", () => {
    let state = reducePublicHistory(snapshot(400, 999), { type: "older", page: page(360, 399) });
    const visibleWindow = state.messages;
    for (let index = 1000; index < 1400; index += 1) {
      state = reducePublicHistory(state, { type: "live", message: message(index) });
    }
    expect(state.messages).toBe(visibleWindow);
    expect(state.pendingLive.lobby).toHaveLength(80);
    expect(state.pendingLive.lobby?.at(-1)?.id).toBe("lobby-1399");
  });

  it("freezes a full window when the reader is scrolled away from the latest messages", () => {
    const before = snapshot(400, 999);
    const after = reducePublicHistory(before, { type: "live", message: message(1000), preserveWindow: true });
    expect(after.messages).toBe(before.messages);
    expect(after.detached.lobby).toBe(true);
    expect(after.pendingLive.lobby?.[0]?.id).toBe("lobby-1000");
  });

  it("moves the cursor with the live window so later backward paging has no skipped range", () => {
    let state = snapshot(400, 999);
    for (let index = 1000; index < 1100; index += 1) {
      state = reducePublicHistory(state, { type: "live", message: message(index) });
    }
    expect(state.messages[0]?.id).toBe("lobby-500");
    expect(state.pages.lobby?.before).toBe(encodeHistoryCursor(message(500)));
    state = reducePublicHistory(state, { type: "older", page: page(460, 499) });
    expect(state.messages.slice(0, 42).map((row) => row.id)).toEqual(rows(460, 501).map((row) => row.id));
  });

  it("replaces a historical window on return to live and keeps concurrent arrivals", () => {
    let state = reducePublicHistory(snapshot(0, 599), { type: "pause", channelId: "lobby" });
    state = reducePublicHistory(state, { type: "live", message: message(1000) });
    state = reducePublicHistory(state, { type: "live", message: message(1001) });
    state = reducePublicHistory(state, { type: "latest", page: page(921, 1000) });
    expect(state.messages.map((row) => row.id)).toEqual(rows(921, 1001).map((row) => row.id));
    expect(state.detached.lobby).toBe(false);
    expect(state.pendingLive.lobby).toBeUndefined();
    expect(state.pages.lobby?.before).toBe(encodeHistoryCursor(message(921)));
  });

  it("does not join a stale latest-page response across a gap after heavy realtime activity", () => {
    let state = reducePublicHistory(snapshot(0, 599), { type: "pause", channelId: "lobby" });
    for (let index = 1000; index < 1200; index += 1) {
      state = reducePublicHistory(state, { type: "live", message: message(index) });
    }
    state = reducePublicHistory(state, { type: "latest", page: page(920, 999) });
    expect(state.messages.map((row) => row.id)).toEqual(rows(1120, 1199).map((row) => row.id));
    expect(state.pages.lobby?.hasMore).toBe(true);
  });

  it("isolates the windows and paging cursors of different rooms", () => {
    let state = reducePublicHistory(snapshot(400, 999), { type: "live", message: message(2000, "the-pub") });
    state = reducePublicHistory(state, { type: "older", page: page(360, 399) });
    state = reducePublicHistory(state, { type: "live", message: message(2001, "the-pub") });
    expect(state.messages.filter((row) => row.channelId === "the-pub").map((row) => row.id))
      .toEqual(["the-pub-2000", "the-pub-2001"]);
    expect(state.detached["the-pub"]).toBeUndefined();
    expect(state.messages.filter((row) => row.channelId === "lobby")).toHaveLength(600);
  });

  it("updates buffered reactions/previews and clears all detached state on a snapshot", () => {
    let state = reducePublicHistory(snapshot(0, 30), { type: "pause", channelId: "lobby" });
    state = reducePublicHistory(state, { type: "live", message: message(31) });
    state = reducePublicHistory(state, {
      type: "transform", update: (messages) => messages.map((row) => ({ ...row, content: "updated" })),
    });
    expect(state.pendingLive.lobby?.[0]?.content).toBe("updated");
    state = reducePublicHistory(state, { type: "snapshot", messages: rows(10, 31), pages: { lobby: page(10, 31) } });
    expect(state.detached).toEqual({});
    expect(state.pendingLive).toEqual({});
  });

  it("uses the server-compatible UTF-8 versioned cursor format", () => {
    const row = { ...message(30), id: "message-åäö-🐧" };
    const encoded = encodeHistoryCursor(row);
    expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")))
      .toEqual({ v: 1, createdAt: row.createdAt, id: row.id });
    expect(encoded).not.toMatch(/[+/=]/);
  });
});
