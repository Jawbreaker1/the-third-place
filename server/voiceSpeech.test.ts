import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzePcmSpeechPresence,
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

const pcmWav = (frameAmplitudes: readonly number[], frequency = 220): Buffer => {
  const samplesPerFrame = 320;
  const sampleCount = frameAmplitudes.length * samplesPerFrame;
  const body = Buffer.alloc(44 + sampleCount * 2);
  body.write("RIFF", 0, "ascii");
  body.writeUInt32LE(36 + sampleCount * 2, 4);
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
  body.writeUInt32LE(sampleCount * 2, 40);
  let sampleIndex = 0;
  for (const amplitude of frameAmplitudes) {
    for (let frameSample = 0; frameSample < samplesPerFrame; frameSample += 1) {
      const value = amplitude * Math.sin((2 * Math.PI * frequency * sampleIndex) / 16_000);
      body.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32_767), 44 + sampleIndex * 2);
      sampleIndex += 1;
    }
  }
  return body;
};

const harmonicPcmWav = (frameAmplitudes: readonly number[], fundamental = 120): Buffer => {
  const samplesPerFrame = 320;
  const sampleCount = frameAmplitudes.length * samplesPerFrame;
  const body = Buffer.alloc(44 + sampleCount * 2);
  body.write("RIFF", 0, "ascii");
  body.writeUInt32LE(36 + sampleCount * 2, 4);
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
  body.writeUInt32LE(sampleCount * 2, 40);
  let sampleIndex = 0;
  for (const amplitude of frameAmplitudes) {
    for (let frameSample = 0; frameSample < samplesPerFrame; frameSample += 1) {
      const phase = (2 * Math.PI * fundamental * sampleIndex) / 16_000;
      const harmonicShape = (Math.sin(phase) + 0.7 * Math.sin(phase * 2) + 0.4 * Math.sin(phase * 3)) / 2.1;
      body.writeInt16LE(Math.round(Math.max(-1, Math.min(1, amplitude * harmonicShape)) * 32_767), 44 + sampleIndex * 2);
      sampleIndex += 1;
    }
  }
  return body;
};

const transientClusterPcmWav = (clickFrames: readonly number[], frameCount = 60): Buffer => {
  const samplesPerFrame = 320;
  const sampleCount = frameCount * samplesPerFrame;
  const body = Buffer.alloc(44 + sampleCount * 2);
  body.write("RIFF", 0, "ascii");
  body.writeUInt32LE(36 + sampleCount * 2, 4);
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
  body.writeUInt32LE(sampleCount * 2, 40);
  const clicks = new Set(clickFrames);
  let randomState = 0x1234_5678;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    const background = ((randomState >>> 0) / 0xffff_ffff - 0.5) * 0.0005;
    const frameIndex = Math.floor(sampleIndex / samplesPerFrame);
    const withinFrame = sampleIndex % samplesPerFrame;
    const impact = clicks.has(frameIndex) && withinFrame < 64
      ? (((randomState >>> 8) & 1) === 0 ? -1 : 1) * 0.24 * Math.exp(-withinFrame / 10)
      : 0;
    body.writeInt16LE(Math.round(Math.max(-1, Math.min(1, background + impact)) * 32_767), 44 + sampleIndex * 2);
  }
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

