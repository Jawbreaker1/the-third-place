import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ACTORS } from "./dm-public-memory-chain-live-eval.mjs";
import { sceneCases, buildFrozenScene, buildRunPlan, stageSeed } from "./dm-research-memory-scene-live-eval.mjs";
import { evaluateProductionTask, FROZEN_SCENE_HARNESS_SHA256, FROZEN_MANIFEST_SHA256 } from "./dm-research-memory-production-live-eval.mjs";
import { adversarialCases, heldOutCases, deliveryCases, contractCases, parseOptions, projectSourceEpisode, projectSuccessfulResearch, createContractProjector, evaluateContractTask } from "./dm-turn-contract-live-eval.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const persona = { id: ACTORS.resident, name: "Mira", personality: "fixture" };
const verdict = { personaId: persona.id, severity: "none", issues: [], rewriteInstruction: null, sameSceneOverlap: "none", outputLanguage: { tag: "en", confidence: 1 } };
function fakeRuntime(Client = class {}) {
  const observations = { registryCalls: [], generatedScenes: [], reviewed: [] };
  class Registry {
    constructor(options) { observations.providers = options; }
    sceneContract(invocation, resolution, context) {
      observations.registryCalls.push(structuredClone({ invocation, resolution, context }));
      return { premise: resolution.state === "grounding_available" ? "raw production successful lookup" : "raw production failed lookup", groundingInstruction: "raw production evidence scope", evidenceOutcome: resolution.state === "grounding_available" ? "succeeded" : "failed", ...(resolution.research ? { research: structuredClone(resolution.research) } : {}), externalEvidence: true, suppressResponse: false, responsePolicy: invocation.responsePolicy };
    }
  }
  return { imported: { personas: { PERSONAS: [persona] }, capabilityRegistry: { CapabilityRegistry: Registry }, lmStudio: { LmStudioClient: Client } }, observations };
}

class RecordingClient {
  constructor({ backend }) { this.backend = backend; }
  async generateScene(scene) {
    await this.backend.complete({ messages: [{ role: "system", content: "production fixture writer" }, { role: "user", content: JSON.stringify(scene) }], response_format: { json_schema: { name: "social_scene" } } });
    await this.reviewCandidateLines(scene, [{ personaId: persona.id, content: "Generated test draft", sourceIds: [] }]);
    return [{ personaId: persona.id, content: "Generated test draft", sourceIds: [] }];
  }
  async reviewCandidateLines(scene, lines) {
    await this.backend.complete({ messages: [{ role: "system", content: "production fixture reviewer" }, { role: "user", content: JSON.stringify({ scene, lines }) }], response_format: { json_schema: { name: "multilingual_candidate_review" } } });
    return new Map([[persona.id, verdict]]);
  }
  applyCandidateReview(assessment) { return assessment; }
  cancelPending() {}
}
const transport = { providerId: "fixture", configuredModel: "fixture", async complete() { return { choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { completion_tokens: 1 } }; } };

test("original seven fixtures, evaluator bytes, plans and stage seeds are unchanged", async () => {
  assert.equal(sha(await readFile(new URL("./dm-research-memory-scene-live-eval.mjs", import.meta.url))), FROZEN_SCENE_HARNESS_SHA256);
  assert.equal(sha(JSON.stringify(contractCases.slice(0, 7))), FROZEN_MANIFEST_SHA256);
  assert.deepEqual(contractCases.slice(0, 7), sceneCases);
  assert.deepEqual(buildRunPlan(parseOptions(["--suite=frozen", "--repeats=3"]).selected, 3, "all"), buildRunPlan(sceneCases, 3, "all"));
  assert.equal(buildRunPlan(sceneCases, 3, "all").length, 66);
  assert.equal(stageSeed(contractCases[1], 2, "review-good", "multilingual_candidate_review"), 2811240);
  assert.equal(new Set(contractCases.map((item) => item.id)).size, contractCases.length);
  assert.equal(new Set(contractCases.map((item) => item.seedIndex)).size, contractCases.length);
});

