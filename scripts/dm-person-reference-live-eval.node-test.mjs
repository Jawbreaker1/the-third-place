import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readEvaluationText } from "./evaluation-archive.mjs";
import { scenarios, externalLookupControl } from "./dm-public-memory-live-eval.mjs";
import { controls, inputForControl } from "./dm-classification-controls-live-eval.mjs";
import { assessIdentity, BASELINE_REPORT, buildManifest, buildRunPlan, identityControls, loadRuntime, MAX_RESOLVER_TOKENS,
  parseOptions, runFixture, selectFixtures, stageSeed, summarize, toResolverInput } from "./dm-person-reference-live-eval.mjs";

test("fixed manifest preserves eight original scenarios, external control, ten existing controls and ten new identity cases", async () => {
  const manifest = await buildManifest();
  assert.equal(manifest.fixtures.length, 29);
  assert.equal(new Set(manifest.fixtures.map((fixture) => fixture.id)).size, 29);
  assert.deepEqual(manifest.fixtures.slice(0, 8).map((fixture) => fixture.input.latestMessage.content), scenarios.map((fixture) => fixture.text));
  assert.equal(manifest.fixtures[8].input.latestMessage.content, externalLookupControl.text);
  assert.deepEqual(manifest.fixtures.slice(9, 19).map((fixture) => fixture.input), controls.map((control) => inputForControl(control)));
  assert.equal(identityControls.length, 10);
  assert.deepEqual([...new Set(identityControls.map((fixture) => fixture.language))].sort(), ["ar", "de", "es", "fr", "ja", "pt", "sv"]);
});

test("archived inputs and full manifest hashes are deterministic; original filtered duplicate catalog is not rebuilt", async () => {
  const first = await buildManifest(), second = await buildManifest();
  assert.deepEqual(first, second);
  const archive = JSON.parse(await readEvaluationText(BASELINE_REPORT));
  for (const fixture of first.fixtures.slice(0, 8)) {
    const archived = archive.scenarios.find((row) => row.id === fixture.id && row.repetition === 1).calls.find((call) => call.schema === "multilingual_turn_router_v2").userPayload[0];
    const replay = structuredClone(archived);
    delete replay.transportLanguageHint;
    assert.deepEqual(fixture.input, replay);
    assert.deepEqual(fixture.inputNormalizations, [{ field: "transportLanguageHint", archivedValue: null, replayValue: "omitted" }]);
  }
  assert.deepEqual(first.fixtures.find((fixture) => fixture.id === "en-ambiguous").input.humanCandidates, []);
  assert.equal(first.manifestSha256.length, 64);
});

test("narrow payload contains only current DM pair and public identity catalog, never expectations or other-thread facts", async () => {
  const { fixtures } = await buildManifest();
  const fixture = fixtures[0];
  const contaminated = { ...fixture.input, expected: "ORACLE_EXPECTATION", secret: "FORBIDDEN_PRIVATE",
    recentMessages: [...fixture.input.recentMessages, { id: "foreign", authorId: "another-pair", content: "FORBIDDEN_PRIVATE" }],
    publicMemory: { text: "FORBIDDEN_PRIVATE" } };
  const input = toResolverInput(contaminated);
  assert.deepEqual(Object.keys(input).sort(), ["latestMessage", "publicHumanCandidates", "recentMessages", "residentId", "speakerId"]);
  assert.ok(!JSON.stringify(input).includes("ORACLE_EXPECTATION"));
  assert.ok(!JSON.stringify(input).includes("FORBIDDEN_PRIVATE"));
  assert.ok(!JSON.stringify(input).includes(fixture.id));
  assert.equal(input.latestMessage.content, fixture.input.latestMessage.content);
  assert.deepEqual(input.publicHumanCandidates, fixture.input.humanCandidates);
});

test("candidate permutation differs only in catalog order and shares an independent stage seed", async () => {
  const { fixtures } = await buildManifest();
  const a = fixtures.find((fixture) => fixture.id === "pt-candidate-order-a"), b = fixtures.find((fixture) => fixture.id === "pt-candidate-order-b");
  assert.deepEqual({ ...a.input, humanCandidates: [...a.input.humanCandidates].reverse() }, b.input);
  assert.equal(a.seedIndex, b.seedIndex);
  assert.equal(stageSeed(a.seedIndex, 1, "multilingual_turn_router_v2"), stageSeed(b.seedIndex, 1, "dm_public_person_reference_v1"));
  assert.notEqual(stageSeed(a.seedIndex, 1, "dm_public_person_reference_v1"), stageSeed(a.seedIndex, 2, "dm_public_person_reference_v1"));
  assert.notEqual(stageSeed(a.seedIndex, 1, "multilingual_evidence_plan_verifier_v1"), stageSeed(a.seedIndex, 1, "dm_public_person_reference_v1"));
  assert.throws(() => stageSeed(0, 1, "writer"));
});

test("strict options preserve fixed run order and prohibit non-temp outputs or uncontrolled repeats", async () => {
  const manifest = await buildManifest();
  const selected = selectFixtures(manifest, ["sv-public", "ar-named-reference"]);
  assert.deepEqual(buildRunPlan(selected, 2).map(({ fixture, repetition }) => `${fixture.id}#${repetition}`), ["sv-public#1", "ar-named-reference#1", "sv-public#2", "ar-named-reference#2"]);
  assert.equal(parseOptions([]).mode, "candidate");
  assert.equal(parseOptions([]).repeats, 2);
  for (const argv of [["--mode=production"], ["--repeats=3"], ["--repeats=0"], ["--repeats=1.5"], ["--output=/etc/report"], ["--cases=x,x"], ["--unknown"], ["--mode=baseline", "--mode=candidate"]]) assert.throws(() => parseOptions(argv));
  assert.throws(() => selectFixtures(manifest, ["not-a-case"]));
});

