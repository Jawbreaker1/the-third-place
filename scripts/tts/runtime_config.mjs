import { access, lstat, rm, writeFile } from "node:fs/promises";
import { isAbsolute, basename, join, relative, resolve } from "node:path";
import dotenv from "dotenv";

export const PIPER_VENV_MARKER = ".the-third-place-piper-runtime";
export const PIPER_RUNTIME_VERSIONS = Object.freeze({
  "piper-tts": "1.4.2",
  onnxruntime: "1.24.4",
  pathvalidate: "3.3.1",
  numpy: "2.4.4",
});
export const PIPER_RUNTIME_REQUIREMENTS = Object.freeze(
  Object.entries(PIPER_RUNTIME_VERSIONS).map(([name, version]) => `${name}==${version}`),
);
export const PIPER_RUNTIME_PROBE = [
  "import importlib.metadata",
  ...Object.entries(PIPER_RUNTIME_VERSIONS).map(
    ([name, version]) => `assert importlib.metadata.version('${name}') == '${version}'`,
  ),
  "import onnxruntime",
  "from piper.config import SynthesisConfig",
  "from piper.voice import PiperVoice",
  "probe = SynthesisConfig(noise_w_scale=0.8)",
  "assert probe.noise_w_scale == 0.8",
].join("; ");

export const loadRootEnvironment = (root, processEnv = process.env) =>
  dotenv.config({ path: join(root, ".env"), override: false, processEnv });

const assertDedicatedRepoSubdirectory = (root, candidate, requiredBasename, label) => {
  const relativePath = relative(root, candidate);
  if (!relativePath || relativePath === "." || relativePath === ".." || relativePath.split(/[\\/]/)[0] === ".." || isAbsolute(relativePath)) {
    throw new Error(`${label} must be a dedicated subdirectory inside the repository.`);
  }
  if (basename(candidate) !== requiredBasename) {
    throw new Error(`${label} must end in ${requiredBasename}.`);
  }
  return candidate;
};

export const resolveManagedVenvDir = (root, raw) =>
  assertDedicatedRepoSubdirectory(
    root,
    resolve(root, raw?.trim() || ".venv-tts"),
    ".venv-tts",
    "PIPER_TTS_VENV_DIR",
  );

export const resolveManagedCacheDir = (root, raw) =>
  assertDedicatedRepoSubdirectory(
    root,
    resolve(root, raw?.trim() || ".cache/piper-tts"),
    "piper-tts",
    "PIPER_TTS_CACHE_DIR",
  );

export const markerPathFor = (venvDir) => join(venvDir, PIPER_VENV_MARKER);

export const assertMarkedManagedVenv = async (venvDir) => {
  const metadata = await lstat(venvDir);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Refusing unmanaged Piper runtime path: ${venvDir}`);
  }
  try {
    await access(markerPathFor(venvDir));
  } catch {
    throw new Error(`Refusing Piper runtime directory without ${PIPER_VENV_MARKER}: ${venvDir}`);
  }
};

export const markManagedVenv = async (venvDir) => {
  await writeFile(
    markerPathFor(venvDir),
    `${JSON.stringify({ owner: "the-third-place", purpose: "isolated-piper-runtime", version: 1 })}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
};

export const removeManagedVenvForReinstall = async (venvDir) => {
  try {
    await assertMarkedManagedVenv(venvDir);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  await rm(venvDir, { recursive: true, force: false });
  return true;
};
