import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoveryCases } from "./fixtures/factual-shadow-discovery.mjs";
import { parseFactualShadowAssessment } from "./experiments/factualShadowReview.ts";
import { broadRequestForCase, evaluateShadowCell, parseOptions, promptHash, selectCases,
  shadowInputForCase, summarize, validateOutputPath } from "./factual-shadow-live-eval.mjs";

const script = fileURLToPath(new URL("./factual-shadow-live-eval.mjs", import.meta.url));
const cwd = fileURLToPath(new URL("../", import.meta.url));
const fixture = {
  id: "synthetic-valid", pairId: "synthetic-pair", split: "discovery", domain: "calculation", language: "en",
  request: "What is two plus two?", context: [], sources: [], candidate: "Four.", expected: "supported", rationale: "2+2=4",
};

test("offline CLI lists only discovery by default and does not require LM Studio", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", script, "--list"], {
    cwd, encoding: "utf8", timeout: 15_000, env: { ...process.env, LM_STUDIO_BASE_URL: "http://127.0.0.1:1" },
  });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(result.stdout);
  assert.equal(manifest.split, "discovery");
  assert.equal(manifest.cases.length, discoveryCases.length);
  assert.equal(manifest.cells, discoveryCases.length);
  assert.equal(manifest.maxModelCalls, discoveryCases.length * 3);
  assert.equal(manifest.promptHash, promptHash());
});

test("options reject unknown/repeated flags, unsafe bounds and output paths before network", () => {
  for (const args of [
    ["--unknown=x"], ["--samples"], ["--samples=0"], ["--samples=4"], ["--concurrency=3"],
    ["--split=other"], ["--list", "--list"], ["--samples=1", "--samples=2"],
    ["--cases=a,a"], ["--cases=a,"], ["--output=relative"], ["--output=/Users/somewhere"],
  ]) assert.throws(() => parseOptions(args), args.join(" "));
  assert.equal(parseOptions(["--samples=3", "--concurrency=1", "--dry-run"]).samples, 3);
  assert.throws(() => validateOutputPath("/tmp"));
  assert.throws(() => validateOutputPath("/tmp/../Users/reports"));
  assert.equal(validateOutputPath("/tmp/shadow-test-report"), "/tmp/shadow-test-report");
});

test("holdout requires the exact frozen prompt hash before fixture loading", () => {
  assert.throws(() => parseOptions(["--split=holdout", "--list"]), /requires/);
  assert.throws(() => parseOptions(["--split=holdout", "--frozen-prompt=wrong", "--list"]), /does not match/);
  assert.equal(parseOptions(["--split=holdout", `--frozen-prompt=${promptHash()}`, "--list"]).split, "holdout");
});

test("case selection validates identities, splits, labels and bounded input without loading holdout", () => {
  const options = parseOptions([]);
  assert.equal(selectCases(discoveryCases, options).length, discoveryCases.length);
  assert.throws(() => selectCases([fixture, fixture], options), /Duplicate/);
  assert.throws(() => selectCases([{ ...fixture, id: "../bad" }], options), /Unsafe/);
  assert.throws(() => selectCases([{ ...fixture, split: "holdout" }], options), /split/);
  assert.throws(() => selectCases([{ ...fixture, expected: "anything" }], options), /expectation/);
  assert.throws(() => selectCases([fixture], { ...options, caseIds: ["missing"] }), /Unknown/);
  assert.throws(() => selectCases([{ ...fixture, candidate: "x".repeat(8_001) }], options));
});

test("both arms omit ground-truth labels, rationale, pairs, split and valid/invalid case IDs", () => {
  const input = { ...fixture, id: "synthetic-invalid", pairId: "LABEL_PAIR", rationale: "SECRET_EXPECTATION",
    context: [{ author: "Alex", content: "Some context." }], sources: [{ id: "S1", title: "Note", text: "Two and two make four." }] };
  const narrow = shadowInputForCase(input);
  const broad = broadRequestForCase(input);
  for (const request of [narrow, broad]) {
    const text = JSON.stringify(request);
    assert.ok(!text.includes("synthetic-invalid"));
    assert.ok(!text.includes("LABEL_PAIR"));
    assert.ok(!text.includes("SECRET_EXPECTATION"));
    assert.ok(!Object.hasOwn(request, "expected"));
    assert.ok(!Object.hasOwn(request, "split"));
  }
  assert.equal(narrow.sources[0].text, broad.research.results[0].snippet);
  assert.equal(narrow.context[0].content, broad.history[0].content);
  assert.equal(narrow.request, broad.trigger.content);
  assert.deepEqual(narrow.citedSourceIds, ["S1"]);
  assert.equal(narrow.evidenceStatus, "succeeded");
  assert.deepEqual(broadRequestForCase({ ...fixture, mustFulfillRequest: false }).requestOwnerIds, []);
});

const cell = (expected, broad, shadow, other = {}) => ({ caseId: "case", pairId: null, split: "discovery",
  domain: "test", language: "en", sample: 1, expected, broad, shadow, trace: [], ...other });
const broad = (overallDisposition, factualIssues = []) => ({ status: "completed", overallDisposition, factualIssues, elapsedMs: 10 });
const shadow = (verdict) => ({ status: "completed", assessment: { verdict, claims: [] }, elapsedMs: 20 });

