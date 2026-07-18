import { describe, expect, it } from "vitest";
import {
  activePersonaRoomAffinities,
  isAdminPath,
  normalizeAdminState,
  personaVoiceChoices,
} from "./adminModel";

describe("admin model boundary", () => {
  it("normalizes a wrapped compatible snapshot and clamps all percentage values", () => {
    const snapshot = normalizeAdminState({
      state: {
        behavior: {
          global: { activity: 140, competence: 72.4, aggression: -5, explicitness: "61" },
          channels: { lobby: { activity: 42 } },
        },
        automation: {
          autonomousLinkChannelIds: ["lobby"],
          autonomousResearch: {
            attempts: 9.8,
            published: 3,
            failed: 6,
            lastFailure: {
              channelId: "lobby",
              seedId: "lobby-news",
              reason: "source_read_failed",
              failedAt: 1_752_492_000_000,
              retryAfterAt: 1_752_492_120_000,
              consecutiveFailures: 2,
            },
          },
        },
        personas: [{
          id: "ai-mira",
          identity: { name: "Mira", role: "regular" },
          behaviorPrompt: "Keep it concrete.",
          sliders: { talkativeness: 105, warmth: 88 },
          researchEnabled: true,
          fictionalAdult: true,
          affinities: { lobby: 83 },
          voiceMappings: { sv: "sv-voice" },
        }],
        channels: [{
          id: "lobby",
          name: "lobby",
          topic: { brief: "community chat" },
          conversationGuidance: "Everyday language.",
          conversationRegister: "banter",
          ambientMode: "casual",
          ambientPremises: ["one", "one", "two"],
        }],
        humans: [{ memberId: "guest-1", name: "Johan", status: "online", recoveryConfigured: true }],
        bans: [{ id: "guest-2", name: "Nope", bannedAt: "2026-07-14T12:00:00Z" }],
        voiceOptions: { voices: [{ voiceId: "sv-voice", name: "Swedish", languageTags: ["sv"] }] },
      },
    });

    expect(snapshot.behavior.global).toEqual({
      activity: 100,
      autonomousLinkFrequency: 60,
      competence: 72,
      aggression: 0,
      explicitness: 61,
    });
    expect(snapshot.behavior.channels.lobby).toEqual({
      activity: 42,
      autonomousLinkFrequency: 60,
      competence: 72,
      aggression: 0,
      explicitness: 61,
    });
    expect(snapshot.automation).toEqual({
      autonomousLinkChannelIds: ["lobby"],
      autonomousResearch: {
        attempts: 9,
        published: 3,
        failed: 6,
        lastFailure: {
          channelId: "lobby",
          seedId: "lobby-news",
          reason: "source_read_failed",
          failedAt: 1_752_492_000_000,
          retryAfterAt: 1_752_492_120_000,
          consecutiveFailures: 2,
        },
      },
    });
    expect(snapshot.personas[0]).toMatchObject({
      id: "ai-mira",
      name: "Mira",
      role: "regular",
      prompt: "Keep it concrete.",
      canResearch: true,
      fictionalAdult: true,
      roomAffinities: { lobby: 83 },
      voices: { sv: "sv-voice" },
      core: { talkativeness: 100, warmth: 88 },
    });
    expect(snapshot.channels[0]).toMatchObject({
      topic: "community chat",
      guidance: "Everyday language.",
      register: "banter",
      mode: "casual",
      seeds: ["one", "two"],
    });
    expect(snapshot.voiceOptions).toEqual({
      languages: ["sv"],
      voices: [{ id: "sv-voice", label: "Swedish", languages: ["sv"] }],
    });
    expect(snapshot.humans[0]).toMatchObject({
      id: "guest-1",
      name: "Johan",
      status: "online",
      recoveryConfigured: true,
    });
  });

  it("fails closed when legacy persona snapshots omit the fictional-adult assertion", () => {
    const snapshot = normalizeAdminState({
      personas: [{ id: "ai-custom", name: "Custom" }],
    });
    expect(snapshot.personas[0]?.fictionalAdult).toBe(false);
  });

  it("selects only the admin pathname and descendants", () => {
    expect(isAdminPath("/admin")).toBe(true);
    expect(isAdminPath("/admin/personas")).toBe(true);
    expect(isAdminPath("/administrator")).toBe(false);
    expect(isAdminPath("/")).toBe(false);
  });

  it("preserves only explicit affinity overrides instead of materializing derived rooms as 50", () => {
    expect(activePersonaRoomAffinities(
      { lobby: 0, "ai-lab": 83, removed: 91 },
      [{ id: "lobby" }, { id: "ai-lab" }, { id: "the-pub" }],
    )).toEqual({ lobby: 0, "ai-lab": 83 });
    expect(activePersonaRoomAffinities(
      {},
      [{ id: "lobby" }, { id: "the-pub" }],
    )).toEqual({});
  });

  it("retains an unavailable or incompatible persisted voice as a disabled choice", () => {
    const voices = [
      { id: "lisa-warm", label: "Lisa warm", languages: ["sv"] },
      { id: "alloy", label: "Alloy", languages: ["en"] },
    ];

    expect(personaVoiceChoices(voices, "sv-SE", "alloy")).toEqual([
      { id: "lisa-warm", label: "Lisa warm", unavailable: false },
      { id: "alloy", label: "Alloy (unavailable)", unavailable: true },
    ]);
    expect(personaVoiceChoices([], "sv", "saved-provider-voice")).toEqual([
      { id: "saved-provider-voice", label: "saved-provider-voice (unavailable)", unavailable: true },
    ]);
    expect(personaVoiceChoices(voices, "en-US", "alloy")).toEqual([
      { id: "alloy", label: "Alloy", unavailable: false },
    ]);
  });
});