test("assessment separates wrong IDs, missed matches, unsupported status and schema failure without prose grading", () => {
  const fixture = { expected: { selectedIds: ["known"], statuses: ["matched"] } };
  const valid = { schemaValid: true, selectedIds: ["known"], resolution: { status: "matched" } };
  assert.equal(assessIdentity(fixture, valid, "candidate").passed, true);
  const wrong = assessIdentity(fixture, { ...valid, selectedIds: ["other"] }, "candidate");
  assert.equal(wrong.falseMatch, true); assert.equal(wrong.missedMatch, true);
  assert.equal(assessIdentity(fixture, { ...valid, schemaValid: false }, "candidate").passed, false);
  assert.equal(assessIdentity(fixture, { ...valid, resolution: { status: "unknown" } }, "candidate").passed, false);
  assert.equal(assessIdentity(fixture, { ...valid, resolution: undefined }, "baseline").statusMatches, null);
  const rows = [{ inputSchemaValid: false, assessment: { valid: false } }, { inputSchemaValid: true, assessment: { valid: false } }, { inputSchemaValid: true, assessment: { valid: true, passed: true } }];
  assert.deepEqual(summarize(rows), { total: 3, passed: 1, failed: 0, unavailable: 1, falseMatches: 0, missedMatches: 0, eligibleInputs: 2, inputRejected: 1 });
});

test("all candidate inputs validate; duplicate labels stay explicit and baseline alone rejects that extra capability edge", async () => {
  const { fixtures } = await buildManifest();
  const candidate = await loadRuntime(undefined, "candidate"), baseline = await loadRuntime(undefined, "baseline");
  for (const fixture of fixtures) {
    const parsed = candidate.imported.dmPersonReference.dmPersonReferenceInputSchema.safeParse(toResolverInput(fixture.input));
    assert.equal(parsed.success, true, `${fixture.id}: ${parsed.error?.message ?? ""}`);
    const old = baseline.imported.semanticRouter.turnAnalysisInputSchema.safeParse(fixture.input);
    assert.equal(old.success, fixture.id !== "fr-duplicate-display-labels", fixture.id);
  }
});

test("import and dry run have no network, runtime-loading or report-writing side effects", () => {
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", "globalThis.fetch=()=>{throw Error('network forbidden')}; await import('./scripts/dm-person-reference-live-eval.mjs'); console.log('import-safe');"], { encoding: "utf8" });
  assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout.trim(), "import-safe");
  const dry = spawnSync(process.execPath, ["scripts/dm-person-reference-live-eval.mjs", "--dry-run", "--runtime-root=/does-not-exist", "--cases=sv-public"], { encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr); assert.equal(JSON.parse(dry.stdout).modelCalls, 0);
});

test("candidate runner uses one real prompt/parser contract with fixed settings and preserves exact raw output", async () => {
  const runtime = await loadRuntime(undefined, "candidate"), { fixtures } = await buildManifest();
  const fixture = fixtures.find((item) => item.id === "en-unknown"), requests = [];
  const raw = JSON.stringify({ status: "unknown", references: [], confidence: 1 });
  const transport = { providerId: "lmstudio", configuredModel: "synthetic-model", complete: async (request) => {
    requests.push(request); return { choices: [{ finish_reason: "stop", message: { content: raw } }], usage: { prompt_tokens: 100, completion_tokens: 20 } };
  } };
  const result = await runFixture({ fixture, repetition: 1, mode: "candidate", runtime, transport });
  assert.equal(requests.length, 1); assert.equal(requests[0].max_tokens, MAX_RESOLVER_TOKENS);
  assert.equal(requests[0].temperature, 0); assert.equal(requests[0].top_p, 1); assert.equal(requests[0].reasoning_effort, "none");
  assert.equal(requests[0].seed, stageSeed(fixture.seedIndex, 1, "multilingual_turn_router_v2"));
  assert.equal(result.calls[0].content, raw); assert.equal(result.assessment.passed, true);
  assert.equal(result.nonIdentityFieldsAssessed, false);
  assert.ok(!JSON.stringify(requests).includes("selectedIds"));
});

test("invalid or truncated resolver output is never promoted to a successful abstention", async () => {
  const runtime = await loadRuntime(undefined, "candidate"), { fixtures } = await buildManifest();
  const fixture = fixtures.find((item) => item.id === "en-unknown");
  for (const [raw, finishReason] of [["{}", "stop"], [JSON.stringify({ status: "unknown", references: [], confidence: 1 }), "length"]]) {
    const transport = { providerId: "lmstudio", configuredModel: "synthetic-model", complete: async () => ({ choices: [{ finish_reason: finishReason, message: { content: raw } }] }) };
    const result = await runFixture({ fixture, repetition: 1, mode: "candidate", runtime, transport });
    assert.equal(result.calls[0].content, raw); assert.equal(result.schemaValid, false); assert.equal(result.assessment.passed, false);
    assert.deepEqual(result.selectedIds, []);
  }
});