test("suite selection and bounded execution options require no runtime or network", () => {
  assert.equal(parseOptions([]).selected.length, 23);
  assert.equal(parseOptions(["--suite=adversarial"]).selected.length, 3);
  assert.equal(parseOptions(["--suite=heldout"]).selected.length, 8);
  assert.equal(parseOptions(["--suite=delivery"]).selected.length, 5);
  assert.equal(buildRunPlan(contractCases, 3, "all").length, 213);
  assert.equal(buildRunPlan(contractCases, 3, "generation").length, 69);
  assert.equal(buildRunPlan(contractCases, 3, "review").length, 144);
  assert.equal(buildRunPlan(deliveryCases, 3, "review").length, 30);
  for (const args of [["--repeats=0"], ["--repeats=4"], ["--mode=judge"], ["--suite=nope"], ["--suite=frozen", `--cases=${heldOutCases[0].id}`], ["--repeats=1", "--repeats=2"]]) assert.throws(() => parseOptions(args));
});

test("delivery suite includes grounded omissions, missing feasible part and false current claims without rewriting old fixtures", () => {
  const byId = new Map(deliveryCases.map((item) => [item.id, item]));
  const onlyMemory = byId.get("de-delivery-mixed-only-memory");
  const onlyFailure = byId.get("en-delivery-mixed-only-failure");
  const threeParts = byId.get("en-delivery-three-parts-missing-third");
  const success = byId.get("en-delivery-success-generic-failure");
  const fabricated = byId.get("sv-delivery-recap-and-fabricated-current");
  assert.ok(onlyMemory.goodDraft.startsWith(onlyMemory.badDraft));
  assert.ok(onlyFailure.goodDraft.endsWith(onlyFailure.badDraft));
  assert.ok(threeParts.publicEpisode.utterance.includes("spacebar sticks"));
  assert.ok(!threeParts.badDraft.includes("spacebar"));
  assert.equal(threeParts.failedLookup, false);
  assert.equal(success.productionProjection.research.results[0].id, "S1");
  assert.equal(fabricated.failedLookup, true);
  assert.ok(fabricated.badDraft.includes("349"));
  assert.ok(!fabricated.publicEpisode.utterance.includes("349"));
  for (const item of deliveryCases) assert.ok(!sceneCases.some((old) => old.id === item.id));
  assert.equal(sha(JSON.stringify(sceneCases)), FROZEN_MANIFEST_SHA256);
});

test("grounded omissions require an overall delivery block without falsely expecting factual rejection", async () => {
  class OmissionClient extends RecordingClient {
    async reviewCandidateLines() {
      return new Map([[persona.id, { ...verdict, severity: "high", issues: ["unfulfilled_explicit_request"], rewriteInstruction: "Answer the remaining requested part." }]]);
    }
    applyCandidateReview(assessment) { return { ...assessment, acceptable: false }; }
  }
  for (const item of deliveryCases.filter((entry) => entry.expectedGroundingByTask)) {
    const result = await evaluateContractTask({ item, task: "review-bad", repetition: 1, runtime: fakeRuntime(OmissionClient), transport, model: "fixture" });
    assert.equal(result.error, undefined);
    assert.equal(result.fixtureGroup, "delivery");
    assert.equal(result.expectedDecision, "block");
    assert.equal(result.overallDecision, "block");
    assert.equal(result.expectedGroundingDecision, "allow");
    assert.equal(result.groundingDecision, "allow");
    assert.equal(result.matchesExpectedDecision, true);
    assert.equal(result.matchesExpectedGrounding, true);
  }
});

