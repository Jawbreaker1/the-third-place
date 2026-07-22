import { describe, expect, it } from "vitest";
import { ExternalAgentActivityCursorError, ExternalAgentActivityHub } from "./externalAgentActivity.js";

const event = (channelId: string, messageId: string) => ({
  type: "reaction.changed" as const,
  channelId,
  occurredAt: "2026-07-22T12:00:00.000Z",
  messageId,
  memberId: "actor-a",
  emoji: "👍",
  active: true,
});

describe("ExternalAgentActivityHub", () => {
  it("filters rooms while advancing opaque cursors", async () => {
    const hub = new ExternalAgentActivityHub();
    const cursor = hub.cursor();
    hub.publish(event("hidden", "one"));
    hub.publish(event("allowed", "two"));
    const page = await hub.activity({
      cursor,
      channelIds: ["allowed"],
      limit: 10,
      waitMs: 0,
      signal: new AbortController().signal,
    });
    expect(page.events.map((item) => item.type === "reaction.changed" ? item.messageId : item.type)).toEqual(["two"]);
    expect((await hub.activity({
      cursor: page.cursor,
      channelIds: ["allowed"],
      limit: 10,
      waitMs: 0,
      signal: new AbortController().signal,
    })).events).toEqual([]);
  });

  it("wakes a long poll when a permitted event arrives", async () => {
    const hub = new ExternalAgentActivityHub();
    const pending = hub.activity({
      cursor: hub.cursor(),
      channelIds: ["allowed"],
      limit: 10,
      waitMs: 1_000,
      signal: new AbortController().signal,
    });
    hub.publish(event("allowed", "new"));
    const received = (await pending).events[0];
    expect(received?.type === "reaction.changed" ? received.messageId : undefined).toBe("new");
  });

  it("delivers versioned room-local feed snapshots including authoritative removal", async () => {
    const hub = new ExternalAgentActivityHub();
    const cursor = hub.cursor();
    hub.publish({
      type: "channel_feed.sync",
      schemaVersion: 1,
      channelId: "hidden",
      occurredAt: "2026-07-22T12:00:01.000Z",
      cards: [],
    });
    hub.publish({
      type: "channel_feed.sync",
      schemaVersion: 1,
      channelId: "allowed",
      occurredAt: "2026-07-22T12:00:02.000Z",
      cards: [],
    });

    const page = await hub.activity({
      cursor,
      channelIds: ["allowed"],
      limit: 10,
      waitMs: 0,
      signal: new AbortController().signal,
    });
    expect(page.events).toEqual([{
      type: "channel_feed.sync",
      schemaVersion: 1,
      channelId: "allowed",
      occurredAt: "2026-07-22T12:00:02.000Z",
      cards: [],
    }]);
  });

  it("rejects cursors from another process instance", async () => {
    const first = new ExternalAgentActivityHub();
    const second = new ExternalAgentActivityHub();
    await expect(second.activity({
      cursor: first.cursor(),
      channelIds: ["allowed"],
      limit: 10,
      waitMs: 0,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(ExternalAgentActivityCursorError);
  });
});
