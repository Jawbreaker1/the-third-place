import { describe, expect, it } from "vitest";
import { ActorChannelRuntime } from "./actorChannels.js";
import { mentionsPersona, VoiceDirector, sanitizeSpokenLine } from "./voiceDirector.js";
import { VoiceRoomRuntime } from "./voiceRooms.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("VoiceDirector", () => {
  it("turns one final human utterance into one bounded AI turn without recursion", async () => {
    const runtime = new VoiceRoomRuntime(["lobby"]);
    const created = runtime.createRoom("lobby", { socketId: "socket-a", memberId: "human-a", name: "Alex" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const invited = runtime.inviteBot(created.room.id, "socket-a", { personaId: "ai-sana", name: "Sana" });
    expect(invited.ok).toBe(true);
    runtime.setBotState(created.room.id, "ai-sana", "listening");
    const human = runtime.appendFinalTranscript(created.room.id, "human-a", "Sana, vad tycker du om den idén?");
    expect(human.ok).toBe(true);
    if (!human.ok) return;

    const transcripts: string[] = [];
    const speeches: string[] = [];
    let generated = 0;
    const director = new VoiceDirector({
      runtime,
      lm: {
        generateScene: async () => {
          generated += 1;
          return [{ personaId: "ai-sana", content: "**Bra grund.** Jag skulle testa den med fem användare först ✨ https://bad.invalid", source: "lm", sourceIds: [] }];
        },
      },
      speech: {
        capabilities: async () => ({
          stt: { available: false, provider: "disabled", inputMimeTypes: [] },
          tts: { available: false, provider: "disabled", formats: [] },
          normalizer: { available: false, maxInputBytes: 0, maxDurationMs: 0 },
          browserFallbackAllowed: true,
        }),
        synthesize: async () => { throw new Error("must not synthesize when disabled"); },
      },
      actorChannels: new ActorChannelRuntime(),
      events: {
        roomChanged: () => undefined,
        transcriptFinal: (entry) => transcripts.push(entry.text),
        aiSpeech: (payload) => speeches.push(payload.text),
        aiStop: () => undefined,
      },
    });

    director.onHumanFinal(human.entry);
    await settle();
    expect(generated).toBe(1);
    expect(transcripts).toEqual(["Bra grund. Jag skulle testa den med fem användare först"]);
    expect(speeches).toEqual(transcripts);
    const aiEntry = runtime.getTranscript(created.room.id).at(-1)!;
    expect(aiEntry.trigger).toEqual({ eligible: false, source: "ai-final" });
    director.onHumanFinal(aiEntry);
    await settle();
    expect(generated).toBe(1);
  });

  it("synthesizes with the resident's stable provider voice and publishes safe fallback controls", async () => {
    const runtime = new VoiceRoomRuntime(["lobby"]);
    const created = runtime.createRoom("lobby", { socketId: "socket-tts", memberId: "human-tts", name: "Alex" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(runtime.inviteBot(created.room.id, "socket-tts", { personaId: "ai-sana", name: "Sana" }).ok).toBe(true);
    runtime.setBotState(created.room.id, "ai-sana", "listening");
    const human = runtime.appendFinalTranscript(created.room.id, "human-tts", "Sana, säg något kort.");
    expect(human.ok).toBe(true);
    if (!human.ok) return;

    const syntheses: Array<Record<string, unknown>> = [];
    const payloads: Array<Record<string, unknown>> = [];
    const director = new VoiceDirector({
      runtime,
      lm: {
        generateScene: async () => [{ personaId: "ai-sana", content: "Absolut, jag hör dig.", source: "lm", sourceIds: [] }],
      },
      speech: {
        capabilities: async () => ({
          stt: { available: true, provider: "openai-compatible", inputMimeTypes: [] },
          tts: { available: true, provider: "openai-compatible", formats: ["wav"], defaultVoice: "lisa-warm" },
          normalizer: { available: true, maxInputBytes: 1, maxDurationMs: 1 },
          browserFallbackAllowed: false,
        }),
        synthesize: async (input) => {
          syntheses.push(input as unknown as Record<string, unknown>);
          return {
            id: "audio-id",
            roomId: created.room.id,
            mimeType: "audio/wav",
            bytes: 128,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          };
        },
      },
      actorChannels: new ActorChannelRuntime(),
      events: {
        roomChanged: () => undefined,
        transcriptFinal: () => undefined,
        aiSpeech: (payload) => payloads.push(payload as unknown as Record<string, unknown>),
        aiStop: () => undefined,
      },
    });

    director.onHumanFinal(human.entry);
    await settle();

    expect(syntheses).toHaveLength(1);
    expect(syntheses[0]).toMatchObject({
      roomId: created.room.id,
      text: "Absolut, jag hör dig.",
      voice: "lisa-warm",
      speed: 0.98,
    });
    expect(payloads).toEqual([expect.objectContaining({
      memberId: "ai-sana",
      audioUrl: `/api/voice/audio/audio-id?roomId=${created.room.id}`,
      mimeType: "audio/wav",
      browserFallbackAllowed: false,
      language: "sv-SE",
      browserRate: 0.97,
      browserPitch: 1,
    })]);
  });

  it("uses prior rapport for a voice reply and only strengthens that persona relationship", async () => {
    const runtime = new VoiceRoomRuntime(["lobby"]);
    const created = runtime.createRoom("lobby", { socketId: "socket-memory", memberId: "human-memory", name: "Kim" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const invited = runtime.inviteBot(created.room.id, "socket-memory", { personaId: "ai-sana", name: "Sana" });
    expect(invited.ok).toBe(true);
    runtime.setBotState(created.room.id, "ai-sana", "listening");
    const human = runtime.appendFinalTranscript(created.room.id, "human-memory", "Sana, minns du mig?");
    expect(human.ok).toBe(true);
    if (!human.ok) return;

    const callOrder: string[] = [];
    let sceneRelationshipNotes: Record<string, string> | undefined;
    const relationUpdates: Array<{ humanId: string; personaId: string; familiarity?: number }> = [];
    const director = new VoiceDirector({
      runtime,
      lm: {
        generateScene: async (request) => {
          callOrder.push("generate");
          sceneRelationshipNotes = request.relationshipNotes;
          return [{ personaId: "ai-sana", content: "Ja, lite faktiskt. Kul att höra dig igen.", source: "lm", sourceIds: [] }];
        },
      },
      speech: {
        capabilities: async () => ({
          stt: { available: false, provider: "disabled", inputMimeTypes: [] },
          tts: { available: false, provider: "disabled", formats: [] },
          normalizer: { available: false, maxInputBytes: 0, maxDurationMs: 0 },
          browserFallbackAllowed: true,
        }),
        synthesize: async () => { throw new Error("must not synthesize when disabled"); },
      },
      actorChannels: new ActorChannelRuntime(),
      humanMemory: {
        promptNote: (humanId, personaId) => {
          callOrder.push("promptNote");
          expect([humanId, personaId]).toEqual(["human-memory", "ai-sana"]);
          return "Fallible prior memory: Kim has visited before; keep recognition subtle.";
        },
        getRelation: () => {
          callOrder.push("getRelation");
          return { familiarity: 0.4, affinity: 0.2, irritation: 0, updatedAt: 1_000 };
        },
        updateRelation: (humanId, personaId, update) => {
          callOrder.push("updateRelation");
          relationUpdates.push({ humanId, personaId, ...update });
          return { familiarity: update.familiarity ?? 0.4, affinity: 0.2, irritation: 0, updatedAt: 2_000 };
        },
      },
      events: {
        roomChanged: () => undefined,
        transcriptFinal: () => undefined,
        aiSpeech: () => undefined,
        aiStop: () => undefined,
      },
    });

    director.onHumanFinal(human.entry);
    await settle();

    expect(sceneRelationshipNotes).toEqual({
      "ai-sana": "Fallible prior memory: Kim has visited before; keep recognition subtle.",
    });
    expect(relationUpdates).toEqual([{
      humanId: "human-memory",
      personaId: "ai-sana",
      familiarity: 0.45,
    }]);
    expect(callOrder).toEqual(["promptNote", "getRelation", "generate", "updateRelation"]);
  });

  it("removes written-only artifacts and bounds spoken output", () => {
    const words = Array.from({ length: 40 }, (_, index) => `ord${index}`).join(" ");
    const spoken = sanitizeSpokenLine(`# Rubrik\n[skrattar] ${words} 😀 https://example.com`);
    expect(spoken.split(/\s+/)).toHaveLength(25);
    expect(spoken).not.toMatch(/https?:|\[|#|😀/u);
  });

  it("matches complete persona names instead of substrings", () => {
    expect(mentionsPersona("Vale, vad tror du?", "Vale")).toBe(true);
    expect(mentionsPersona("@Bosse.exe kom hit", "Bosse.exe")).toBe(true);
    expect(mentionsPersona("Det svenska valet är snart", "Vale")).toBe(false);
    expect(mentionsPersona("That was beautiful", "Bea")).toBe(false);
  });
});
