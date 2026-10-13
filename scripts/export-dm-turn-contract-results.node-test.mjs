import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compactCall, compactReports, completionFor, main, parseOptions } from "./export-dm-turn-contract-results.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const scene = { kind: "dm", trigger: { author: "Sam", content: "What do you remember?" }, roomRecall: { transcript: [{ author: "EmberOtter", content: "I repair clocks." }] } };
const sceneSha = sha(JSON.stringify(scene));
const sourceDraft = "They repaired a clock.";
const output = { reviews: [{ personaId: "mira", severity: "high", issues: ["unfulfilled_explicit_request"], requestDelivery: { status: "missing", parts: [{ outcome: "identify repair", status: "delivered", deliveredExcerpt: sourceDraft }, { outcome: "current price", status: "missing", deliveredExcerpt: null }] } }] };
function call() {
  const request = { model: "fixture", seed: 2710020, temperature: 0.2, max_tokens: 700, messages: [{ role: "system", content: "LONG FULL MODEL PROMPT THAT MUST NOT BE EXPORTED" }, { role: "user", content: JSON.stringify({ scene, draft: sourceDraft }) }], response_format: { type: "json_schema", json_schema: { name: "multilingual_candidate_review", schema: { type: "object" } } } };
  return { schema: "multilingual_candidate_review", occurrence: 0, request, requestSha256: sha(JSON.stringify(request)), userPayloadSha256: sha(JSON.stringify(request.messages.filter((message) => message.role === "user"))), systemSha256: sha(JSON.stringify(request.messages.filter((message) => message.role === "system"))), settings: { seed: request.seed, temperature: request.temperature, maxTokens: request.max_tokens }, content: JSON.stringify(output), parsed: structuredClone(output), usage: { completion_tokens: 37, prompt_tokens: 400 }, elapsedMs: 321, finishReason: "stop" };
}
function result(task = "review-bad") {
  return { id: "example", task, repetition: 1, rubric: "A complete reply answers both parts.", scene: structuredClone(scene), sceneSha256: sceneSha, fixtureBaseScene: structuredClone(scene), fixtureBaseSceneSha256: sceneSha,
    contractProjection: { projection: "production_dm_turn_contract", scene: structuredClone(scene), rawContract: { evidenceOutcome: "failed", premise: "Raw failed lookup" } },
    calls: [call()], reviews: [{ scene: structuredClone(scene), sceneSha256: sceneSha, lines: [{ content: sourceDraft }], verdicts: [{ personaId: "mira", verdict: structuredClone(output.reviews[0]) }] }],
    entryPointReviews: [{ sceneSha256: sceneSha, lines: [{ content: sourceDraft }], verdicts: [{ personaId: "mira", verdict: structuredClone(output.reviews[0]) }] }], lines: task === "generation" ? [{ content: sourceDraft }] : [], privacyViolations: ["synthetic-private-sentinel"], elapsedMs: 567,
    ...(task === "generation" ? {} : { review: structuredClone(output.reviews[0]), draft: sourceDraft, overallDecision: "block", expectedDecision: "block", groundingDecision: "allow", expectedGroundingDecision: "allow", matchesExpectedDecision: true, matchesExpectedGrounding: true }),
  };
}
function report(results = [result()]) {
  return { label: "candidate-fixture", runtimeRoot: "/private/tmp/frozen-runtime", runtimeHashes: { lmStudio: "abc", dmTurnEvidence: "def" }, harnessSha256: "harness", manifest: [{ id: "example", question: "What do you remember?", rubric: "A complete reply answers both parts.", goodDraft: "Complete", badDraft: sourceDraft }], mode: "all", repeats: 1, results };
}
const source = (value, path = "/private/tmp/test-report.json") => ({ path, bytes: Buffer.from(JSON.stringify(value)) });

test("retains raw/validated outputs, normalized delivery parts, runtime identity, timing and privacy flags", () => {
  const original = report(), before = structuredClone(original), compact = compactReports([source(original)]);
  assert.deepEqual(original, before);
  const exported = compact.reports[0], row = exported.results[0];
  assert.deepEqual(exported.metadata.runtimeHashes, original.runtimeHashes);
  assert.deepEqual(row.review, original.results[0].review);
  assert.deepEqual(row.reviews[0].verdicts, original.results[0].reviews[0].verdicts);
  assert.deepEqual(row.calls[0].parsed, original.results[0].calls[0].parsed);
  assert.equal(row.calls[0].content, original.results[0].calls[0].content);
  assert.deepEqual(row.calls[0].settings, original.results[0].calls[0].settings);
  assert.deepEqual(row.calls[0].usage, original.results[0].calls[0].usage);
  assert.equal(row.calls[0].elapsedMs, 321);
  assert.equal(row.elapsedMs, 567);
  assert.deepEqual(row.privacyViolations, ["synthetic-private-sentinel"]);
  assert.equal(row.outcomeSummary.publicationDecision, "block");
  assert.equal(row.outcomeSummary.expectedGroundingDecision, "allow");
  assert.equal(row.reviews[0].verdictValidation, "validated");
});