test("held-out evidence replaces only the public episode while preserving identities, provenance and question", () => {
  const item = heldOutCases[0], initial = buildFrozenScene(item, persona), before = structuredClone(initial);
  const scene = projectSourceEpisode(initial, item);
  assert.deepEqual(initial, before);
  assert.equal(scene.roomRecall.transcript[0].content, item.publicEpisode.utterance);
  assert.equal(scene.roomRecall.transcript[1].content, item.publicEpisode.reply);
  assert.ok(scene.publicParticipantNotes[persona.id].includes(item.publicEpisode.recollection));
  assert.deepEqual(scene.roomRecall.provenance, initial.roomRecall.provenance);
  assert.deepEqual(scene.trigger, initial.trigger);
  assert.deepEqual(scene.selected, initial.selected);
  assert.equal(scene.roomRecall.provenance[0].authorId, ACTORS.a);
  for (const forbidden of [item.rubric, item.goodDraft, item.badDraft]) assert.ok(!JSON.stringify(scene).includes(forbidden));
  assert.ok(!JSON.stringify(scene).includes("postcard"));
  assert.deepEqual(projectSourceEpisode(buildFrozenScene(sceneCases[0], persona), sceneCases[0]), buildFrozenScene(sceneCases[0], persona));
});

test("new topics are independent of frozen questions and evidence, with explicit controls", () => {
  const frozenQuestions = new Set(sceneCases.map((item) => item.question));
  for (const item of heldOutCases) assert.ok(!frozenQuestions.has(item.question));
  const episodes = heldOutCases.filter((item) => item.publicEpisode);
  assert.equal(new Set(episodes.map((item) => item.publicEpisode.utterance)).size, episodes.length);
  assert.equal(new Set(episodes.map((item) => item.publicEpisode.recollection)).size, episodes.length);
  assert.ok(heldOutCases.some((item) => item.staleDraft));
  assert.ok(heldOutCases.some((item) => item.withoutPublicMemory && !item.failedLookup));
  const wrong = heldOutCases.find((item) => item.id === "fr-heldout-other-person-pottery");
  const wrongScene = projectSourceEpisode(buildFrozenScene(wrong, persona), wrong);
  assert.ok(wrong.question.includes("LindenFox"));
  assert.equal(wrongScene.roomRecall.provenance[0].authorId, ACTORS.a);
  assert.ok(!wrongScene.publicParticipantNotes[persona.id].includes(ACTORS.b));
  for (const item of adversarialCases) {
    assert.ok(item.goodDraft.length > 20 && item.badDraft.length > 40);
    assert.notEqual(item.goodDraft, item.badDraft);
    assert.ok(!Object.hasOwn(item, "privateHistory"));
  }
});

test("generation sends source evidence but never any gold draft, rubric or expected verdict", async () => {
  for (const item of contractCases) {
    const result = await evaluateContractTask({ item, task: "generation", repetition: 1, runtime: fakeRuntime(RecordingClient), transport, model: "fixture" });
    assert.equal(result.error, undefined, item.id);
    assert.equal(result.calls.length, 2);
    for (const call of result.calls) {
      const sent = JSON.stringify(call.request);
      for (const fixture of contractCases) for (const forbidden of [fixture.rubric, fixture.goodDraft, fixture.badDraft, fixture.staleDraft].filter(Boolean)) assert.ok(!sent.includes(forbidden), `${item.id}: gold leaked`);
      assert.ok(!sent.includes("expectedDecision"));
      assert.ok(!sent.includes('"rubric"'));
    }
    if (item.publicEpisode) {
      assert.ok(result.calls[0].request.messages[1].content.includes(item.publicEpisode.utterance));
      assert.equal(result.scene.roomRecall.transcript[0].content, item.publicEpisode.utterance);
    }
  }
});

test("fixed review receives its one test draft and real registry fields but no verdict or counterpart", async () => {
  const item = adversarialCases[1], runtime = fakeRuntime(RecordingClient);
  const result = await evaluateContractTask({ item, task: "review-bad", repetition: 2, runtime, transport, model: "fixture" });
  assert.equal(result.error, undefined);
  assert.equal(result.expectedDecision, "block");
  assert.equal(result.matchesExpectedDecision, false);
  assert.equal(result.calls.length, 1);
  const sent = result.calls[0].request.messages[1].content;
  assert.ok(sent.includes(item.badDraft));
  assert.ok(!sent.includes(item.goodDraft));
  assert.ok(!sent.includes(item.rubric));
  assert.ok(!sent.includes("expectedDecision"));
  assert.equal(result.scene.premise, "raw production failed lookup");
  assert.equal(runtime.observations.registryCalls[0].invocation.goal, item.question);
  assert.equal(result.reviews[0].sceneSha256, result.sceneSha256);
  assert.throws(() => runtime.observations.providers.researchBroker.research());
});

