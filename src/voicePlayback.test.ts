import { describe, expect, it } from "vitest";
import {
  VoicePlaybackController,
  type VoiceAiSpeechPayload,
  type VoicePlaybackAudio,
  type VoicePlaybackEnvironment,
  type VoicePlaybackSpeechSynthesis,
  type VoicePlaybackUtterance,
  type VoicePlaybackVoice,
} from "./voicePlayback";

class FakeAudio implements VoicePlaybackAudio {
  src = "";
  preload = "";
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  playAttempts = 0;
  pauseAttempts = 0;
  outcomes: Array<"ok" | "blocked" | "failed" | "pending"> = ["ok"];

  constructor(private readonly playable = true) {}

  async play(): Promise<void> {
    const outcome = this.outcomes[Math.min(this.playAttempts, this.outcomes.length - 1)] ?? "ok";
    this.playAttempts += 1;
    if (outcome === "blocked") throw { name: "NotAllowedError" };
    if (outcome === "failed") throw new Error("decode failed");
    if (outcome === "pending") await new Promise<void>(() => undefined);
  }

  pause(): void {
    this.pauseAttempts += 1;
  }

  canPlayType(): string {
    return this.playable ? "probably" : "";
  }

  finish(): void {
    this.onended?.();
  }
}

class FakeUtterance implements VoicePlaybackUtterance {
  lang = "";
  pitch = 1;
  rate = 1;
  voice: VoicePlaybackVoice | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;

  constructor(readonly text: string) {}
}

class FakeSynthesis implements VoicePlaybackSpeechSynthesis {
  pending = false;
  speaking = false;
  cancelCount = 0;
  resumeCount = 0;
  readonly spoken: FakeUtterance[] = [];
  blockAttempts = 0;

  constructor(private readonly voices: VoicePlaybackVoice[] = []) {}

  cancel(): void {
    this.cancelCount += 1;
    this.pending = false;
    this.speaking = false;
  }

  getVoices(): VoicePlaybackVoice[] {
    return [...this.voices];
  }

  pause(): void {}

  resume(): void {
    this.resumeCount += 1;
  }

  speak(utterance: VoicePlaybackUtterance): void {
    const fake = utterance as FakeUtterance;
    this.spoken.push(fake);
    if (this.blockAttempts > 0) {
      this.blockAttempts -= 1;
      fake.onerror?.({ error: "not-allowed" });
      return;
    }
    this.pending = false;
    this.speaking = true;
    fake.onstart?.();
  }

  finish(): void {
    this.speaking = false;
    this.spoken.at(-1)?.onend?.();
  }
}

const speech = (id: string, overrides: Partial<VoiceAiSpeechPayload> = {}): VoiceAiSpeechPayload => ({
  roomId: "room-1",
  memberId: "ai-sana",
  text: `line ${id}`,
  utteranceId: id,
  audioUrl: `/api/voice/audio/${id}?roomId=room-1`,
  mimeType: "audio/mpeg",
  browserFallbackAllowed: true,
  ...overrides,
});

