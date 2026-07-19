import { describe, expect, it } from "vitest";
import type { AdminChannelFeedControl } from "../shared/adminTypes.js";
import { projectChannelFeedAdminControls } from "./channelFeedAdmin.js";

const control = (): AdminChannelFeedControl => ({
  id: "market-wire",
  channelId: "stock-market",
  kind: "market_ticker",
  label: "MarketWire",
  description: "Bounded market snapshots.",
  publisher: { id: "market-wire", name: "MarketWire", badge: "BOT" },
  available: true,
  enabled: true,
  discussionFrequency: 50,
  activeIntervalMinutes: 5,
  idleIntervalMinutes: 30,
  defaultEnabled: true,
  defaultDiscussionFrequency: 50,
  defaultActiveIntervalMinutes: 5,
  defaultIdleIntervalMinutes: 30,
  minimumIntervalMinutes: 5,
  maximumIntervalMinutes: 1_440,
  status: "ready",
  cardAvailable: true,
  failures: 0,
  lastAttemptAt: Date.UTC(2026, 6, 19, 12),
  lastSuccessAt: Date.UTC(2026, 6, 19, 12),
  nextPollAt: Date.UTC(2026, 6, 19, 12, 30),
});

describe("channel feed admin startup-health projection", () => {
  it("preserves a started runtime control without sharing mutable references", () => {
    const source = control();
    const [projected] = projectChannelFeedAdminControls([source], true);

    expect(projected).toEqual(source);
    expect(projected).not.toBe(source);
    expect(projected?.publisher).not.toBe(source.publisher);
  });

  it("fails closed when the coordinator did not start", () => {
    const source = control();
    const [projected] = projectChannelFeedAdminControls([source], false);

    expect(projected).toMatchObject({
      id: "market-wire",
      channelId: "stock-market",
      available: false,
      enabled: true,
      status: "unavailable",
      cardAvailable: false,
      activeIntervalMinutes: 5,
      idleIntervalMinutes: 30,
    });
    expect(projected).not.toHaveProperty("nextPollAt");
    expect(source).toMatchObject({
      available: true,
      status: "ready",
      cardAvailable: true,
      nextPollAt: Date.UTC(2026, 6, 19, 12, 30),
    });
  });
});