test("candidate initial projection calls its real Director DM seam with the raw contract and source-only premise", () => {
  for (const item of contractCases) {
    const runtime = fakeRuntime(), calls = [];
    runtime.imported.lmStudio.dmCapabilitySceneRequest = (scene, contract) => {
      calls.push(structuredClone({ scene, contract }));
      return { ...scene, fixtureProductionSeam: true };
    };
    const input = buildFrozenScene(item, persona), before = structuredClone(input);
    const projected = createContractProjector(runtime, item)(input);
    assert.equal(calls.length, 1);
    assert.equal(projected.projection, "production_dm_turn_contract");
    assert.equal(projected.scene.fixtureProductionSeam, true);
    assert.equal(calls[0].scene.premise, undefined);
    assert.deepEqual(input, before);
    assert.deepEqual(calls[0].scene.trigger, input.trigger);
    if (item.failedLookup) {
      assert.equal(calls[0].contract.premise, "raw production failed lookup");
      assert.equal(calls[0].contract.groundingInstruction, "raw production evidence scope");
      assert.equal(calls[0].scene.capabilityGroundingInstruction, undefined);
    } else if (item.productionProjection) {
      assert.equal(calls[0].contract.premise, "raw production successful lookup");
      assert.equal(calls[0].contract.evidenceOutcome, "succeeded");
      assert.equal(calls[0].scene.capabilityContext.executionStatus, "succeeded");
      assert.deepEqual(calls[0].contract.research, item.productionProjection.research);
    } else assert.equal(calls[0].contract, undefined);
    if (item.publicEpisode) assert.equal(calls[0].scene.roomRecall.transcript[0].content, item.publicEpisode.utterance);
  }
});

test("success fixtures use readable sources and real success contract without mutating input", () => {
  const successes = heldOutCases.filter((item) => item.productionProjection);
  assert.equal(successes.length, 3);
  for (const item of successes) {
    const runtime = fakeRuntime(), original = projectSourceEpisode(buildFrozenScene(item, persona), item), before = structuredClone(original);
    const result = projectSuccessfulResearch(runtime, original, item);
    assert.deepEqual(original, before);
    assert.equal(result.resolution.state, "grounding_available");
    assert.equal(result.resolution.detail, "ok");
    assert.equal(result.scene.evidenceOutcome, "succeeded");
    assert.equal(result.scene.capabilityContext.executionStatus, "succeeded");
    assert.equal(result.scene.research.kind, "page");
    assert.equal(result.scene.research.results[0].id, "S1");
    assert.ok(result.scene.research.results[0].snippet.length > 100);
    assert.deepEqual(runtime.observations.registryCalls[0].resolution.research, item.productionProjection.research);
    assert.throws(() => runtime.observations.providers.pageReader.read());
  }
});

test("fixed successful drafts carry source IDs, but generation citations are never supplied by harness", async () => {
  const item = heldOutCases.find((entry) => entry.id === "en-heldout-success-current-hours");
  for (const task of ["review-good", "review-bad"]) {
    const result = await evaluateContractTask({ item, task, repetition: 1, runtime: fakeRuntime(RecordingClient), transport, model: "fixture" });
    assert.equal(result.error, undefined);
    const payload = JSON.parse(result.calls[0].request.messages[1].content);
    assert.deepEqual(payload.lines[0].sourceIds, ["S1"]);
    assert.deepEqual(result.reviews[0].lines[0].sourceIds, ["S1"]);
    assert.equal(payload.scene.evidenceOutcome, "succeeded");
  }
  const generated = await evaluateContractTask({ item, task: "generation", repetition: 1, runtime: fakeRuntime(RecordingClient), transport, model: "fixture" });
  assert.equal(generated.error, undefined);
  assert.deepEqual(generated.lines[0].sourceIds, []);
  assert.deepEqual(generated.reviews[0].lines[0].sourceIds, []);
});