describe("normalized PCM speech presence", () => {
  it("rejects a low steady hum even when it is followed by room silence", () => {
    const humThenSilence = pcmWav([
      ...Array.from({ length: 35 }, () => 0.03),
      ...Array.from({ length: 25 }, () => 0.0005),
    ], 120);

    const evidence = analyzePcmSpeechPresence(humThenSilence);

    expect(evidence.classification).toBe("noise");
    expect(evidence.activeMs).toBeGreaterThan(100);
    expect(evidence.activeVariationDb).toBeLessThan(1);
    expect(evidence.stationaryToneRatio).toBeGreaterThan(0.9);
  });

  it("accepts a quiet amplitude-modulated utterance over a low noise floor", () => {
    const speechLike = pcmWav([
      0.006, 0.012, 0.024, 0.038, 0.02, 0.009,
      0.007, 0.018, 0.034, 0.026, 0.012, 0.006,
      0.008, 0.022, 0.04, 0.025, 0.01, 0.006,
      ...Array.from({ length: 24 }, () => 0.0008),
    ]);

    const evidence = analyzePcmSpeechPresence(speechLike);

    expect(evidence.classification).toBe("speech");
    expect(evidence.activeMs).toBeGreaterThanOrEqual(100);
    expect(evidence.dynamicRangeDb).toBeGreaterThan(5);
  });

  it("rejects a click without treating its peak as an utterance", () => {
    const click = pcmWav([
      ...Array.from({ length: 10 }, () => 0.0005),
      0.3,
      ...Array.from({ length: 25 }, () => 0.0005),
    ]);

    expect(analyzePcmSpeechPresence(click)).toMatchObject({ classification: "noise", activeMs: 20 });
  });

  it("passes ambiguous quiet and uniformly voiced clips to STT instead of hard-rejecting them", () => {
    const quietVoiced = pcmWav([
      ...Array.from({ length: 18 }, () => 0.003),
      ...Array.from({ length: 24 }, () => 0.0008),
    ]);
    const uninterruptedSteady = pcmWav(Array.from({ length: 60 }, () => 0.02), 140);
    const sustainedHarmonicVoice = harmonicPcmWav([
      ...Array.from({ length: 20 }, () => 0.03),
      ...Array.from({ length: 25 }, () => 0.0005),
    ]);
    const tinyShortSignal = pcmWav([
      ...Array.from({ length: 8 }, () => 0.0005),
      0.006,
      ...Array.from({ length: 24 }, () => 0.0005),
    ]);
    const fragmentedQuietEnvelope = pcmWav(Array.from(
      { length: 60 },
      (_value, frame) => [5, 10, 15, 20, 25, 30, 35, 40].includes(frame) ? 0.006 : 0.0005,
    ));

    expect(analyzePcmSpeechPresence(quietVoiced).classification).toBe("uncertain");
    expect(analyzePcmSpeechPresence(uninterruptedSteady).classification).toBe("uncertain");
    expect(analyzePcmSpeechPresence(sustainedHarmonicVoice).classification).toBe("uncertain");
    expect(analyzePcmSpeechPresence(tinyShortSignal).classification).toBe("uncertain");
    expect(analyzePcmSpeechPresence(fragmentedQuietEnvelope)).toMatchObject({
      classification: "uncertain",
      activeRunCount: 8,
    });
  });

  it("rejects uninterrupted 50/60 Hz mains hum and first harmonics using spectral evidence", () => {
    for (const frequency of [50, 60, 100, 120]) {
      const uninterruptedHum = pcmWav(Array.from({ length: 40 }, () => 0.03), frequency);
      const evidence = analyzePcmSpeechPresence(uninterruptedHum);

      expect(evidence.classification, `${frequency} Hz`).toBe("noise");
      expect(evidence.stationaryToneRatio, `${frequency} Hz`).toBeGreaterThan(0.9);
    }
  });

  it("leaves sparse high-crest keyboard-like clusters uncertain for neural VAD", () => {
    const typing = transientClusterPcmWav([5, 10, 15, 20, 25, 30, 35, 40]);
    const evidence = analyzePcmSpeechPresence(typing);

    expect(evidence.classification).toBe("uncertain");
    expect(evidence.activeRunCount).toBeGreaterThanOrEqual(3);
    expect(evidence.longestActiveRunMs).toBeLessThanOrEqual(80);
    expect(evidence.activeOccupancy).toBeLessThan(0.45);
    expect(evidence.activeMedianCrestRatio).toBeGreaterThan(2.8);
  });
});

