import { describe, expect, it, vi } from "vitest";
import { ActorChannelRuntime } from "./actorChannels.js";
import { detectVoiceGroundingIssue, mentionsPersona, VoiceDirector, sanitizeSpokenLine } from "./voiceDirector.js";
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

  it("grounds Mira's exact text-versus-speech failure and supplies the complete live roster", async () => {
    const runtime = new VoiceRoomRuntime(["lobby"]);
    const created = runtime.createRoom("lobby", { socketId: "socket-jaw", memberId: "human-jaw", name: "Jaw_B" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(runtime.joinRoom(created.room.id, { socketId: "socket-lina", memberId: "human-lina", name: "Lina" }).ok).toBe(true);
    expect(runtime.inviteBot(created.room.id, "socket-jaw", { personaId: "ai-mira", name: "Mira" }).ok).toBe(true);
    runtime.setBotState(created.room.id, "ai-mira", "listening");
    const human = runtime.appendFinalTranscript(created.room.id, "human-jaw", "Jeg skriker vel ikke?", {
      utteranceOrigin: "microphone-stt",
    });
    expect(human.ok).toBe(true);
    if (!human.ok) return;

    let seenVoiceContext: Parameters<ConstructorParameters<typeof VoiceDirector>[0]["lm"]["generateScene"]>[0]["voiceContext"];
    const speeches: string[] = [];
    const director = new VoiceDirector({
      runtime,
      lm: {
        generateScene: async (request) => {
          seenVoiceContext = request.voiceContext;
          return [{
            personaId: "ai-mira",
            content: "Jo, det låter lite så på texten ändå.",
            source: "lm",
            sourceIds: [],
          }];
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
        transcriptFinal: () => undefined,
        aiSpeech: (payload) => speeches.push(payload.text),
        aiStop: () => undefined,
      },
    });

    director.onHumanFinal(human.entry);
    await settle();

    expect(seenVoiceContext).toEqual({
      latestSpeakerId: "human-jaw",
      latestUtteranceOrigin: "microphone-stt",
      acousticEvidenceAvailable: false,
      participants: [
        { memberId: "human-jaw", name: "Jaw_B", kind: "human" },
        { memberId: "human-lina", name: "Lina", kind: "human" },
        { memberId: "ai-mira", name: "Mira", kind: "ai" },
      ],
    });
    expect(speeches).toEqual([
      "Jag får orden via transkriberingen, inte en pålitlig volymnivå, så det kan jag faktiskt inte avgöra.",
    ]);
    expect(speeches[0]).not.toMatch(/på texten|du skriver|du skriker/iu);
    expect(runtime.getTranscript(created.room.id).at(-1)).toMatchObject({
      speakerId: "ai-mira",
      utteranceOrigin: "ai-tts",
    });
  });

  it("classifies written-medium illusions and unsupported acoustic claims deterministically", () => {
    expect(detectVoiceGroundingIssue(
      "Det är ju det här vi gör, vi läser vad du skriver.",
      "microphone-stt",
    )).toBe("written-medium");
    expect(detectVoiceGroundingIssue("Jo, det låter lite så på texten ändå.", "microphone-stt"))
      .toBe("written-medium");
    expect(detectVoiceGroundingIssue("Du skriker faktiskt ganska högt.", "microphone-stt"))
      .toBe("unsupported-acoustics");
    expect(detectVoiceGroundingIssue(
      "Jag kan inte avgöra om du skriker från transkriberingen.",
      "microphone-stt",
    )).toBeUndefined();
    expect(detectVoiceGroundingIssue("Jag hör frustrationen i din röst.", "microphone-stt"))
      .toBe("unsupported-acoustics");
    expect(detectVoiceGroundingIssue(
      "Jag kan inte avgöra om du skriker, men din röst låter arg.",
      "microphone-stt",
    )).toBe("unsupported-acoustics");
    expect(detectVoiceGroundingIssue("Stemmen din høres frustrert ut.", "microphone-stt"))
      .toBe("unsupported-acoustics");
    expect(detectVoiceGroundingIssue("Du låter som att du har en bra plan.", "microphone-stt"))
      .toBeUndefined();
    expect(detectVoiceGroundingIssue("Du skrev faktiskt det där.", "typed-voice-fallback"))
      .toBeUndefined();
  });

  it("aborts the previous room generation when a newer human utterance arrives", async () => {
    const runtime = new VoiceRoomRuntime(["lobby"]);
    const created = runtime.createRoom("lobby", { socketId: "socket-a", memberId: "human-a", name: "Alex" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(runtime.inviteBot(created.room.id, "socket-a", { personaId: "ai-sana", name: "Sana" }).ok).toBe(true);
    runtime.setBotState(created.room.id, "ai-sana", "listening");
    const first = runtime.appendFinalTranscript(created.room.id, "human-a", "Första försöket.");
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    let firstSignal: AbortSignal | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    let generationCount = 0;
    const speeches: string[] = [];
    const director = new VoiceDirector({
      runtime,
      lm: {
        generateScene: async (_request, _priority, signal) => {
          generationCount += 1;
          if (generationCount === 1) {
            firstSignal = signal;
            markFirstStarted?.();
            return await new Promise((resolve, reject) => {
              const fail = () => reject(signal?.reason ?? new Error("aborted"));
              if (signal?.aborted) fail();
              else signal?.addEventListener("abort", fail, { once: true });
            });
          }
          return [{ personaId: "ai-sana", content: "Det andra försöket kom fram.", source: "lm", sourceIds: [] }];
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
        transcriptFinal: () => undefined,
        aiSpeech: (payload) => speeches.push(payload.text),
        aiStop: () => undefined,
      },
    });

    director.onHumanFinal(first.entry);
    await firstStarted;
    const second = runtime.appendFinalTranscript(created.room.id, "human-a", "Andra försöket.");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    director.onHumanFinal(second.entry);
    await settle();

    expect(firstSignal?.aborted).toBe(true);
    expect(generationCount).toBe(2);
    expect(speeches).toEqual(["Det andra försöket kom fram."]);
  });

  it("coalesces close multi-human finals into one floor response", async () => {
    vi.useFakeTimers();
    try {
      const runtime = new VoiceRoomRuntime(["lobby"]);
      const created = runtime.createRoom("lobby", { socketId: "socket-a", memberId: "human-a", name: "Alex" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(runtime.joinRoom(created.room.id, { socketId: "socket-b", memberId: "human-b", name: "Bea" }).ok).toBe(true);
      expect(runtime.inviteBot(created.room.id, "socket-a", { personaId: "ai-sana", name: "Sana" }).ok).toBe(true);
      runtime.setBotState(created.room.id, "ai-sana", "listening");
      let generations = 0;
      let ingestPending = false;
      let seenAuthors: string[] = [];
      const director = new VoiceDirector({
        runtime,
        floorSilenceMs: 650,
        hasPendingHumanIngest: () => ingestPending,
        lm: {
          generateScene: async (request) => {
            generations += 1;
            seenAuthors = request.history.map((line) => line.author);
            return [{ personaId: "ai-sana", content: "Ni är inne på samma spår.", source: "lm", sourceIds: [] }];
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
          transcriptFinal: () => undefined,
          aiSpeech: () => undefined,
          aiStop: () => undefined,
        },
      });

      const first = runtime.appendFinalTranscript(created.room.id, "human-a", "Jag tänkte samma sak.");
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      director.onHumanFinal(first.entry);
      await vi.advanceTimersByTimeAsync(400);

      const second = runtime.appendFinalTranscript(created.room.id, "human-b", "Fast vi borde testa först.");
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      director.onHumanFinal(second.entry);
      await vi.advanceTimersByTimeAsync(649);
      expect(generations).toBe(0);
      ingestPending = true;
      expect(runtime.setHumanState(created.room.id, "socket-a", { speaking: true }).ok).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(500);
      expect(generations).toBe(0);
      expect(runtime.setHumanState(created.room.id, "socket-a", { speaking: false }).ok).toBe(true);
      await vi.advanceTimersByTimeAsync(250);
      expect(generations).toBe(0);
      ingestPending = false;
      await vi.advanceTimersByTimeAsync(250);

      expect(generations).toBe(1);
      expect(seenAuthors).toEqual(expect.arrayContaining(["Alex", "Bea"]));
    } finally {
      vi.useRealTimers();
    }
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