test("omits full prompt messages/schema, verifies hashes and retains source scenes once", () => {
  const original = report([result(), result("generation")]);
  const compact = compactReports([source(original), source(original, "/private/tmp/second-report.json")]);
  const text = JSON.stringify(compact), first = compact.reports[0].results[0];
  assert.ok(!text.includes("LONG FULL MODEL PROMPT THAT MUST NOT BE EXPORTED"));
  assert.ok(!Object.hasOwn(first.calls[0], "request"));
  assert.equal(first.calls[0].requestSha256, original.results[0].calls[0].requestSha256);
  assert.equal(first.calls[0].messagesSha256, sha(JSON.stringify(original.results[0].calls[0].request.messages)));
  assert.equal(first.calls[0].responseFormatSha256, sha(JSON.stringify(original.results[0].calls[0].request.response_format)));
  assert.equal(first.calls[0].requestParameters.seed, 2710020);
  assert.equal(Object.keys(compact.dictionaries.scenes).length, 1);
  assert.equal(Object.keys(compact.dictionaries.projections).length, 1);
  assert.deepEqual(compact.dictionaries.scenes[first.sceneRef], scene);
  assert.equal(first.reviews[0].sceneRef, first.sceneRef);
  assert.equal(compact.reports[1].results[0].sceneRef, first.sceneRef);
  const corrupted = call(); corrupted.request.messages[0].content = "changed";
  assert.throws(() => compactCall(corrupted));
});

test("no validated review remains invalid/unknown instead of becoming a semantic rejection", () => {
  const invalid = result();
  for (const key of ["review", "overallDecision", "groundingDecision", "matchesExpectedDecision", "matchesExpectedGrounding"]) delete invalid[key];
  invalid.error = "No validated review returned";
  invalid.reviews[0].verdicts = null;
  invalid.calls[0].content = "{malformed output";
  invalid.calls[0].parsed = null;
  const row = compactReports([source(report([invalid]))]).reports[0].results[0];
  assert.equal(row.outcomeSummary.validation, "no_validated_verdict");
  assert.equal(row.outcomeSummary.publicationDecision, null);
  assert.equal(row.outcomeSummary.groundingDecision, null);
  assert.equal(row.outcomeSummary.expectedPublicationDecision, "block");
  assert.equal(row.error, invalid.error);
  assert.equal(row.reviews[0].verdictValidation, "no_validated_verdict");
  assert.equal(row.calls[0].content, "{malformed output");
  assert.equal(row.calls[0].parsed, null);
});

test("retains task kinds and generation prose without implying app publication", () => {
  const rows = ["generation", "review-good", "review-bad", "review-stale"].map(result);
  const compact = compactReports([source(report(rows))]).reports[0];
  assert.deepEqual(compact.results.map((row) => row.task), ["generation", "review-good", "review-bad", "review-stale"]);
  assert.equal(compact.results[0].outcomeSummary.delivery, "reply_returned");
  assert.equal(compact.results[0].lines[0].content, sourceDraft);
  const missing = result("generation"); missing.lines = []; missing.error = "deadline";
  const row = compactReports([source(report([missing]))]).reports[0].results[0];
  assert.equal(row.outcomeSummary.delivery, "no_reply");
  assert.equal(row.outcomeSummary.executionError, "deadline");
});

test("partial runs preserve planned/missing counts and stale tasks; duplicates are not complete", () => {
  const partial = report([result()]); partial.manifest[0].staleDraft = "old datum"; partial.repeats = 3;
  const summary = completionFor(partial);
  assert.equal(summary.expectedTaskCount, 12);
  assert.equal(summary.observedTaskCount, 1);
  assert.equal(summary.missingTaskKeys.length, 11);
  assert.equal(summary.state, "partial_or_mismatched");
  const complete = report([result("generation"), result("review-good"), result("review-bad")]);
  assert.equal(completionFor(complete).state, "complete");
  complete.results.push(result("review-bad"));
  assert.equal(completionFor(complete).state, "partial_or_mismatched");
  assert.deepEqual(completionFor(complete).duplicateTaskKeys, ["example/review-bad#1"]);
});

test("export is deterministic for identical source bytes and records their provenance", () => {
  const bytes = source(report());
  const first = compactReports([bytes]), second = compactReports([bytes]);
  assert.deepEqual(first, second);
  assert.equal(first.reports[0].sourceSha256, sha(bytes.bytes));
  assert.equal(first.reports[0].sourceBytes, bytes.bytes.length);
});

test("CLI rejects duplicate/colliding inputs and refuses implicit overwrite", async () => {
  assert.throws(() => parseOptions([]));
  assert.throws(() => parseOptions(["/tmp/report.json", "--output=/tmp/report.json"]));
  assert.throws(() => parseOptions(["/tmp/report.json", "/tmp/report.json", "--output=/tmp/export.json"]));
  assert.throws(() => parseOptions(["/tmp/report.json", "--output=/tmp/a.json", "--output=/tmp/b.json"]));
  const directory = await mkdtemp(join(tmpdir(), "dm-compact-export-test-"));
  try {
    const input = join(directory, "report.json"), outputPath = join(directory, "compact.json");
    await writeFile(input, JSON.stringify(report()));
    await main([input, `--output=${outputPath}`]);
    assert.equal(JSON.parse(await readFile(outputPath, "utf8")).format, "third-place-dm-turn-contract-compact");
    await assert.rejects(main([input, `--output=${outputPath}`]));
    assert.equal(JSON.parse(await readFile(input, "utf8")).label, "candidate-fixture");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
