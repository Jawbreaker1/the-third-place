import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertMarkedManagedVenv,
  loadRootEnvironment,
  resolveManagedCacheDir,
  resolveManagedVenvDir,
} from "./tts/runtime_config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadRootEnvironment(root);
const venvDir = resolveManagedVenvDir(root, process.env.PIPER_TTS_VENV_DIR);
const cacheDir = resolveManagedCacheDir(root, process.env.PIPER_TTS_CACHE_DIR);
const python = process.platform === "win32" ? join(venvDir, "Scripts", "python.exe") : join(venvDir, "bin", "python");
const sidecar = join(root, "scripts", "tts", "piper_sidecar.py");

try {
  await assertMarkedManagedVenv(venvDir);
  await access(python);
} catch {
  console.error("[tts] isolated, marked Piper runtime is missing; run npm run setup:tts first");
  process.exit(1);
}

const child = spawn(python, [sidecar], {
  cwd: root,
  stdio: "inherit",
  shell: false,
  env: {
    ...process.env,
    PIPER_TTS_PORT: process.env.PIPER_TTS_PORT?.trim() || "8179",
    PIPER_TTS_CACHE_DIR: cacheDir,
  },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.once("error", (error) => {
  console.error(`[tts] sidecar could not start: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
