import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const INPUTS = [
  "server", "shared", "src", "public", "index.html", "package.json", "package-lock.json",
  "tsconfig.json", "tsconfig.app.json", "tsconfig.server.json", "vite.config.ts", "scripts/build-freshness.mjs",
];
const MANIFEST = "dist-server/.build-fingerprint.json";

const fingerprint = async (root, paths) => {
  const hash = createHash("sha256");
  const visit = async (entry) => {
    const path = resolve(root, entry);
    let children;
    try {
      children = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOTDIR") {
        hash.update(`${entry}\0`);
        hash.update(await readFile(path));
        hash.update("\0");
        return;
      }
      if (error.code === "ENOENT") {
        hash.update(`${entry}\0missing\0`);
        return;
      }
      throw error;
    }
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const next = `${entry}/${child.name}`;
      if (next !== MANIFEST) await visit(next);
    }
  };
  for (const entry of paths) await visit(entry);
  return hash.digest("hex");
};

const buildFingerprint = async (root) => ({
  version: 1,
  inputs: await fingerprint(root, INPUTS),
  outputs: await fingerprint(root, ["dist-server", "dist"]),
});

export const recordBuildFingerprint = async (root) => {
  // A failed/partial build must never produce a usable freshness marker.
  await Promise.all([readFile(resolve(root, "dist-server/server/index.js")), readFile(resolve(root, "dist/index.html"))]);
  await writeFile(resolve(root, MANIFEST), `${JSON.stringify(await buildFingerprint(root))}\n`);
};

export const productionBuildIsFresh = async (root) => {
  try {
    const saved = JSON.parse(await readFile(resolve(root, MANIFEST), "utf8"));
    const current = await buildFingerprint(root);
    return saved.version === current.version && saved.inputs === current.inputs && saved.outputs === current.outputs;
  } catch {
    return false;
  }
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (process.argv[2] === "record") await recordBuildFingerprint(root);
  else if (process.argv[2] === "check") process.exitCode = await productionBuildIsFresh(root) ? 0 : 1;
  else throw new Error(`Usage: node ${relative(root, fileURLToPath(import.meta.url))} <record|check>`);
}
