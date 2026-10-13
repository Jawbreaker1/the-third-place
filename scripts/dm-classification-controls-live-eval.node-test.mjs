import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assessControl, buildRunPlan, controls, inputForControl, loadRuntime, parseOptions, runControl, summarize } from "./dm-classification-controls-live-eval.mjs";

test("held-out manifest has ten fixed controls spanning capabilities, languages, depth, safety and relationships", () => {
  assert.equal(controls.length, 10);
  assert.equal(new Set(controls.map((control) => control.id)).size, 10);
  assert.deepEqual([...new Set(controls.map((control) => control.language))].sort(), ["en", "es", "fr", "ja"]);
  assert.equal(controls.filter((control) => control.domain === "operational").length, 2);
  assert.equal(controls.filter((control) => control.domain === "relationship").length, 2);
  assert.equal(controls.filter((control) => control.domain === "capability").length, 3);
});

test("all inputs satisfy the existing production schema without leaking fixture names, expectations or rationales", async () => {
  const runtime = await loadRuntime();
  for (const control of controls) {
    const input = inputForControl({ ...control, rationale: "ORACLE_RATIONALE", expected: [{ path: "ORACLE_EXPECTATION" }] });
    const serialized = JSON.stringify(input);
    assert.ok(!serialized.includes(control.id));
    assert.ok(!serialized.includes("ORACLE_RATIONALE"));
    assert.ok(!serialized.includes("ORACLE_EXPECTATION"));
    assert.equal(input.medium, "dm");
    assert.equal(input.historyRecallAvailable, false);
    assert.equal(input.humanCandidates.length, 1);
    assert.equal(runtime.imported.semanticRouter.turnAnalysisInputSchema.safeParse(input).success, true, control.id);
  }
});

test("run plan preserves order across repeated baseline/candidate matrices", () => {
  const options = parseOptions(["--cases=ja-named-local-time,en-explicit-romantic-boundary", "--repeats=2"]);
  assert.deepEqual(buildRunPlan(options.selected, options.repeats).map(({ control, repetition }) => `${control.id}#${repetition}`), [
    "ja-named-local-time#1", "en-explicit-romantic-boundary#1", "ja-named-local-time#2", "en-explicit-romantic-boundary#2",
  ]);
  for (const argv of [["--cases=missing"], ["--repeats=0"], ["--repeats=4"], ["--repeats=1.5"], ["--repeats=2", "--repeats=2"], ["--unknown"], ["--output=/etc/report"]]) assert.throws(() => parseOptions(argv));
});

test("typed checks reject wrong authority, unsupported research, accidental person selection and false language switches without grading prose", () => {
  const control = controls.find((control) => control.id === "en-explicit-french-response");
  const analysis = { source: "lm", failureReason: null, referencedHumanIds: [], historyRecall: { need: "none" },
    evidence: { action: "none" }, capabilities: { asksAboutAiIdentity: false, requestKind: "none", discussed: [] },
    moderation: { risk: "none", action: "none", categories: [] }, language: { tag: "en" }, responseLanguage: { tag: "fr-FR" } };
  assert.equal(assessControl(control, analysis).passed, true);
  for (const override of [{ source: "fallback" }, { referencedHumanIds: ["synthetic-unrelated-public-person"] },
    { evidence: { action: "web_search" } }, { responseLanguage: { tag: "en" } }]) {
    assert.equal(assessControl(control, { ...analysis, ...override }).passed, false);
  }
  assert.deepEqual(summarize([{ assessment: { passed: true } }, { assessment: { passed: false } }, { error: "timeout" }]), { total: 3, passed: 1, failed: 1, unavailable: 1 });
});

test("import and dry run do not load runtime, contact models or create reports", () => {
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", "globalThis.fetch=()=>{throw Error('network forbidden')}; await import('./scripts/dm-classification-controls-live-eval.mjs'); console.log('import-safe');"], { encoding: "utf8" });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout.trim(), "import-safe");
  const dryRun = spawnSync(process.execPath, ["scripts/dm-classification-controls-live-eval.mjs", "--dry-run", "--runtime-root=/does-not-exist", "--cases=fr-opaque-page-read"], { encoding: "utf8" });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(JSON.parse(dryRun.stdout).modelCalls, 0);
});

test("runner retains deterministic transport seed, settings and raw output while allowing no app or provider execution", async () => {
  const real = await loadRuntime();
  const requests = [];
  const analysis = real.imported.semanticRouter.createFailClosedTurnAnalysis("invalid_output");
  const transport = { providerId: "lmstudio", configuredModel: "synthetic-model",
    probe: async () => { throw Error("Unexpected probe"); },
    complete: async (body) => { requests.push(body); return { choices: [{ finish_reason: "stop", message: { content: "{}" } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }; } };
  class StubClient {
    constructor(options) { this.backend = options.backend; }
    async analyzeTurn(input) {
      await this.backend.complete({ model: "synthetic-model", temperature: 0, max_tokens: 600,
        response_format: { json_schema: { name: "synthetic-router" } },
        messages: [{ role: "system", content: "synthetic system" }, { role: "user", content: JSON.stringify(input) }] }, AbortSignal.timeout(1_000));
      return analysis;
    }
    cancelPending() {}
  }
  const runtime = { imported: { lmStudio: { LmStudioClient: StubClient }, semanticRouter: real.imported.semanticRouter } };
  const control = controls[0];
  const first = await runControl({ control, repetition: 1, runtime, transport });
  const second = await runControl({ control, repetition: 1, runtime, transport });
  assert.equal(requests[0].seed, requests[1].seed);
  assert.equal(requests[0].seed, 931_001);
  assert.equal(requests[0].max_tokens, 600);
  assert.equal(first.calls[0].content, "{}");
  assert.equal(first.calls[0].finishReason, "stop");
  assert.equal(first.calls[0].systemSha256.length, 64);
  assert.equal(first.assessment.passed, false);
  assert.equal(second.assessment.passed, false);
  assert.ok(!JSON.stringify(requests).includes(control.rationale));
  assert.ok(!JSON.stringify(requests).includes(control.id));
});
