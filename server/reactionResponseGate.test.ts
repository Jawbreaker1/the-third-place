import { describe, expect, it } from "vitest";
import {
  shouldStartHumanReactionResponse,
  type HumanReactionResponseGate,
} from "./director.js";

const openGate = (overrides: Partial<HumanReactionResponseGate> = {}): HumanReactionResponseGate => ({
  now: 100_000,
  humanCooldownMs: 24_000,
  messageCooldownMs: 75_000,
  modelConnected: true,
  queueDepth: 0,
  availableMessageSlots: 1,
  voiceRoomActive: false,
  alreadyInFlight: false,
  responseChance: 0.7,
  rng: () => 0.2,
  ...overrides,
});

describe("human reaction response gate", () => {
  it("allows one healthy, paced reaction response", () => {
    expect(shouldStartHumanReactionResponse(openGate())).toBe(true);
  });

  it.each([
    ["disconnected model", { modelConnected: false }],
    ["queued model work", { queueDepth: 1 }],
    ["exhausted message budget", { availableMessageSlots: 0 }],
    ["active voice room", { voiceRoomActive: true }],
    ["same resident already generating", { alreadyInFlight: true }],
  ] as const)("rejects %s", (_label, overrides) => {
    expect(shouldStartHumanReactionResponse(openGate(overrides))).toBe(false);
  });

  it("enforces both the human/channel and target-message cooldowns", () => {
    expect(shouldStartHumanReactionResponse(openGate({ lastHumanTurnAt: 99_999 }))).toBe(false);
    expect(shouldStartHumanReactionResponse(openGate({ lastMessageTurnAt: 99_999 }))).toBe(false);

    expect(shouldStartHumanReactionResponse(openGate({
      lastHumanTurnAt: 100_000 - 24_000,
      lastMessageTurnAt: 100_000 - 75_000,
    }))).toBe(true);
  });

  it("uses a bounded strict probability without consuming it through a content heuristic", () => {
    expect(shouldStartHumanReactionResponse(openGate({ responseChance: 2, rng: () => 0.999 }))).toBe(true);
    expect(shouldStartHumanReactionResponse(openGate({ responseChance: -1, rng: () => 0 }))).toBe(false);
    expect(shouldStartHumanReactionResponse(openGate({ responseChance: 0.5, rng: () => 0.5 }))).toBe(false);
  });
});
