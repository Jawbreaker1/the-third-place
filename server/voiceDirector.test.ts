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
