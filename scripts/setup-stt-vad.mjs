#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const STT_VAD_MODEL = Object.freeze({
  filename: "ggml-silero-v6.2.0.bin",
  url: "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin",
  bytes: 885_098,
  sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;

const configuredPath = (value, base, home) => {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return resolve(home, trimmed.slice(2));
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(base, trimmed);
};

/** Resolve a host-appropriate cache directory without tying setup to macOS. */
export const resolveSttVadCacheDir = (
  repositoryRoot,
  env = process.env,
  options = {},
) => {
  const home = options.homeDir ?? homedir();
  const explicit = configuredPath(env.STT_VAD_CACHE_DIR, repositoryRoot, home);
  if (explicit) return explicit;

  const xdg = configuredPath(env.XDG_CACHE_HOME, repositoryRoot, home);
  const platform = options.platform ?? process.platform;
  const platformCache = xdg ?? (platform === "darwin"
    ? join(home, "Library", "Caches")
    : platform === "win32"
      ? configuredPath(env.LOCALAPPDATA, repositoryRoot, home) ?? join(home, "AppData", "Local")
      : join(home, ".cache"));
  return join(platformCache, "the-third-place", "stt-vad");
};

export const sha256File = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

export const isVerifiedModelFile = async (path, model = STT_VAD_MODEL) => {
  try {
    const metadata = await lstat(path);
    return metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.size === model.bytes &&
      await sha256File(path) === model.sha256;
  } catch {
    return false;
  }
};

const assertModelManifest = (model) => {
  const url = new URL(model.url);
  if (url.protocol !== "https:") throw new Error("VAD model URL must use HTTPS.");
  if (basename(model.filename) !== model.filename || model.filename === "." || model.filename === "..") {
    throw new Error("VAD model filename must not contain a path.");
  }
  if (!Number.isSafeInteger(model.bytes) || model.bytes <= 0) throw new Error("VAD model byte size is invalid.");
  if (!/^[a-f0-9]{64}$/.test(model.sha256)) throw new Error("VAD model SHA-256 is invalid.");
};

const replaceAtomically = async (temporary, destination) => {
  try {
    await rename(temporary, destination);
  } catch (error) {
    // POSIX rename replaces a destination atomically. Windows may require the
    // known model filename to be unlinked first after the new file is complete.
    if (process.platform !== "win32" || !error || typeof error !== "object" ||
      !("code" in error) || !["EEXIST", "EPERM"].includes(error.code)) throw error;
    await rm(destination, { force: true });
    await rename(temporary, destination);
  }
};

export const installSttVadModel = async ({
  cacheDir,
  model = STT_VAD_MODEL,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  logger = console,
} = {}) => {
  if (!cacheDir) throw new Error("A VAD cache directory is required.");
  assertModelManifest(model);
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const cacheMetadata = await lstat(cacheDir);
  if (!cacheMetadata.isDirectory() || cacheMetadata.isSymbolicLink()) {
    throw new Error(`VAD cache path must be a real directory: ${cacheDir}`);
  }

  const destination = join(cacheDir, model.filename);
  if (await isVerifiedModelFile(destination, model)) {
    await chmod(destination, 0o600);
    logger.log(`[setup:stt-vad] verified cached ${model.filename}`);
    logger.log(`[setup:stt-vad] model path: ${destination}`);
    return { path: destination, cached: true };
  }

  const temporary = join(cacheDir, `.${model.filename}.part-${process.pid}-${randomUUID()}`);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("VAD model download timed out")),
    Math.max(1, timeoutMs),
  );
  let handle;
  try {
    const response = await fetchImpl(model.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "The-Third-Place-STT-VAD-Setup/1" },
    });
    if (!response.ok || !response.body) throw new Error(`VAD model download returned HTTP ${response.status}`);
    const announced = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
    if (Number.isFinite(announced) && announced > model.bytes) {
      throw new Error(`VAD model download announced ${announced} bytes; expected ${model.bytes}`);
    }

    handle = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let total = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > model.bytes) throw new Error(`VAD model download exceeded ${model.bytes} bytes`);
      hash.update(buffer);
      await handle.write(buffer);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;

    const digest = hash.digest("hex");
    if (total !== model.bytes || digest !== model.sha256) {
      throw new Error(`VAD model integrity mismatch (${total} bytes, sha256 ${digest})`);
    }
    await replaceAtomically(temporary, destination);
    await chmod(destination, 0o600);
    logger.log(`[setup:stt-vad] installed ${model.filename}`);
    logger.log(`[setup:stt-vad] model path: ${destination}`);
    return { path: destination, cached: false };
  } finally {
    clearTimeout(timer);
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

export const setupSttVad = async (options = {}) => {
  dotenv.config({ path: join(root, ".env"), override: false });
  const cacheDir = options.cacheDir ?? resolveSttVadCacheDir(root, process.env);
  return installSttVadModel({ ...options, cacheDir });
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  setupSttVad().catch((error) => {
    console.error(`[setup:stt-vad] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
