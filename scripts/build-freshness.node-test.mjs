import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { productionBuildIsFresh, recordBuildFingerprint } from "./build-freshness.mjs";

test("build freshness tracks source/config/assets and deleted files, not timestamps or runtime data", async () => {
  const root = await mkdtemp(join(tmpdir(), "third-place-build-freshness-"));
  try {
    for (const directory of ["server", "src", "public", "data", "dist", "dist-server/server"]) {
      await mkdir(join(root, directory), { recursive: true });
    }
    await writeFile(join(root, "server/index.ts"), "server source");
    await writeFile(join(root, "src/App.tsx"), "client source");
    await writeFile(join(root, "public/logo.svg"), "logo");
    await writeFile(join(root, "package-lock.json"), "dependencies");
    await writeFile(join(root, "dist/index.html"), "web build");
    await writeFile(join(root, "dist-server/server/index.js"), "server build");
    assert.equal(await productionBuildIsFresh(root), false);
    await recordBuildFingerprint(root);
    assert.equal(await productionBuildIsFresh(root), true);

    await writeFile(join(root, "data/runtime.json"), "changed runtime data");
    assert.equal(await productionBuildIsFresh(root), true);
    for (const path of ["server/index.ts", "src/App.tsx", "public/logo.svg", "package-lock.json"]) {
      await writeFile(join(root, path), `changed ${path}`);
      assert.equal(await productionBuildIsFresh(root), false, path);
      await recordBuildFingerprint(root);
      assert.equal(await productionBuildIsFresh(root), true, path);
    }
    await rm(join(root, "public/logo.svg"));
    assert.equal(await productionBuildIsFresh(root), false, "deleted public asset");
    await recordBuildFingerprint(root);
    await writeFile(join(root, "dist/index.html"), "partially replaced output");
    assert.equal(await productionBuildIsFresh(root), false, "partial output rebuild");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing production entry cannot be recorded as a valid build", async () => {
  const root = await mkdtemp(join(tmpdir(), "third-place-build-missing-"));
  try {
    assert.equal(await productionBuildIsFresh(root), false);
    await assert.rejects(recordBuildFingerprint(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
