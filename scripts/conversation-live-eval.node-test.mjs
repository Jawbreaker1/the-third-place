import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const script = fileURLToPath(new URL("./conversation-live-eval.mjs", import.meta.url));
const cwd = fileURLToPath(new URL("../", import.meta.url));
const list = (...args) => {
  const result = spawnSync(process.execPath, ["--import", "tsx", script, "--list", ...args], {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    // An offline manifest must not depend on an accessible LM Studio endpoint.
    env: { ...process.env, LM_STUDIO_BASE_URL: "http://127.0.0.1:1" },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
};

test("historical opening suite retains its four matched fixtures", () => {
  const manifest = list("--openings");
  assert.deepEqual(manifest.fixtures.map((fixture) => fixture.id), [
    "sv-autonomous-opening-pub",
    "sv-autonomous-opening-pub-taste",
    "en-autonomous-opening-programming",
    "es-autonomous-opening-fandom",
  ]);
  assert.ok(manifest.fixtures.every((fixture) => fixture.initialRowCount === 0));
});

test("substance suite covers five rooms plus drift, evidence and social-affect controls", () => {
  const { fixtures, reviewAxes } = list("--substance");
  assert.equal(fixtures.length, 8);
  assert.equal(new Set(fixtures.map((fixture) => fixture.id)).size, fixtures.length);
  assert.deepEqual(new Set(fixtures.filter((fixture) => fixture.seedFamily).map((fixture) => fixture.channelId)),
    new Set(["lobby", "stock-market", "football-talk", "3d-visualisation", "fnaf"]));
  for (const id of ["sv-substance-abstract-loop", "en-substance-peer-missing-evidence", "sv-substance-social-affect-control"]) {
    const fixture = fixtures.find((entry) => entry.id === id);
    assert.ok(fixture);
    assert.equal(fixture.autonomous, true);
    assert.ok(fixture.initialRowCount > 0);
    assert.equal(fixture.required, undefined, "controls must not force publication");
  }
  assert.equal(reviewAxes.length, 5);
});

test("new exploratory cases are opt-in and individually selectable", () => {
  const original = list();
  assert.equal(original.fixtures.length, 15);
  assert.ok(original.fixtures.every((fixture) => !fixture.substanceOnly));
  const single = list("--case=sv-substance-social-affect-control");
  assert.equal(single.fixtures.length, 1);
  assert.equal(single.fixtures[0].id, "sv-substance-social-affect-control");
});

test("incompatible suites fail before starting a model evaluation", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", script, "--list", "--openings", "--substance"], {
    cwd, encoding: "utf8", timeout: 15_000,
  });
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes("Choose at most one suite"));
});

test("longitudinal manifest retains different and repeated episode material across four rooms", () => {
  const { manifest, selectedScenarioIds, episodeLimit } = list("--longitudinal");
  assert.equal(manifest.version, 1);
  assert.equal(manifest.scenarios.length, 4);
  assert.equal(selectedScenarioIds.length, 4);
  assert.equal(episodeLimit, 4);
  assert.equal(manifest.historyWindow, 18);
  assert.equal(manifest.contextWindow, 26);
  assert.ok(manifest.attemptBoundPerEpisode <= 24);
  assert.equal(typeof manifest.modelSeed, "number");
  assert.deepEqual(new Set(manifest.scenarios.map((scenario) => scenario.channelId)), new Set(["football-talk", "3d-visualisation", "ai-programming", "the-pub"]));
  for (const scenario of manifest.scenarios) {
    assert.equal(scenario.episodes.length, 4);
    assert.equal(new Set(scenario.episodes.map((episode) => episode.family)).size, 3);
    assert.deepEqual(scenario.episodes[0], scenario.episodes[3]);
    assert.ok(scenario.episodes.every((episode) => episode.seed.length > 10));
  }
});

test("longitudinal scenario and episode filters are explicit bounded selections", () => {
  const result = list("--longitudinal", "--scenario=sv-long-pub", "--episodes=2");
  assert.deepEqual(result.selectedScenarioIds, ["sv-long-pub"]);
  assert.equal(result.episodeLimit, 2);
  for (const argument of ["--episodes=0", "--episodes=5", "--episodes=1.5"]) {
    const invalid = spawnSync(process.execPath, ["--import", "tsx", script, "--list", "--longitudinal", argument], { cwd, encoding: "utf8", timeout: 15_000 });
    assert.notEqual(invalid.status, 0);
    assert.ok(invalid.stderr.includes("--episodes must be an integer from 1 to 4"));
  }
});

test("matched material is round-tripped exactly and cannot remove attempt bounds", async () => {
  const { manifest } = list("--longitudinal");
  const directory = await mkdtemp(join(tmpdir(), "third-place-eval-manifest-test-"));
  const path = join(directory, "manifest.json");
  try {
    await writeFile(path, JSON.stringify(manifest));
    assert.deepEqual(list("--longitudinal", `--match-manifest=${path}`).manifest, manifest);
    await writeFile(path, JSON.stringify({ ...manifest, attemptBoundPerEpisode: 1_000_000 }));
    const result = spawnSync(process.execPath, ["--import", "tsx", script, "--list", "--longitudinal", `--match-manifest=${path}`], { cwd, encoding: "utf8", timeout: 15_000 });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes("Invalid longitudinal manifest"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
