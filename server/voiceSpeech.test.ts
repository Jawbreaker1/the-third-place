import { describe, expect, it } from "vitest";
import {
  AudioNormalizer,
  type AudioProcessRunner,
  TtsAudioStore,
  VoiceSpeechError,
  VoiceSpeechService,
} from "./voiceSpeech.js";

const wav = (): Buffer => {
  const body = Buffer.alloc(44);
  body.write("RIFF", 0, "ascii");
  body.writeUInt32LE(36, 4);
  body.write("WAVE", 8, "ascii");
  body.write("fmt ", 12, "ascii");
  body.writeUInt32LE(16, 16);
  body.writeUInt16LE(1, 20);
  body.writeUInt16LE(1, 22);
  body.writeUInt32LE(16_000, 24);
  body.writeUInt32LE(32_000, 28);
  body.writeUInt16LE(2, 32);
  body.writeUInt16LE(16, 34);
  body.write("data", 36, "ascii");
  body.writeUInt32LE(0, 40);
  return body;
};

const fakeNormalizer = {
  available: async () => true,
  normalize: async (body: Buffer) => ({
    body: Buffer.from(body.length > 0 ? wav() : body),
    mimeType: "audio/wav" as const,
    durationMs: 800,
    sampleRate: 16_000 as const,
    channels: 1 as const,
  }),
};