const environment = (options: {
  playable?: boolean;
  synthesis?: FakeSynthesis;
  audioSetup?: (audio: FakeAudio) => void;
} = {}) => {
  const audios: FakeAudio[] = [];
  const utterances: FakeUtterance[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const value: VoicePlaybackEnvironment = {
    origin: "https://third-place.test",
    defaultLanguage: "en-US",
    createAudio: () => {
      const audio = new FakeAudio(options.playable ?? true);
      options.audioSetup?.(audio);
      audios.push(audio);
      return audio;
    },
    ...(options.synthesis
      ? {
          speechSynthesis: options.synthesis,
          createUtterance: (text: string) => {
            const utterance = new FakeUtterance(text);
            utterances.push(utterance);
            return utterance;
          },
        }
      : {}),
    setTimer: (callback) => {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  };
  const runNextTimer = () => {
    const next = timers.entries().next().value as [number, () => void] | undefined;
    if (!next) throw new Error("Expected a pending playback timer");
    timers.delete(next[0]);
    next[1]();
  };
  return { value, audios, utterances, timers, runNextTimer };
};

const settle = async () => await Promise.resolve();

describe("VoicePlaybackController", () => {
  it("plays AI clips FIFO without overlap", async () => {
    const fake = environment();
    const controller = new VoicePlaybackController(fake.value);

    expect(controller.enqueue(speech("one"))).toBe(true);
    expect(controller.enqueue(speech("two"))).toBe(true);
    await settle();
    expect(fake.audios).toHaveLength(1);
    expect(fake.audios[0]?.playAttempts).toBe(1);

    fake.audios[0]?.finish();
    await settle();
    expect(fake.audios).toHaveLength(2);
    expect(fake.audios[1]?.playAttempts).toBe(1);
  });

  it("deduplicates recovered utterances with a bounded seen window", () => {
    const unavailable: string[] = [];
    const fake = environment();
    const controller = new VoicePlaybackController(fake.value, {
      onUnavailable: (item) => unavailable.push(item.utteranceId),
    }, 2);
    const silent = { audioUrl: undefined, browserFallbackAllowed: false };

    expect(controller.enqueue(speech("one", silent))).toBe(true);
    expect(controller.enqueue(speech("one", silent))).toBe(false);
    expect(controller.enqueue(speech("two", silent))).toBe(true);
    expect(controller.enqueue(speech("three", silent))).toBe(true);
    expect(controller.enqueue(speech("one", silent))).toBe(true);
    expect(unavailable).toEqual(["one", "two", "three", "one"]);
  });

  it("rejects cross-origin audio and obeys a disabled browser fallback", () => {
    const unavailable: string[] = [];
    const fake = environment();
    const controller = new VoicePlaybackController(fake.value, {
      onUnavailable: (_item, reason) => unavailable.push(reason),
    });

    controller.enqueue(speech("unsafe", {
      audioUrl: "https://attacker.invalid/voice.mp3",
      browserFallbackAllowed: false,
    }));

    expect(fake.audios).toHaveLength(0);
    expect(unavailable).toEqual(["browser fallback disabled"]);
  });

  it("uses a stable matching browser voice and the supplied language profile when MIME is unsupported", () => {
    const voices: VoicePlaybackVoice[] = [
      { default: false, lang: "sv-SE", localService: true, name: "Sven", voiceURI: "voice-b" },
      { default: false, lang: "sv-SE", localService: true, name: "Alva", voiceURI: "voice-a" },
      { default: true, lang: "en-US", localService: true, name: "English", voiceURI: "voice-en" },
    ];
    const synthesis = new FakeSynthesis(voices);
    const fake = environment({ playable: false, synthesis });
    const controller = new VoicePlaybackController(fake.value);

    controller.enqueue(speech("fallback", {
      language: "sv-SE",
      browserRate: 1.17,
      browserPitch: 0.88,
    }));

    expect(synthesis.spoken).toHaveLength(1);
    const utterance = synthesis.spoken[0]!;
    expect(utterance.lang).toBe("sv-SE");
    expect(utterance.rate).toBe(1.17);
    expect(utterance.pitch).toBe(0.88);
    expect(utterance.voice?.lang).toBe("sv-SE");
  });

  it("keeps blocked server audio active and retries it from a later user gesture", async () => {
    const blocked: boolean[] = [];
    const synthesis = new FakeSynthesis();
    const fake = environment({
      synthesis,
      audioSetup: (audio) => { audio.outcomes = ["blocked", "ok"]; },
    });
    const controller = new VoicePlaybackController(fake.value, {
      onAutoplayBlocked: (value) => blocked.push(value),
    });

    controller.enqueue(speech("blocked"));
    await settle();
    expect(blocked.at(-1)).toBe(true);
    expect(synthesis.spoken).toHaveLength(0);

    expect(await controller.retryBlocked()).toBe(true);
    expect(fake.audios[0]?.playAttempts).toBe(2);
    expect(blocked.at(-1)).toBe(false);
    expect(synthesis.spoken).toHaveLength(0);
  });

  it("recreates a browser fallback utterance after the user enables sound", async () => {
    const blocked: boolean[] = [];
    const synthesis = new FakeSynthesis();
    synthesis.blockAttempts = 1;
    const fake = environment({ synthesis });
    const controller = new VoicePlaybackController(fake.value, {
      onAutoplayBlocked: (value) => blocked.push(value),
    });

    controller.enqueue(speech("browser-blocked", { audioUrl: undefined }));
    expect(synthesis.spoken).toHaveLength(1);
    expect(blocked.at(-1)).toBe(true);

    expect(await controller.retryBlocked()).toBe(true);
    expect(synthesis.resumeCount).toBe(1);
    expect(synthesis.spoken).toHaveLength(2);
    expect(blocked.at(-1)).toBe(false);
  });

  it("advances the FIFO when playing server audio never emits ended or error", async () => {
    const fake = environment();
    const controller = new VoicePlaybackController(fake.value);
    controller.enqueue(speech("stuck-server"));
    controller.enqueue(speech("next-server"));
    await settle();
    expect(fake.audios).toHaveLength(1);
    expect(fake.timers.size).toBe(1);
    const staleEnded = fake.audios[0]?.onended;

    fake.runNextTimer();
    await settle();
    expect(fake.audios).toHaveLength(2);

    staleEnded?.();
    await settle();
    expect(fake.audios).toHaveLength(2);
  });

  it("cancels stuck browser speech before advancing to the next utterance", () => {
    const synthesis = new FakeSynthesis();
    const fake = environment({ synthesis });
    const controller = new VoicePlaybackController(fake.value);
    controller.enqueue(speech("stuck-browser", { audioUrl: undefined }));
    controller.enqueue(speech("next-browser", { audioUrl: undefined }));
    expect(synthesis.spoken).toHaveLength(1);
    expect(fake.timers.size).toBe(1);

    fake.runNextTimer();
    expect(synthesis.spoken).toHaveLength(2);
    expect(synthesis.cancelCount).toBeGreaterThanOrEqual(3);
  });

  it("falls through a server play promise that never settles", () => {
    let created = 0;
    const fake = environment({
      audioSetup: (audio) => {
        if (created === 0) audio.outcomes = ["pending"];
        created += 1;
      },
    });
    const controller = new VoicePlaybackController(fake.value);
    controller.enqueue(speech("never-starts", { browserFallbackAllowed: false }));
    controller.enqueue(speech("after-never-starts"));
    expect(fake.audios).toHaveLength(1);
    expect(fake.timers.size).toBe(1);

    fake.runNextTimer();
    expect(fake.audios).toHaveLength(2);
  });

  it("cleans the active clip and queued turns on barge-in or deafen", async () => {
    const fake = environment();
    const controller = new VoicePlaybackController(fake.value);
    controller.enqueue(speech("active"));
    controller.enqueue(speech("queued"));
    await settle();

    controller.bargeIn();
    expect(fake.audios).toHaveLength(1);
    expect(fake.audios[0]?.pauseAttempts).toBeGreaterThan(0);
    expect(fake.audios[0]?.src).toBe("");

    controller.setDeafened(true);
    expect(controller.enqueue(speech("deafened"))).toBe(false);
    controller.setDeafened(false);
    expect(fake.audios).toHaveLength(1);
  });
});