test("summary catches both false approvals and false rejections; errors and uncertainty never become success", () => {
  const rows = [
    cell("supported", broad("blocked", ["evidence_ungrounded"]), shadow("contradicted")),
    cell("contradicted", broad("clear"), shadow("supported")),
    cell("supported", { status: "unavailable" }, { status: "unavailable" }),
    cell("contradicted", broad("blocked", ["evidence_ungrounded"]), shadow("uncertain")),
    cell("not_factual", broad("clear"), shadow("not_factual")),
  ];
  const summary = summarize(rows);
  assert.equal(summary.broad.factualRejectCleared, 1);
  assert.equal(summary.broad.factualAcceptBlocked, 1);
  assert.equal(summary.broadFactualFlags.falseApprovals, 1);
  assert.equal(summary.broadFactualFlags.falseRejections, 1);
  assert.equal(summary.broad.unavailable, 1);
  assert.equal(summary.shadow.falseApprovals, 1);
  assert.equal(summary.shadow.falseRejections, 1);
  assert.equal(summary.shadow.unavailable, 1);
  assert.equal(summary.shadow.abstentions, 1);
  assert.equal(summary.shadow.correctDecisions, 1);
  assert.equal(summary.verdictConfusion["contradicted -> uncertain"], 1);
});

test("non-factual broad blocks are separate from factual flags and complete pair contrasts", () => {
  const rows = [
    cell("supported", broad("blocked"), shadow("supported"), { caseId: "right", pairId: "pair" }),
    cell("contradicted", broad("blocked", ["evidence_ungrounded"]), shadow("contradicted"), { caseId: "wrong", pairId: "pair" }),
  ];
  const summary = summarize(rows);
  assert.equal(summary.broad.factualAcceptBlocked, 1);
  assert.ok(!Object.hasOwn(summary.broad, "falseRejections"));
  assert.equal(summary.broadFactualFlags.falseRejections, 0);
  assert.equal(summary.pairs[0].completeContrast, true);
  assert.equal(summary.pairs[0].shadow.allDecisionsCorrect, true);
  assert.equal(summary.pairs[0].broad.allDecisionsCorrect, false);
  assert.equal(summary.latency.shadow.medianMs, 20);
  assert.equal(summary.byDomain.test.shadow.correctDecisions, 2);
  assert.equal(summary.byLanguage.en.shadow.correctDecisions, 2);
});

test("usage aggregates actual trace calls separately without pretending missing usage is zero calls", () => {
  const row = cell("supported", { ...broad("clear"), traceIndexes: [0] }, { ...shadow("supported"), traceIndexes: [1] }, {
    trace: [{ response: { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } }, { error: "backend failed" }],
  });
  const summary = summarize([row]);
  assert.deepEqual(summary.usage.broad, { calls: 1, callsWithUsage: 1, promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  assert.equal(summary.usage.shadow.calls, 1);
  assert.equal(summary.usage.shadow.callsWithUsage, 0);
});

test("shadow still runs when existing reviewer fails, and neither result feeds the other", async () => {
  for (const order of ["broad-first", "shadow-first"]) {
    const bodies = [];
    const result = await evaluateShadowCell({ item: fixture, sample: 1, order, model: "synthetic-model",
      backend: { providerId: "lmstudio", probe: async () => ({ connected: true }), complete: async (body) => {
        bodies.push(body);
        throw new Error("synthetic backend failure");
      } } });
    assert.equal(result.broad.status, "unavailable");
    assert.equal(result.shadow.status, "unavailable");
    assert.equal(bodies.length, 2);
    assert.equal(result.trace.length, 2);
    assert.equal(bodies[order === "shadow-first" ? 0 : 1].response_format.json_schema.name, "factual_shadow_assessment");
    for (const body of bodies) assert.ok(!JSON.stringify(body.messages).includes("synthetic backend failure"));
  }
});

test("harness has no application entry import and production files do not import shadow module", async () => {
  const text = await readFile(script, "utf8");
  assert.ok(!text.includes('from "../server/index'));
  for (const path of ["../server/lmStudio.ts", "../server/director.ts", "../server/index.ts"]) {
    const code = await readFile(new URL(path, import.meta.url), "utf8");
    assert.ok(!code.includes("factualShadowReview"), path);
  }
});

test("parked results retain all original outcomes, including invalid replies, without temporary files or network", async () => {
  const archive = JSON.parse(await readFile(new URL("../docs/evaluations/factual-shadow-2026-10-12.results.json", import.meta.url), "utf8"));
  assert.equal(archive.status, "parked");
  assert.equal(archive.publicationEffect, "none");
  assert.deepEqual(archive.runs.map((run) => run.cells.length), [24, 40]);
  assert.equal(archive.runs.reduce((sum, run) => sum + run.cells.reduce((calls, item) => calls + item.trace.length, 0), 0), 128);
  let invalidShadowReplies = 0;
  for (const run of archive.runs) {
    assert.equal(run.promptHash, promptHash());
    assert.equal(run.originalReportSha256.length, 64);
    const recomputed = summarize(run.cells);
    for (const [key, value] of Object.entries(run.summary)) assert.deepEqual(recomputed[key], value, `${run.split}/${key}`);
    for (const item of run.cells) {
      assert.equal(item.shadowInput.candidate, item.candidate);
      assert.equal(item.shadow.traceIndexes.length, 1);
      const trace = item.trace[item.shadow.traceIndexes[0]];
      assert.equal(trace.requestSettings.reasoning_effort, "none");
      assert.equal(trace.requestSettings.max_tokens, 1_200);
      assert.equal(trace.requestSha256.length, 64);
      assert.ok(!Object.hasOwn(trace, "request"), "Do not retain repeated full prompt bodies");
      const raw = trace.response.choices[0].message.content;
      const parsed = parseFactualShadowAssessment(raw, item.shadowInput);
      if (item.shadow.status === "completed") assert.deepEqual(parsed, item.shadow.assessment);
      else {
        invalidShadowReplies++;
        assert.equal(item.shadow.reason, "invalid_response");
        assert.equal(parsed, undefined, "Invalid original output must not become a successful verdict");
      }
    }
  }
  assert.equal(invalidShadowReplies, 6);
});