const expectVoiceError = async (promise: Promise<unknown>, code: string): Promise<VoiceSpeechError> => {
  try {
    await promise;
    throw new Error("Expected voice speech operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(VoiceSpeechError);
    expect((error as VoiceSpeechError).code).toBe(code);
    return error as VoiceSpeechError;
  }
};

describe("portable audio normalizer", () => {
  it("probes one audio stream and invokes ffmpeg with fixed pipe-only mono PCM arguments", async () => {
    const calls: Array<{ command: string; args: string[]; bytes: number }> = [];
    const runner: AudioProcessRunner = async (command, args, input) => {
      calls.push({ command, args, bytes: input.length });
      if (command === "probe") {
        return Buffer.from(JSON.stringify({ streams: [{ codec_type: "audio" }], format: { duration: "1.25" } }));
      }
      return wav();
    };
    const normalizer = new AudioNormalizer({ ffprobePath: "probe", ffmpegPath: "convert", runner });

    const normalized = await normalizer.normalize(Buffer.from("safe-container"), "audio/webm;codecs=opus");

    expect(normalized).toMatchObject({ mimeType: "audio/wav", durationMs: 1_250, sampleRate: 16_000, channels: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toContain("pipe:0");
    expect(calls[0]?.args.join(" ")).toContain("-protocol_whitelist pipe,data");
    expect(calls[1]?.args.join(" ")).toContain("-ac 1 -ar 16000");
    expect(calls[1]?.args).toContain("-vn");
    expect(calls[1]?.args.at(-1)).toBe("pipe:1");
  });

  it("rejects video and multiple-audio containers before decoding", async () => {
    let conversionCalls = 0;
    const runner: AudioProcessRunner = async (command) => {
      if (command === "probe") {
        return Buffer.from(JSON.stringify({ streams: [{ codec_type: "audio" }, { codec_type: "video" }] }));
      }
      conversionCalls += 1;
      return wav();
    };
    const normalizer = new AudioNormalizer({ ffprobePath: "probe", ffmpegPath: "convert", runner });

    await expectVoiceError(normalizer.normalize(Buffer.from("mixed"), "audio/mp4"), "INVALID_AUDIO_STREAMS");
    expect(conversionCalls).toBe(0);
  });

  it("bounds size, duration and declared MIME before expensive conversion", async () => {
    let calls = 0;
    const runner: AudioProcessRunner = async () => {
      calls += 1;
      return Buffer.from(JSON.stringify({ streams: [{ codec_type: "audio" }], format: { duration: "31" } }));
    };
    const normalizer = new AudioNormalizer({ runner });

    await expectVoiceError(normalizer.normalize(Buffer.alloc(6 * 1024 * 1024 + 1), "audio/webm"), "AUDIO_TOO_LARGE");
    await expectVoiceError(normalizer.normalize(Buffer.from("x"), "video/webm"), "UNSUPPORTED_AUDIO_TYPE");
    await expectVoiceError(normalizer.normalize(Buffer.from("x"), "audio/webm"), "AUDIO_TOO_LONG");
    expect(calls).toBe(1);
  });
});

describe("OpenAI-compatible speech providers", () => {
  it("disables providers cleanly when their independent configuration is absent", async () => {
    const service = new VoiceSpeechService({ env: {}, normalizer: { ...fakeNormalizer, available: async () => false } });

    const capabilities = await service.capabilities();

    expect(capabilities.stt).toMatchObject({ available: false, provider: "disabled" });
    expect(capabilities.tts).toMatchObject({ available: false, provider: "disabled" });
    expect(capabilities.normalizer.available).toBe(false);
    await expectVoiceError(
      service.transcribe({ audio: Buffer.from("x"), mimeType: "audio/webm" }),
      "STT_DISABLED",
    );
  });

  it("posts normalized WAV as multipart and sanitizes bounded transcription JSON", async () => {
    let seenAuthorization = "";
    let seenContentType = "";
    let seenMultipart = "";
    const mockedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toBe("/v1/audio/transcriptions");
      seenAuthorization = request.headers.get("authorization") ?? "";
      seenContentType = request.headers.get("content-type") ?? "";
      seenMultipart = await request.text();
      return new Response(JSON.stringify({
        text: `  hej\u202e    ${"x".repeat(4_100)}  `,
        language: "sv",
        segments: [{ start: 0.1, end: 0.7, text: " hej " }],
      }), { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } });
    };
    const service = new VoiceSpeechService({
      env: { STT_BASE_URL: "https://speech.test/v1", STT_MODEL: "whisper-test", STT_API_KEY: "test-secret" },
      fetchImpl: mockedFetch as typeof fetch,
      normalizer: fakeNormalizer,
    });

    const result = await service.transcribe({
      audio: Buffer.from("browser-audio"),
      mimeType: "audio/webm;codecs=opus",
      language: "sv",
      prompt: " room context ",
    });

    expect(result.text).toHaveLength(4_000);
    expect(result.text).not.toContain("\u202e");
    expect(result.language).toBe("sv");
    expect(result.segments?.[0]).toEqual({ startMs: 100, endMs: 700, text: "hej" });
    expect(seenAuthorization).toBe("Bearer test-secret");
    expect(seenContentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(seenMultipart).toContain('name="model"');
    expect(seenMultipart).toContain("whisper-test");
    expect(seenMultipart).toContain('filename="utterance.wav"');
    expect(seenMultipart).toContain('name="response_format"');
    expect(seenMultipart).toContain("json");
  });

  it("posts sanitized TTS JSON and stores audio behind room-scoped expiring lookup", async () => {
    let requestPayload: Record<string, unknown> = {};
    const mockedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toBe("/v1/audio/speech");
      requestPayload = JSON.parse(await request.text()) as Record<string, unknown>;
      return new Response("audio", { status: 200, headers: { "Content-Type": "audio/mpeg", "Content-Length": "5" } });
    };
    let now = Date.UTC(2026, 6, 13);
    const service = new VoiceSpeechService({
      env: {
        TTS_BASE_URL: "https://speech.test/v1",
        TTS_MODEL: "tts-test",
        TTS_VOICE: "mira-voice",
        TTS_FORMAT: "mp3",
        TTS_AUDIO_TTL_MS: "5000",
      },
      fetchImpl: mockedFetch as typeof fetch,
      normalizer: fakeNormalizer,
      now: () => now,
    });

    const metadata = await service.synthesize({ roomId: "voice:lobby", text: " hej\u0000   där ", speed: 1.15 });

    expect(requestPayload).toMatchObject({
      model: "tts-test",
      input: "hej där",
      voice: "mira-voice",
      response_format: "mp3",
      speed: 1.15,
    });
    expect(metadata).toMatchObject({ roomId: "voice:lobby", mimeType: "audio/mpeg", bytes: 5 });
    expect(service.lookupAudio(metadata.id, "voice:other")).toBeUndefined();
    expect(service.lookupAudio(metadata.id, "voice:lobby")?.body.toString()).toBe("audio");
    now += 5_001;
    expect(service.lookupAudio(metadata.id, "voice:lobby")).toBeUndefined();
  });

  it("rejects unexpected TTS MIME and announced oversized provider bodies", async () => {
    let mode: "mime" | "large" = "mime";
    const mockedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      await request.text();
      if (mode === "mime") {
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("x", {
        status: 200,
        headers: { "Content-Type": "audio/mpeg", "Content-Length": String(5 * 1024 * 1024) },
      });
    };
    const service = new VoiceSpeechService({
      env: { TTS_BASE_URL: "https://speech.test/v1", TTS_MODEL: "tts-test", TTS_VOICE: "voice" },
      fetchImpl: mockedFetch as typeof fetch,
      normalizer: fakeNormalizer,
    });

    await expectVoiceError(service.synthesize({ roomId: "voice:lobby", text: "hello" }), "INVALID_PROVIDER_MIME");
    mode = "large";
    await expectVoiceError(service.synthesize({ roomId: "voice:lobby", text: "hello" }), "PROVIDER_RESPONSE_TOO_LARGE");
  });

  it("rejects untrusted configured provider URL forms at construction", () => {
    expect(() => new VoiceSpeechService({
      env: { STT_BASE_URL: "https://user:pass@example.com/v1", STT_MODEL: "whisper" },
      normalizer: fakeNormalizer,
    })).toThrowError(VoiceSpeechError);
    expect(() => new VoiceSpeechService({
      env: { TTS_BASE_URL: "file:///tmp/speech", TTS_MODEL: "tts" },
      normalizer: fakeNormalizer,
    })).toThrowError(VoiceSpeechError);
    expect(() => new VoiceSpeechService({
      env: { TTS_BASE_URL: "http://speech.example/v1", TTS_MODEL: "tts", TTS_VOICE: "voice" },
      normalizer: fakeNormalizer,
    })).toThrowError(expect.objectContaining({ code: "INSECURE_PROVIDER_URL" }));
  });

  it("only advertises TTS when a usable default or per-call voice is configured", async () => {
    const env = { TTS_BASE_URL: "http://127.0.0.1:8179/v1", TTS_MODEL: "piper-sv", TTS_FORMAT: "wav" };
    const missingVoice = new VoiceSpeechService({ env, normalizer: fakeNormalizer });
    expect((await missingVoice.capabilities()).tts).toMatchObject({ available: false, provider: "disabled" });
    await expectVoiceError(missingVoice.synthesize({ roomId: "room-1", text: "hej", voice: "lisa" }), "TTS_DISABLED");

    let requestedVoice = "";
    const withPerCallVoice = new VoiceSpeechService({
      env,
      ttsVoices: ["lisa-warm"],
      normalizer: fakeNormalizer,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        requestedVoice = (JSON.parse(await request.text()) as { voice: string }).voice;
        return new Response("wav", { headers: { "Content-Type": "audio/wav" } });
      }) as typeof fetch,
    });
    expect((await withPerCallVoice.capabilities()).tts).toMatchObject({
      available: true,
      provider: "openai-compatible",
      model: "piper-sv",
    });
    await withPerCallVoice.synthesize({ roomId: "room-1", text: "hej", voice: "lisa-warm", format: "wav" });
    expect(requestedVoice).toBe("lisa-warm");
    await expectVoiceError(
      withPerCallVoice.synthesize({ roomId: "room-1", text: "hej", voice: "nst-deep", format: "wav" }),
      "UNCONFIGURED_TTS_VOICE",
    );
  });
});

describe("TTS audio store", () => {
  it("copies buffers and requires the authenticated room scope", () => {
    const store = new TtsAudioStore(60_000, () => Date.UTC(2026, 6, 13));
    const original = Buffer.from("voice");
    const metadata = store.put("room-1", "audio/mpeg", original);
    original.fill(0);

    const first = store.get(metadata.id, "room-1");
    expect(first?.body.toString()).toBe("voice");
    expect(store.get(metadata.id, "room-2")).toBeUndefined();
    first?.body.fill(0);
    expect(store.get(metadata.id, "room-1")?.body.toString()).toBe("voice");
  });
});