describe("optional Silero STT preflight", () => {
  const configuredEnv = {
    STT_BASE_URL: "https://speech.test/v1",
    STT_MODEL: "whisper-test",
    STT_VAD_MODEL_PATH: "/models/ggml-silero-v6.2.0.bin",
  };
  const uncertainPresence = {
    classification: "uncertain" as const,
    activeMs: 0,
    noiseFloorRms: 0.001,
    highEnergyRms: 0.001,
    peakRms: 0.001,
    stationaryToneRatio: 0,
    activeRunCount: 0,
    longestActiveRunMs: 0,
    activeOccupancy: 0,
    activeMedianCrestRatio: 0,
    dynamicRangeDb: 0,
    activeVariationDb: 0,
  };

  it("rejects only an explicit zero-segment result and removes its private WAV", async () => {
    const root = await mkdtemp(join(tmpdir(), "third-place-vad-test-"));
    const normalizedBody = pcmWav(Array.from({ length: 12 }, () => 0));
    let providerCalls = 0;
    try {
      const runner: AudioProcessRunner = async (command, args, input, options) => {
        expect(command).toBe("whisper-vad-speech-segments");
        expect(input).toHaveLength(0);
        expect(options).toMatchObject({ timeoutMs: 5_000, maxOutputBytes: 64 * 1024 });
        expect(args).toContain("--no-prints");
        expect(args.slice(args.indexOf("--vad-threshold"), args.indexOf("--vad-threshold") + 2))
          .toEqual(["--vad-threshold", "0.5"]);
        expect(args.slice(args.indexOf("--vad-min-speech-duration-ms"), args.indexOf("--vad-min-speech-duration-ms") + 2))
          .toEqual(["--vad-min-speech-duration-ms", "100"]);
        const audioPath = args[args.indexOf("--file") + 1]!;
        expect(await readFile(audioPath)).toEqual(normalizedBody);
        return Buffer.from("Detected 0 speech segments:\n");
      };
      const service = new VoiceSpeechService({
        env: configuredEnv,
        sttVadRunner: runner,
        sttVadTempRoot: root,
        normalizer: {
          available: async () => true,
          normalize: async () => ({
            body: normalizedBody,
            mimeType: "audio/wav" as const,
            durationMs: 240,
            sampleRate: 16_000 as const,
            channels: 1 as const,
            speechPresence: uncertainPresence,
          }),
        },
        fetchImpl: (async () => {
          providerCalls += 1;
          return new Response(JSON.stringify({ text: "Thanks" }), {
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof fetch,
      });

      await expectVoiceError(
        service.transcribe({ audio: Buffer.from("noise"), mimeType: "audio/webm" }),
        "NO_SPEECH",
      );
      expect(providerCalls).toBe(0);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps confirmed local PCM noise ahead of the optional process", async () => {
    const root = await mkdtemp(join(tmpdir(), "third-place-vad-test-"));
    let vadCalls = 0;
    let providerCalls = 0;
    try {
      const service = new VoiceSpeechService({
        env: configuredEnv,
        sttVadTempRoot: root,
        sttVadRunner: async () => {
          vadCalls += 1;
          return Buffer.from("Detected 1 speech segment:\n");
        },
        normalizer: {
          available: async () => true,
          normalize: async () => ({
            body: wav(),
            mimeType: "audio/wav" as const,
            durationMs: 400,
            sampleRate: 16_000 as const,
            channels: 1 as const,
            speechPresence: { ...uncertainPresence, classification: "noise" as const },
          }),
        },
        fetchImpl: (async () => {
          providerCalls += 1;
          return new Response(JSON.stringify({ text: "not reached" }), {
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof fetch,
      });

      await expectVoiceError(
        service.transcribe({ audio: Buffer.from("confirmed-noise"), mimeType: "audio/webm" }),
        "NO_SPEECH",
      );
      expect(vadCalls).toBe(0);
      expect(providerCalls).toBe(0);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes a positive segment result to STT even when PCM evidence was conservative", async () => {
    const root = await mkdtemp(join(tmpdir(), "third-place-vad-test-"));
    let providerCalls = 0;
    try {
      const service = new VoiceSpeechService({
        env: configuredEnv,
        sttVadTempRoot: root,
        sttVadRunner: async () => Buffer.from("Detected 1 speech segment:\n0: 0.00 --> 0.22\n"),
        normalizer: {
          available: async () => true,
          normalize: async () => ({
            body: wav(),
            mimeType: "audio/wav" as const,
            durationMs: 220,
            sampleRate: 16_000 as const,
            channels: 1 as const,
            speechPresence: uncertainPresence,
          }),
        },
        fetchImpl: (async () => {
          providerCalls += 1;
          return new Response(JSON.stringify({ text: "Ja", language: "sv" }), {
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof fetch,
      });

      await expect(service.transcribe({ audio: Buffer.from("short-word"), mimeType: "audio/webm" }))
        .resolves.toMatchObject({ text: "Ja", language: "sv" });
      expect(providerCalls).toBe(1);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails open on CLI failure and malformed output without transcript phrase rules", async () => {
    const root = await mkdtemp(join(tmpdir(), "third-place-vad-test-"));
    let vadCalls = 0;
    let providerCalls = 0;
    try {
      const service = new VoiceSpeechService({
        env: configuredEnv,
        sttVadTempRoot: root,
        sttVadRunner: async () => {
          vadCalls += 1;
          if (vadCalls === 1) throw new Error("binary/model unavailable");
          return Buffer.from("unstructured output mentioning 0 but no CLI summary");
        },
        normalizer: {
          available: async () => true,
          normalize: async () => ({
            body: wav(),
            mimeType: "audio/wav" as const,
            durationMs: 400,
            sampleRate: 16_000 as const,
            channels: 1 as const,
            speechPresence: uncertainPresence,
          }),
        },
        fetchImpl: (async () => {
          providerCalls += 1;
          return new Response(JSON.stringify({ text: "Okej" }), {
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof fetch,
      });

      await expect(service.transcribe({ audio: Buffer.from("first"), mimeType: "audio/webm" }))
        .resolves.toMatchObject({ text: "Okej" });
      await expect(service.transcribe({ audio: Buffer.from("second"), mimeType: "audio/webm" }))
        .resolves.toMatchObject({ text: "Okej" });
      expect(providerCalls).toBe(2);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("propagates caller abort and still cleans the per-turn directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "third-place-vad-test-"));
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let providerCalls = 0;
    try {
      const runner: AudioProcessRunner = async (_command, _args, _input, options) =>
        await new Promise<Buffer>((_resolve, reject) => {
          const abort = () => reject(new Error("aborted"));
          if (options.signal?.aborted) abort();
          else options.signal?.addEventListener("abort", abort, { once: true });
          markStarted();
        });
      const service = new VoiceSpeechService({
        env: configuredEnv,
        sttVadRunner: runner,
        sttVadTempRoot: root,
        normalizer: fakeNormalizer,
        fetchImpl: (async () => {
          providerCalls += 1;
          return new Response(JSON.stringify({ text: "not reached" }), {
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof fetch,
      });

      const transcription = service.transcribe({
        audio: Buffer.from("audio"),
        mimeType: "audio/webm",
        signal: controller.signal,
      });
      await started;
      controller.abort();
      await expectVoiceError(transcription, "REQUEST_CANCELLED");
      expect(providerCalls).toBe(0);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("isolates concurrent WAV files and cleans both directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "third-place-vad-test-"));
    const firstWav = pcmWav(Array.from({ length: 8 }, () => 0.08), 220);
    const secondWav = pcmWav(Array.from({ length: 9 }, () => 0.1), 330);
    const paths: string[] = [];
    const bodies: Buffer[] = [];
    let releaseBoth!: () => void;
    const bothStarted = new Promise<void>((resolve) => { releaseBoth = resolve; });
    let providerCalls = 0;
    try {
      const runner: AudioProcessRunner = async (_command, args) => {
        const audioPath = args[args.indexOf("--file") + 1]!;
        paths.push(audioPath);
        bodies.push(await readFile(audioPath));
        if (paths.length === 2) releaseBoth();
        await bothStarted;
        return Buffer.from("Detected 1 speech segment:\n");
      };
      const service = new VoiceSpeechService({
        env: configuredEnv,
        sttVadRunner: runner,
        sttVadTempRoot: root,
        normalizer: {
          available: async () => true,
          normalize: async (body: Buffer) => ({
            body,
            mimeType: "audio/wav" as const,
            durationMs: 180,
            sampleRate: 16_000 as const,
            channels: 1 as const,
          }),
        },
        fetchImpl: (async () => {
          providerCalls += 1;
          return new Response(JSON.stringify({ text: "speech" }), {
            headers: { "Content-Type": "application/json" },
          });
        }) as typeof fetch,
      });

      await Promise.all([
        service.transcribe({ audio: firstWav, mimeType: "audio/wav" }),
        service.transcribe({ audio: secondWav, mimeType: "audio/wav" }),
      ]);
      expect(providerCalls).toBe(2);
      expect(new Set(paths).size).toBe(2);
      expect(bodies.some((body) => body.equals(firstWav))).toBe(true);
      expect(bodies.some((body) => body.equals(secondWav))).toBe(true);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
        language: "zh-Hant-TW-u-ca-chinese",
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
      language: "zh-Hant-TW-u-ca-chinese",
      prompt: " room context ",
    });

    expect(result.text).toHaveLength(4_000);
    expect(result.text).not.toContain("\u202e");
    expect(result.language).toBe("zh-Hant-TW");
    expect(result.segments?.[0]).toEqual({ startMs: 100, endMs: 700, text: "hej" });
    expect(seenAuthorization).toBe("Bearer test-secret");
    expect(seenContentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(seenMultipart).toContain('name="model"');
    expect(seenMultipart).toContain("whisper-test");
    expect(seenMultipart).toContain('filename="utterance.wav"');
    expect(seenMultipart).toContain('name="response_format"');
    expect(seenMultipart).toContain("verbose_json");
    expect(seenMultipart).toContain('name="language"');
    expect(seenMultipart).toContain("zh-Hant-TW");
  });

  it("drops acoustically empty PCM before calling the transcription provider", async () => {
    let providerCalls = 0;
    const service = new VoiceSpeechService({
      env: { STT_BASE_URL: "https://speech.test/v1", STT_MODEL: "whisper-test" },
      fetchImpl: (async () => {
        providerCalls += 1;
        return new Response(JSON.stringify({ text: "Thanks" }), {
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
      normalizer: {
        available: async () => true,
        normalize: async () => ({
          body: wav(),
          mimeType: "audio/wav" as const,
          durationMs: 800,
          sampleRate: 16_000 as const,
          channels: 1 as const,
          speechPresence: {
            classification: "noise",
            activeMs: 0,
            noiseFloorRms: 0.001,
            highEnergyRms: 0.001,
            peakRms: 0.001,
            stationaryToneRatio: 0,
            activeRunCount: 0,
            longestActiveRunMs: 0,
            activeOccupancy: 0,
            activeMedianCrestRatio: 0,
            dynamicRangeDb: 0,
            activeVariationDb: 0,
          },
        }),
      },
    });

    await expectVoiceError(
      service.transcribe({ audio: Buffer.from("hum"), mimeType: "audio/webm" }),
      "NO_SPEECH",
    );
    expect(providerCalls).toBe(0);
  });

  it("passes a quiet sustained ambiguous signal through to the transcription provider", async () => {
    const quietSustained = pcmWav([
      ...Array.from({ length: 18 }, () => 0.003),
      ...Array.from({ length: 24 }, () => 0.0008),
    ], 220);
    const speechPresence = analyzePcmSpeechPresence(quietSustained);
    let providerCalls = 0;
    const service = new VoiceSpeechService({
      env: { STT_BASE_URL: "https://speech.test/v1", STT_MODEL: "whisper-test" },
      fetchImpl: (async () => {
        providerCalls += 1;
        return new Response(JSON.stringify({ text: "Ja", language: "sv" }), {
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch,
      normalizer: {
        available: async () => true,
        normalize: async () => ({
          body: quietSustained,
          mimeType: "audio/wav" as const,
          durationMs: 840,
          sampleRate: 16_000 as const,
          channels: 1 as const,
          speechPresence,
        }),
      },
    });

    expect(speechPresence.classification).toBe("uncertain");
    await expect(service.transcribe({ audio: Buffer.from("quiet"), mimeType: "audio/webm" }))
      .resolves.toMatchObject({ text: "Ja", language: "sv" });
    expect(providerCalls).toBe(1);
  });

  it("requires poor or missing decode confidence before trusting Whisper no-speech probability", async () => {
    let responsePayload: unknown = {
      text: "Thanks",
      language: "en",
      segments: [{ start: 0, end: 0.4, text: "Thanks", no_speech_prob: 0.96, avg_logprob: -1.2 }],
    };
    const service = new VoiceSpeechService({
      env: { STT_BASE_URL: "https://speech.test/v1", STT_MODEL: "whisper-test" },
      fetchImpl: (async () => new Response(JSON.stringify(responsePayload), {
        headers: { "Content-Type": "application/json" },
      })) as typeof fetch,
      normalizer: fakeNormalizer,
    });

    await expectVoiceError(
      service.transcribe({ audio: Buffer.from("noise"), mimeType: "audio/webm" }),
      "NO_SPEECH",
    );

    responsePayload = {
      text: "Ja",
      language: "sv",
      segments: [{ start: 0, end: 0.2, text: "Ja", no_speech_prob: 0.96, avg_logprob: -0.1 }],
    };
    await expect(service.transcribe({ audio: Buffer.from("short-speech"), mimeType: "audio/webm" }))
      .resolves.toMatchObject({ text: "Ja", language: "sv" });

    responsePayload = {
      text: "Okej",
      language: "sv",
      segments: [{ start: 0, end: 0.35, text: "Okej", no_speech_prob: 0.85 }],
    };
    await expectVoiceError(
      service.transcribe({ audio: Buffer.from("uncertain-noise"), mimeType: "audio/webm" }),
      "NO_SPEECH",
    );
  });

  it.each(["Thanks", "Abrigada", "Obrigada", "ありがとう"])(
    "keeps confidently decoded speech regardless of transcript text: %s",
    async (text) => {
      const service = new VoiceSpeechService({
        env: { STT_BASE_URL: "https://speech.test/v1", STT_MODEL: "whisper-test" },
        fetchImpl: (async () => new Response(JSON.stringify({
          text,
          segments: [{ start: 0, end: 0.4, text, no_speech_prob: 0.02, avg_logprob: -0.05 }],
        }), { headers: { "Content-Type": "application/json" } })) as typeof fetch,
        normalizer: fakeNormalizer,
      });

      await expect(service.transcribe({ audio: Buffer.from("real-speech"), mimeType: "audio/webm" }))
        .resolves.toMatchObject({ text });
    },
  );

  it("removes only provider segments confidently marked as no-speech", async () => {
    const service = new VoiceSpeechService({
      env: { STT_BASE_URL: "https://speech.test/v1", STT_MODEL: "whisper-test" },
      fetchImpl: (async () => new Response(JSON.stringify({
        text: "Hej Thanks",
        language: "sv",
        segments: [
          { start: 0, end: 0.5, text: "Hej", no_speech_prob: 0.02, avg_logprob: -0.05 },
          { start: 0.5, end: 1, text: "Thanks", no_speech_prob: 0.92, avg_logprob: -1.2 },
        ],
      }), { headers: { "Content-Type": "application/json" } })) as typeof fetch,
      normalizer: fakeNormalizer,
    });

    await expect(service.transcribe({ audio: Buffer.from("speech"), mimeType: "audio/webm" }))
      .resolves.toEqual({
        text: "Hej",
        language: "sv",
        segments: [{ startMs: 0, endMs: 500, text: "Hej" }],
      });
  });

  it("normalizes exact Whisper language names without weakening BCP-47 validation", async () => {
    let providerLanguage: unknown;
    const mockedFetch = async (): Promise<Response> => new Response(JSON.stringify({
      text: "OK",
      language: providerLanguage,
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    const service = new VoiceSpeechService({
      env: { STT_BASE_URL: "https://speech.test/v1", STT_MODEL: "whisper-test" },
      fetchImpl: mockedFetch as typeof fetch,
      normalizer: fakeNormalizer,
    });

    for (const [raw, expected] of [
      ["english", "en"],
      ["Japanese", "ja"],
      [" arabic ", "ar"],
      ["welsh", "cy"],
      ["lao", "lo"],
      ["zh-Hant-TW-u-ca-chinese", "zh-Hant-TW"],
      ["sl-Latn-SI-rozaj-biske-1994-x-abcd", "sl-Latn-SI-rozaj-biske-1994"],
    ] as const) {
      providerLanguage = raw;
      expect((await service.transcribe({ audio: Buffer.from("audio"), mimeType: "audio/webm" })).language)
        .toBe(expected);
    }

    for (const raw of [undefined, null, "und", "not a whisper language", "x".repeat(100), 42]) {
      providerLanguage = raw;
      const result = await service.transcribe({ audio: Buffer.from("audio"), mimeType: "audio/webm" });
      expect(result).toEqual({ text: "OK" });
    }
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
        TTS_LANGUAGES: "sv,zh-Hant",
        TTS_FORMAT: "mp3",
        TTS_AUDIO_TTL_MS: "5000",
      },
      fetchImpl: mockedFetch as typeof fetch,
      normalizer: fakeNormalizer,
      now: () => now,
    });

    const metadata = await service.synthesize({
      roomId: "voice:lobby",
      text: " hej\u0000   där ",
      language: "sv-SE",
      speed: 1.15,
    });

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
      env: {
        TTS_BASE_URL: "https://speech.test/v1",
        TTS_MODEL: "tts-test",
        TTS_VOICE: "voice",
        TTS_LANGUAGES: "en",
      },
      fetchImpl: mockedFetch as typeof fetch,
      normalizer: fakeNormalizer,
    });

    await expectVoiceError(service.synthesize({ roomId: "voice:lobby", text: "hello", language: "en-US" }), "INVALID_PROVIDER_MIME");
    mode = "large";
    await expectVoiceError(service.synthesize({ roomId: "voice:lobby", text: "hello", language: "en-US" }), "PROVIDER_RESPONSE_TOO_LARGE");
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
      supportedLanguages: ["sv"],
    });
    await withPerCallVoice.synthesize({
      roomId: "room-1",
      text: "hej",
      language: "sv-SE",
      voice: "lisa-warm",
      format: "wav",
    });
    expect(requestedVoice).toBe("lisa-warm");
    await expectVoiceError(
      withPerCallVoice.synthesize({ roomId: "room-1", text: "hej", language: "sv-SE", voice: "nst-deep", format: "wav" }),
      "UNCONFIGURED_TTS_VOICE",
    );
  });

  it("keeps generic TTS default-deny until BCP-47 language ranges are explicit", async () => {
    const baseEnv = {
      TTS_BASE_URL: "https://speech.test/v1",
      TTS_MODEL: "generic-tts",
      TTS_VOICE: "provider-default",
    };
    const denied = new VoiceSpeechService({ env: baseEnv, normalizer: fakeNormalizer });
    expect((await denied.capabilities()).tts).toMatchObject({ available: false, supportedLanguages: [] });

    const configured = new VoiceSpeechService({
      env: { ...baseEnv, TTS_LANGUAGES: "zh-Hant,th" },
      normalizer: fakeNormalizer,
      fetchImpl: (async () => new Response("audio", { headers: { "Content-Type": "audio/mpeg" } })) as typeof fetch,
    });
    expect((await configured.capabilities()).tts).toMatchObject({
      available: true,
      supportedLanguages: ["zh-Hant", "th"],
    });
    await configured.synthesize({ roomId: "room-1", text: "您好", language: "zh-Hant-TW" });
    await expectVoiceError(
      configured.synthesize({ roomId: "room-1", text: "こんにちは", language: "ja-JP" }),
      "UNSUPPORTED_TTS_LANGUAGE",
    );
    await expectVoiceError(
      configured.synthesize({ roomId: "room-1", text: "unknown", language: "und" }),
      "UNSUPPORTED_TTS_LANGUAGE",
    );
  });

  it("rejects malformed or undetermined TTS language configuration", () => {
    const base = { TTS_BASE_URL: "https://speech.test/v1", TTS_MODEL: "generic", TTS_VOICE: "voice" };
    expect(() => new VoiceSpeechService({ env: { ...base, TTS_LANGUAGES: "und" }, normalizer: fakeNormalizer }))
      .toThrowError(expect.objectContaining({ code: "INVALID_TTS_LANGUAGES" }));
    expect(() => new VoiceSpeechService({ env: { ...base, TTS_LANGUAGES: "not_a_locale" }, normalizer: fakeNormalizer }))
      .toThrowError(expect.objectContaining({ code: "INVALID_TTS_LANGUAGES" }));
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
