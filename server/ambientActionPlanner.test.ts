import { describe, expect, it } from "vitest";
import {
  ambientActionInstruction,
  decideAmbientAction,
  sampleAmbientEpisodeShape,
  type AmbientActionKind,
} from "./ambientActionPlanner.js";

describe("ambient action planner", () => {
  it("samples varied bounded shapes instead of one signature thread length", () => {
    const shapes = [0, 0.2, 0.45, 0.7, 0.9, 0.999].map((roll) =>
      sampleAmbientEpisodeShape({
        origin: "room_seed",
        mode: "casual",
        debateBeat: false,
        rng: () => roll,
      }),
    );
    expect(new Set(shapes.map((shape) => shape.softTargetMessages)).size).toBeGreaterThanOrEqual(4);
    expect(shapes.every((shape) => shape.minimumMessages >= 1)).toBe(true);
    expect(shapes.every((shape) => shape.hardMaximumMessages <= 8)).toBe(true);
  });

  it("keeps research, human and external-agent continuations alive beyond their published opening", () => {
    const research = sampleAmbientEpisodeShape({
      origin: "autonomous_research",
      mode: "discussion",
      debateBeat: true,
      alreadyPublished: 2,
      rng: () => 0,
    });
    const human = sampleAmbientEpisodeShape({
      origin: "human_topic",
      mode: "casual",
      debateBeat: false,
      alreadyPublished: 2,
      rng: () => 0,
    });
    const externalAgent = sampleAmbientEpisodeShape({
      origin: "external_agent_topic",
      mode: "casual",
      debateBeat: false,
      alreadyPublished: 2,
      rng: () => 0,
    });
    expect(research.minimumMessages).toBeGreaterThan(2);
    expect(human.minimumMessages).toBeGreaterThan(2);
    expect(externalAgent).toEqual(human);
  });

  it("gives a typed channel-feed episode room for a grounded follow-up", () => {
    const feed = sampleAmbientEpisodeShape({
      origin: "channel_feed",
      mode: "discussion",
      debateBeat: false,
      rng: () => 0,
    });

    expect(feed.minimumMessages).toBe(2);
    expect(feed.softTargetMessages).toBeGreaterThanOrEqual(2);
    expect(feed.hardMaximumMessages).toBeGreaterThan(feed.softTargetMessages);
  });

  it("opens without a reply target and then uses one non-repeating action per tick", () => {
    const shape = { minimumMessages: 3, softTargetMessages: 4, hardMaximumMessages: 6 };
    const opening = decideAmbientAction({
      messageCount: 0,
      shape,
      origin: "room_seed",
      mode: "discussion",
      debateBeat: true,
      hasResearch: false,
      hasOpenHook: true,
      previousActions: [],
      rng: () => 0,
    });
    expect(opening).toMatchObject({ kind: "open_topic", continueEpisode: true, replyToLatest: false });

    const previousActions: AmbientActionKind[] = ["open_topic"];
    const next = decideAmbientAction({
      messageCount: 1,
      shape,
      origin: "room_seed",
      mode: "discussion",
      debateBeat: true,
      hasResearch: false,
      hasOpenHook: true,
      previousActions,
      rng: () => 0,
    });
    expect(next).toMatchObject({ kind: "countertake", continueEpisode: true, replyToLatest: true });
    expect(next.kind).not.toBe(previousActions.at(-1));
  });

  it("allows natural silence after the soft target and always stops at the hard cap", () => {
    const shape = { minimumMessages: 1, softTargetMessages: 2, hardMaximumMessages: 4 };
    const quiet = decideAmbientAction({
      messageCount: 2,
      shape,
      origin: "room_seed",
      mode: "banter",
      debateBeat: false,
      hasResearch: false,
      hasOpenHook: false,
      previousActions: ["open_topic", "specific_example"],
      rng: () => 0.99,
    });
    const capped = decideAmbientAction({
      messageCount: 4,
      shape,
      origin: "room_seed",
      mode: "banter",
      debateBeat: false,
      hasResearch: false,
      hasOpenHook: true,
      previousActions: ["open_topic", "specific_example"],
      rng: () => 0,
    });
    expect(quiet.continueEpisode).toBe(false);
    expect(capped.continueEpisode).toBe(false);
  });

  it("uses source material as a conversational move rather than an announcement", () => {
    const decision = decideAmbientAction({
      messageCount: 2,
      shape: { minimumMessages: 3, softTargetMessages: 4, hardMaximumMessages: 6 },
      origin: "autonomous_research",
      mode: "discussion",
      debateBeat: false,
      hasResearch: true,
      hasOpenHook: true,
      previousActions: ["open_topic"],
      rng: () => 0,
    });
    expect(decision.kind).toBe("source_followup");
    expect(ambientActionInstruction(decision.kind, "discussion")).toContain("supported consequence");
    expect(ambientActionInstruction(decision.kind, "discussion")).not.toContain("share a link");
  });
});
