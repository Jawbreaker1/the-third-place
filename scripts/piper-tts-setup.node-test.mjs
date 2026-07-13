import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PIPER_VOICE_FILES, PIPER_VOICE_REVISION } from "./tts/piper_voice_manifest.mjs";
import {
  PIPER_VENV_MARKER,
  PIPER_RUNTIME_PROBE,
  PIPER_RUNTIME_REQUIREMENTS,
  loadRootEnvironment,
  markManagedVenv,
  removeManagedVenvForReinstall,
  resolveManagedCacheDir,
  resolveManagedVenvDir,
} from "./tts/runtime_config.mjs";

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Piper voice download manifest", () => {
  it("pins both Swedish voices and every cached file by immutable URL, size and SHA-256", () => {
    assert.match(PIPER_VOICE_REVISION, /^[a-f0-9]{40}$/);
    assert.equal(PIPER_VOICE_FILES.length, 6);
    assert.deepEqual([...new Set(PIPER_VOICE_FILES.map((file) => file.voice))].sort(), ["lisa", "nst"]);
    assert.equal(new Set(PIPER_VOICE_FILES.map((file) => file.relativePath)).size, PIPER_VOICE_FILES.length);
    for (const file of PIPER_VOICE_FILES) {
      const url = new URL(file.url);
      assert.equal(url.protocol, "https:");
      assert.equal(url.hostname, "huggingface.co");
      assert.ok(url.pathname.includes(`/resolve/${PIPER_VOICE_REVISION}/`));
      assert.ok(Number.isSafeInteger(file.bytes) && file.bytes > 0);
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      assert.ok(!file.relativePath.startsWith("/") && !file.relativePath.includes(".."));
    }
  });
});

describe("Piper runtime setup safety", () => {
  it("loads exactly the repository .env without overriding inherited values", async () => {
    const root = await mkdtemp(join(tmpdir(), "third-place-tts-env-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, ".env"), "PIPER_TTS_PORT=9123\nPIPER_TTS_CACHE_DIR=.cache/piper-tts\n");
    const isolatedEnv = { PIPER_TTS_PORT: "8179" };
    const result = loadRootEnvironment(root, isolatedEnv);
    assert.equal(result.error, undefined);
    assert.deepEqual(isolatedEnv, { PIPER_TTS_PORT: "8179", PIPER_TTS_CACHE_DIR: ".cache/piper-tts" });
  });

  it("accepts only dedicated repo-local cache and venv directories", () => {
    const root = resolve(tmpdir(), "workspace", "the-third-place");
    assert.equal(resolveManagedVenvDir(root, ".venv-tts"), join(root, ".venv-tts"));
    assert.equal(resolveManagedVenvDir(root, "runtime/.venv-tts"), join(root, "runtime", ".venv-tts"));
    assert.equal(resolveManagedCacheDir(root, ".cache/piper-tts"), join(root, ".cache", "piper-tts"));
    for (const unsafe of [".", "..", resolve(tmpdir()), "src", "../.venv-tts"]) {
      assert.throws(() => resolveManagedVenvDir(root, unsafe));
    }
    assert.throws(() => resolveManagedCacheDir(root, "."));
  });

  it("pins the verified runtime compatibility set and probes real imports/API shape", () => {
    assert.deepEqual(PIPER_RUNTIME_REQUIREMENTS, [
      "piper-tts==1.4.2",
      "onnxruntime==1.24.4",
      "pathvalidate==3.3.1",
      "numpy==2.4.4",
    ]);
    assert.match(PIPER_RUNTIME_PROBE, /import onnxruntime/);
    assert.match(PIPER_RUNTIME_PROBE, /from piper\.config import SynthesisConfig/);
    assert.match(PIPER_RUNTIME_PROBE, /from piper\.voice import PiperVoice/);
    assert.match(PIPER_RUNTIME_PROBE, /SynthesisConfig\(noise_w_scale=0\.8\)/);
  });

  it("refuses to recursively remove an existing venv unless its own marker exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "third-place-tts-marker-"));
    temporaryDirectories.push(root);
    const venv = join(root, ".venv-tts");
    await mkdir(venv);
    await writeFile(join(venv, "keep-me"), "user data");
    await assert.rejects(removeManagedVenvForReinstall(venv), new RegExp(PIPER_VENV_MARKER));
    assert.equal(await readFile(join(venv, "keep-me"), "utf8"), "user data");
    await markManagedVenv(venv);
    assert.equal(await removeManagedVenvForReinstall(venv), true);
  });
});
