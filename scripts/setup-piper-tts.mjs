import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PIPER_VOICE_FILES, PIPER_VOICE_REVISION } from "./tts/piper_voice_manifest.mjs";
import {
  assertMarkedManagedVenv,
  loadRootEnvironment,
  markManagedVenv,
  PIPER_RUNTIME_PROBE,
  PIPER_RUNTIME_REQUIREMENTS,
  removeManagedVenvForReinstall,
  resolveManagedCacheDir,
  resolveManagedVenvDir,
} from "./tts/runtime_config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadRootEnvironment(root);
const cacheDir = resolveManagedCacheDir(root, process.env.PIPER_TTS_CACHE_DIR);
const venvDir = resolveManagedVenvDir(root, process.env.PIPER_TTS_VENV_DIR);

const executable = () => process.platform === "win32"
  ? join(venvDir, "Scripts", "python.exe")
  : join(venvDir, "bin", "python");

const run = (command, args) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", shell: false });
  child.once("error", rejectRun);
  child.once("exit", (code, signal) => {
    if (code === 0) resolveRun();
    else rejectRun(new Error(`${command} exited with ${signal ?? code ?? "unknown"}`));
  });
});

const sha256File = async (path) => {
  const handle = await open(path, "r");
  const hash = createHash("sha256");
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close().catch(() => undefined);
  }
  return hash.digest("hex");
};

const validCachedFile = async (path, expected) => {
  try {
    const metadata = await stat(path);
    return metadata.isFile() && metadata.size === expected.bytes && await sha256File(path) === expected.sha256;
  } catch {
    return false;
  }
};

const download = async (file) => {
  const destination = join(cacheDir, file.relativePath);
  if (await validCachedFile(destination, file)) {
    console.log(`[setup:tts] verified cached ${file.relativePath}`);
    return;
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.part-${process.pid}`;
  await rm(temporary, { force: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("voice download timed out")), 180_000);
  let handle;
  try {
    const response = await fetch(file.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "The-Third-Place-Piper-Setup/1" },
    });
    if (!response.ok || !response.body) throw new Error(`download returned HTTP ${response.status}`);
    const announced = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
    if (announced > file.bytes) throw new Error(`download announced ${announced} bytes; expected ${file.bytes}`);
    handle = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let total = 0;
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (total > file.bytes) throw new Error(`download exceeded expected ${file.bytes} bytes`);
      const buffer = Buffer.from(chunk);
      hash.update(buffer);
      await handle.write(buffer);
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    const digest = hash.digest("hex");
    if (total !== file.bytes || digest !== file.sha256) {
      throw new Error(`integrity mismatch for ${file.relativePath} (${total} bytes, sha256 ${digest})`);
    }
    await rename(temporary, destination);
    console.log(`[setup:tts] installed ${file.relativePath}`);
  } finally {
    clearTimeout(timer);
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

const runtimeReady = async () => {
  try {
    await assertMarkedManagedVenv(venvDir);
    await access(executable());
    await run(executable(), ["-c", PIPER_RUNTIME_PROBE]);
    return true;
  } catch {
    return false;
  }
};

const installRuntime = async () => {
  if (await runtimeReady()) {
    console.log(`[setup:tts] verified isolated Piper/ONNX runtime (${PIPER_RUNTIME_REQUIREMENTS.join(", ")})`);
    return;
  }
  await removeManagedVenvForReinstall(venvDir);
  const configuredPython = process.env.PIPER_TTS_BOOTSTRAP_PYTHON?.trim();
  const uvPython = configuredPython || "3.11";
  const fallbackPython = configuredPython || (process.platform === "win32" ? "python" : "python3");
  let usedUv = false;
  try {
    // Python 3.11 has the broadest tested Piper/ONNX wheel coverage. uv can
    // provision it portably when the host's default Python is newer.
    await run("uv", ["venv", "--python", uvPython, venvDir]);
    usedUv = true;
  } catch {
    await run(fallbackPython, ["-m", "venv", venvDir]);
  }
  await markManagedVenv(venvDir);
  if (usedUv) await run("uv", ["pip", "install", "--python", executable(), ...PIPER_RUNTIME_REQUIREMENTS]);
  else await run(executable(), ["-m", "pip", "install", ...PIPER_RUNTIME_REQUIREMENTS]);
  if (!await runtimeReady()) throw new Error("Piper runtime failed its post-install verification");
};

try {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  for (const file of PIPER_VOICE_FILES) await download(file);
  await installRuntime();
  console.log(`[setup:tts] ready at ${cacheDir}; voices pinned to ${PIPER_VOICE_REVISION}`);
} catch (error) {
  console.error(`[setup:tts] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
