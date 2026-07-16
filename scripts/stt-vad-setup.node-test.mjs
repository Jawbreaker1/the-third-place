import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  STT_VAD_MODEL,
  installSttVadModel,
  isVerifiedModelFile,
  resolveSttVadCacheDir,
} from "./setup-stt-vad.mjs";

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const fixtureModel = (body, overrides = {}) => ({
  filename: "fixture-vad.bin",
  url: "https://models.test/fixture-vad.bin",
  bytes: body.byteLength,
  sha256: createHash("sha256").update(body).digest("hex"),
  ...overrides,
});

const chunkedResponse = (body, options = {}) => new Response(new ReadableStream({
  start(controller) {
    const split = Math.max(1, Math.floor(body.byteLength / 3));
    for (let offset = 0; offset < body.byteLength; offset += split) {
      controller.enqueue(body.subarray(offset, Math.min(body.byteLength, offset + split)));
    }
    controller.close();
  },
}), {
  status: options.status ?? 200,
  headers: { "Content-Length": String(options.contentLength ?? body.byteLength) },
});

const silentLogger = { log() {} };

describe("Silero VAD model manifest", () => {
  it("pins the official model by URL, byte size and SHA-256", () => {
    const url = new URL(STT_VAD_MODEL.url);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "huggingface.co");
    assert.equal(url.pathname, "/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin");
    assert.equal(STT_VAD_MODEL.filename, "ggml-silero-v6.2.0.bin");
    assert.equal(STT_VAD_MODEL.bytes, 885_098);
    assert.equal(STT_VAD_MODEL.sha256, "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987");
  });
});

describe("STT VAD cache resolution", () => {
  it("honours explicit relative, absolute and home-relative cache paths", () => {
    const repository = resolve(tmpdir(), "workspace", "the-third-place");
    const home = resolve(tmpdir(), "test-home");
    const absoluteCache = resolve(tmpdir(), "absolute-custom-vad");
    assert.equal(
      resolveSttVadCacheDir(repository, { STT_VAD_CACHE_DIR: ".cache/custom-vad" }, { homeDir: home, platform: "linux" }),
      join(repository, ".cache", "custom-vad"),
    );
    assert.equal(
      resolveSttVadCacheDir(repository, { STT_VAD_CACHE_DIR: absoluteCache }, { homeDir: home, platform: "linux" }),
      absoluteCache,
    );
    assert.equal(
      resolveSttVadCacheDir(repository, { STT_VAD_CACHE_DIR: "~/custom-vad" }, { homeDir: home, platform: "linux" }),
      join(home, "custom-vad"),
    );
  });

  it("uses platform cache conventions and XDG_CACHE_HOME", () => {
    const repository = resolve(tmpdir(), "workspace", "the-third-place");
    const home = resolve(tmpdir(), "test-home");
    const xdgCache = resolve(tmpdir(), "xdg-cache");
    assert.equal(
      resolveSttVadCacheDir(repository, {}, { homeDir: home, platform: "darwin" }),
      join(home, "Library", "Caches", "the-third-place", "stt-vad"),
    );
    assert.equal(
      resolveSttVadCacheDir(repository, { XDG_CACHE_HOME: xdgCache }, { homeDir: home, platform: "linux" }),
      join(xdgCache, "the-third-place", "stt-vad"),
    );
  });
});

describe("STT VAD model installation", () => {
  it("streams, verifies and atomically installs a private model file", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "third-place-stt-vad-"));
    temporaryDirectories.push(cacheDir);
    const body = Buffer.from("small deterministic VAD fixture streamed in chunks");
    const model = fixtureModel(body);
    let requestedUrl;
    const logs = [];
    const result = await installSttVadModel({
      cacheDir,
      model,
      fetchImpl: async (url) => {
        requestedUrl = url;
        return chunkedResponse(body);
      },
      logger: { log: (line) => logs.push(line) },
    });

    assert.equal(requestedUrl, model.url);
    assert.deepEqual(result, { path: join(cacheDir, model.filename), cached: false });
    assert.equal(logs.at(-1), `[setup:stt-vad] model path: ${result.path}`);
    assert.deepEqual(await readFile(result.path), body);
    assert.equal(await isVerifiedModelFile(result.path, model), true);
    if (process.platform !== "win32") {
      assert.equal((await lstat(result.path)).mode & 0o777, 0o600);
    }
    assert.deepEqual((await readdir(cacheDir)).filter((entry) => entry.includes(".part-")), []);
  });

  it("reuses a verified cache without touching the network", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "third-place-stt-vad-cache-"));
    temporaryDirectories.push(cacheDir);
    const body = Buffer.from("already verified model");
    const model = fixtureModel(body);
    await writeFile(join(cacheDir, model.filename), body, { mode: 0o644 });
    let fetchCalls = 0;

    const result = await installSttVadModel({
      cacheDir,
      model,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("network must not be used");
      },
      logger: silentLogger,
    });

    assert.equal(result.cached, true);
    assert.equal(fetchCalls, 0);
    if (process.platform !== "win32") {
      assert.equal((await lstat(result.path)).mode & 0o777, 0o600);
    }
  });

  it("rejects oversized or corrupt downloads, cleans temporary files and preserves the old destination", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "third-place-stt-vad-reject-"));
    temporaryDirectories.push(cacheDir);
    const expected = Buffer.from("expected model");
    const old = Buffer.from("old corrupt cache");
    const model = fixtureModel(expected);
    const destination = join(cacheDir, model.filename);
    await writeFile(destination, old);

    await assert.rejects(
      installSttVadModel({
        cacheDir,
        model,
        fetchImpl: async () => chunkedResponse(expected, { contentLength: expected.byteLength + 1 }),
        logger: silentLogger,
      }),
      /announced .* expected/,
    );
    assert.deepEqual(await readFile(destination), old);

    await assert.rejects(
      installSttVadModel({
        cacheDir,
        model,
        fetchImpl: async () => chunkedResponse(Buffer.concat([expected, Buffer.from("overflow")]), { contentLength: 0 }),
        logger: silentLogger,
      }),
      /exceeded/,
    );
    assert.deepEqual(await readFile(destination), old);

    await assert.rejects(
      installSttVadModel({
        cacheDir,
        model,
        fetchImpl: async () => chunkedResponse(Buffer.from("wrong payload!")),
        logger: silentLogger,
      }),
      /integrity mismatch/,
    );
    assert.deepEqual(await readFile(destination), old);
    assert.deepEqual((await readdir(cacheDir)).filter((entry) => entry.includes(".part-")), []);
  });
});
