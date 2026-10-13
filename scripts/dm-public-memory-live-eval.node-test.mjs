import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { boundedSyntheticPayload, buildRunPlan, externalLookupControl, inferenceSettings, parseOptions, privateSentinelHits, PRIVATE_SENTINELS, scenarios } from "./dm-public-memory-live-eval.mjs";

test("the manifest covers retrieval, pruning, ambiguity and privacy without grading reply words", () => {
  assert.equal(scenarios.length, 8);
  assert.equal(new Set(scenarios.map((scenario) => scenario.id)).size, scenarios.length);
  assert.deepEqual([...new Set(scenarios.map((scenario) => scenario.language))].sort(), ["en", "es", "sv"]);
  assert.equal(scenarios.filter((scenario) => scenario.memoryOnly).length, 1);
  assert.equal(scenarios.filter((scenario) => scenario.ambiguous).length, 1);
});

test("case selection preserves exact order and rejects unknown fixtures", () => {
  assert.deepEqual(parseOptions(["--cases=sv-memory-only,sv-public"]).selected.map((entry) => entry.id), ["sv-memory-only", "sv-public"]);
  assert.throws(() => parseOptions(["--cases=unknown"]), /Unknown synthetic scenario/);
});

test("the explicit external control remains separate from the unchanged eight DM fixtures", () => {
  assert.equal(parseOptions(["--external-control"]).externalControl, true);
  assert.equal(externalLookupControl.expectedEvidenceAction, "web_search");
  assert.equal(scenarios.some((scenario) => scenario.id === externalLookupControl.id), false);
});

test("repeated matrices are opt-in, bounded and preserve the exact fixture order each round", () => {
  assert.equal(parseOptions([]).repeats, 1);
  const options = parseOptions(["--repeats=3", "--cases=sv-public,en-public,es-public"]);
  assert.deepEqual(buildRunPlan(options.selected, options.repeats).map(({ runId }) => runId), [
    "sv-public#1", "en-public#1", "es-public#1", "sv-public#2", "en-public#2", "es-public#2", "sv-public#3", "en-public#3", "es-public#3",
  ]);
  for (const value of ["0", "-1", "6", "1.5", "NaN", ""]) assert.throws(() => parseOptions([`--repeats=${value}`]));
  assert.throws(() => parseOptions(["--schema-smoke", "--external-control"]));
  assert.throws(() => parseOptions(["--router-smoke", "--external-control"]));
  assert.equal(parseOptions(["--router-smoke"]).routerSmoke, true);
});

test("inference auditing records only bounded request settings, not prompts or secrets", () => {
  assert.deepEqual(inferenceSettings({ model: "synthetic-model", max_tokens: 600, temperature: 0, seed: 3, messages: [{ content: "secret" }], authorization: "secret" }), {
    model: "synthetic-model", max_tokens: 600, temperature: 0, seed: 3,
  });
});

test("private sentinel checking scans complete raw payloads before reporting bounds", () => {
  const raw = { payload: "a".repeat(7_000) + PRIVATE_SENTINELS[0] };
  assert.deepEqual(privateSentinelHits(raw), [PRIVATE_SENTINELS[0]]);
  assert.deepEqual(privateSentinelHits(boundedSyntheticPayload(raw)), []);
  assert.deepEqual(privateSentinelHits({ ordinary: "NootCollector likes a crooked-beak plush." }), []);
});

test("report payload serialization is bounded without evaluating quoted strings", () => {
  const bounded = boundedSyntheticPayload({ rows: Array.from({ length: 100 }, () => "x".repeat(7_000)) });
  assert.equal(bounded.rows.length, 64);
  assert.equal(bounded.rows[0].length, 6_011);
});

test("dry-run is import-safe and performs no model or runtime access", () => {
  const result = spawnSync(process.execPath, ["scripts/dm-public-memory-live-eval.mjs", "--dry-run", "--runtime-root=/does-not-exist", "--cases=sv-public"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.modelCalls, 0);
  assert.equal(output.scenarios[0].id, "sv-public");
});