test("candidate seam applies once, including before fixed review, without rewriting recovery", async () => {
  let seamCalls = 0;
  const seen = [];
  class Client {
    async generateScene(scene) {
      seen.push(scene.premise);
      await this.reviewCandidateLines({ ...scene, premise: "candidate recovery owns this" }, []);
      return [];
    }
    async reviewCandidateLines(scene) { seen.push(scene.premise); return new Map([[persona.id, verdict]]); }
    applyCandidateReview(assessment) { return assessment; }
    cancelPending() {}
  }
  const runtime = fakeRuntime(Client);
  runtime.imported.lmStudio.dmCapabilitySceneRequest = (scene) => { seamCalls++; return { ...scene, premise: "production DM seam" }; };
  const options = { item: heldOutCases[0], repetition: 1, runtime, transport, model: "fixture" };
  const generated = await evaluateContractTask({ ...options, task: "generation" });
  assert.equal(generated.error, undefined);
  assert.equal(seamCalls, 1);
  assert.deepEqual(seen, ["production DM seam", "candidate recovery owns this"]);
  const reviewed = await evaluateContractTask({ ...options, task: "review-good" });
  assert.equal(reviewed.error, undefined);
  assert.equal(seamCalls, 2);
  assert.equal(seen[2], "production DM seam");
});

test("frozen fixture model inputs remain byte-identical to the existing production evaluator", async () => {
  for (const item of sceneCases) {
    for (const task of ["generation", "review-good", "review-bad"]) {
      const options = { item, task, repetition: 2, transport, model: "fixture" };
      const old = await evaluateProductionTask({ ...options, runtime: fakeRuntime(RecordingClient) });
      const current = await evaluateContractTask({ ...options, runtime: fakeRuntime(RecordingClient) });
      assert.equal(current.error, undefined);
      assert.deepEqual(current.scene, old.scene);
      assert.deepEqual(current.calls.map((call) => call.request), old.calls.map((call) => call.request));
      assert.deepEqual(current.reviews, old.reviews);
      assert.equal(current.fixtureGroup, "frozen");
    }
  }
});

test("projection does not rewrite production recovery or add public/private source metadata", async () => {
  const seen = [];
  class RecoveryClient {
    async generateScene(scene) {
      seen.push(scene);
      await this.reviewCandidateLines({ ...scene, premise: "production-owned recovery", roomRecall: undefined }, []);
      return [];
    }
    async reviewCandidateLines(scene) { seen.push(scene); return new Map([[persona.id, verdict]]); }
    cancelPending() {}
  }
  const item = heldOutCases[0], runtime = fakeRuntime(RecoveryClient);
  const result = await evaluateContractTask({ item, task: "generation", repetition: 1, runtime, transport, model: "fixture" });
  assert.equal(result.error, undefined);
  assert.equal(runtime.observations.registryCalls.length, 1);
  assert.equal(seen[0].premise, "raw production failed lookup");
  assert.equal(seen[1].premise, "production-owned recovery");
  assert.equal(seen[1].roomRecall, undefined);
  assert.deepEqual(Object.keys(result.scene.roomRecall), ["sourceChannel", "witnessPersonaIds", "transcript", "provenance"]);
  assert.equal(result.reviews[0].scene.premise, "production-owned recovery");
});

test("dry-run requires no model/runtime and emits all selected bounded tasks", () => {
  const result = spawnSync(process.execPath, ["scripts/dm-turn-contract-live-eval.mjs", "--dry-run", "--repeats=3"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.modelCalls, 0);
  assert.equal(report.runPlan.length, 213);
  assert.equal(report.suite, "all");
});
