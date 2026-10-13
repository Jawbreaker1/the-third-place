#!/usr/bin/env node

// Conditional component comparison, not an end-to-end routing evaluation.
// Reuses the frozen seven-case scene suite without modifying its inputs/seeds.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FIXED_NOW } from "./dm-public-memory-live-eval.mjs";
import { sceneCases, parseOptions, buildRunPlan, evaluateTask, MAX_CALLS, DEADLINE_MS } from "./dm-research-memory-scene-live-eval.mjs";
import { loadRuntime, validateOutputPath } from "./personal-context-review-live-eval.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const copy = (value) => structuredClone(value);
export const FROZEN_SCENE_HARNESS_SHA256 = "bbcba5b89324fa028fa28165f95818a291a68ee2e071c0fb45200e63b21ad020";
export const FROZEN_MANIFEST_SHA256 = "d0e716c088346169137b0e9b7bc4f288a225cfee3ddee452192225b0a4f7aa50";

export async function loadProductionRuntime(root) {
  if (!root) throw new Error("--runtime-root is required for reproducible compiled component evaluation");
  const runtime = await loadRuntime(root);
  for (const [name, relative, optional] of [["capabilityRegistry", "capabilities/registry.js", false], ["capabilityCatalog", "capabilities/catalog.js", false], ["dmEvidenceScope", "dmEvidenceScope.js", true]]) {
    const url = pathToFileURL(join(resolve(root), "server", relative));
    let bytes;
    try { bytes = await readFile(url); }
    catch (error) { if (optional && error?.code === "ENOENT") { runtime.hashes[name] = null; continue; } throw error; }
    runtime.hashes[name] = sha(bytes);
    runtime.imported[name] = await import(url.href);
  }
  const frozen = await readFile(new URL("./dm-research-memory-scene-live-eval.mjs", import.meta.url));
  if (sha(frozen) !== FROZEN_SCENE_HARNESS_SHA256 || sha(JSON.stringify(sceneCases)) !== FROZEN_MANIFEST_SHA256) throw new Error("Frozen evaluator or fixture manifest changed");
  return runtime;
}

export function createSceneProjector(runtime, item) {
  // Providers are deliberately unavailable. Only sceneContract is called.
  const noProvider = () => { throw new Error("Component test must never execute an external provider"); };
  const registry = new runtime.imported.capabilityRegistry.CapabilityRegistry({
    pageReader: { read: noProvider }, researchBroker: { research: noProvider, researchSite: noProvider },
    marketSnapshotProvider: null, footballCompetitionProvider: null, weatherForecastProvider: null, now: () => FIXED_NOW,
  });
  return (input) => {
    const scene = copy(input);
    if (!item.failedLookup) return { scene, contract: null, projection: "no_lookup" };
    const owner = scene.selected[0];
    if (!owner || scene.kind !== "dm") throw new Error("Expected a fixed single-resident DM scene");
    const responsePolicy = { owner: "designated_responder", citations: "model_selected", linkCard: "selected", maxSources: 3 };
    const invocation = { capability: "web_search", goal: item.question, requestKind: "execute", externalEvidence: true, requiresResearchPersona: true,
      responsePolicy, searchRequest: { query: item.question, mode: "web", requesterId: scene.trigger.authorId } };
    const resolution = { invocation, state: "failed_temporary", detail: "empty", responsePolicy };
    const raw = registry.sceneContract(invocation, resolution, { actorName: owner.name });
    const available = runtime.imported.lmStudio.hasIndependentDmEvidence;
    const scope = runtime.imported.dmEvidenceScope?.scopeDmCapabilityScene;
    const independentEvidenceAvailable = typeof available === "function" && available(scene);
    if (independentEvidenceAvailable && typeof scope !== "function") throw new Error("Evidence gate exists without its production scoping function");
    const contract = independentEvidenceAvailable ? scope(raw) : raw;
    // Mirrors the capability-owned fields of SocialDirector's DM SceneRequest.
    // The original frozen semantic/person/source fields are not changed.
    scene.research = contract.research;
    scene.evidenceOutcome = contract.evidenceOutcome;
    scene.capabilityGroundingInstruction = contract.groundingInstruction;
    scene.urlPublicationPolicy = contract.urlPublicationPolicy;
    scene.requestedClock = contract.requestedClock;
    scene.temporalPolicy = contract.temporalPolicy ?? "reactive_only";
    scene.temporalSurfaceActorId = contract.temporalPolicy ? owner.id : undefined;
    scene.premise = contract.premise || undefined;
    return { scene, contract: copy(contract), rawContract: copy(raw), invocation: copy(invocation), resolution: copy(resolution),
      projection: independentEvidenceAvailable ? "production_scoped_dm" : "production_raw", independentEvidenceAvailable };
  };
}

export function withInitialSceneProjection(runtime, project, observed) {
  const Base = runtime.imported.lmStudio.LmStudioClient;
  class ProjectedClient extends Base {
    initialProjectionApplied = false;
    projectInitial(request) {
      if (this.initialProjectionApplied) return request;
      const projected = project(request);
      this.initialProjectionApplied = true;
      observed.projection = copy(projected);
      return projected.scene;
    }
    generateScene(request, ...rest) {
      return super.generateScene(this.projectInitial(request), ...rest);
    }
    async reviewCandidateLines(request, lines, ...rest) {
      const actual = this.projectInitial(request);
      const before = copy(actual);
      const verdicts = await super.reviewCandidateLines(actual, lines, ...rest);
      observed.reviews.push({ scene: before, sceneSha256: sha(JSON.stringify(before)), lines: copy(lines),
        verdicts: verdicts ? [...verdicts].map(([personaId, verdict]) => ({ personaId, verdict: copy(verdict) })) : null });
      return verdicts;
    }
  }
  return { ...runtime, imported: { ...runtime.imported, lmStudio: { ...runtime.imported.lmStudio, LmStudioClient: ProjectedClient } } };
}

export async function evaluateProductionTask(options) {
  const observed = { reviews: [] };
  const runtime = withInitialSceneProjection(options.runtime, createSceneProjector(options.runtime, options.item), observed);
  const result = await evaluateTask({ ...options, runtime });
  result.neutralInputScene = result.scene;
  result.neutralInputSceneSha256 = result.sceneSha256;
  result.entryPointReviews = result.reviews;
  result.reviews = observed.reviews;
  result.contractProjection = observed.projection ?? null;
  if (observed.projection) {
    result.scene = copy(observed.projection.scene);
    result.sceneSha256 = sha(JSON.stringify(result.scene));
  } else if (!result.error) throw new Error("No initial scene reached the production client");
  result.evaluationKind = "conditional_production_contract_component";
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv), plan = buildRunPlan(options.selected, options.repeats, options.mode);
  if (options.dryRun) { console.log(JSON.stringify({ modelCalls: 0, manifestSha256: sha(JSON.stringify(options.selected)), evaluationKind: "conditional_production_contract_component", runPlan: plan.map(({ item, task, repetition }) => `${item.id}/${task}#${repetition}`) }, null, 2)); return; }
  const runtime = await loadProductionRuntime(options.runtimeRoot);
  const transport = new runtime.imported.lmStudioBackend.LmStudioBackend();
  const health = await transport.probe(AbortSignal.timeout(8_000));
  if (!health.connected) throw new Error("Gemma is unavailable");
  const directory = options.output ? validateOutputPath(options.output) : await mkdtemp(join(tmpdir(), "third-place-dm-production-contract-"));
  if (options.output) await mkdir(directory);
  const report = { label: options.label, generatedAt: new Date().toISOString(), model: health.id, runtimeRoot: options.runtimeRoot, runtimeHashes: runtime.hashes,
    harnessSha256: sha(await readFile(fileURLToPath(import.meta.url))), frozenEvaluatorSha256: FROZEN_SCENE_HARNESS_SHA256,
    manifestSha256: sha(JSON.stringify(options.selected)), manifest: options.selected, repeats: options.repeats, mode: options.mode, concurrency: 1,
    evaluationKind: "conditional_production_contract_component", bounds: { maxModelCallsPerTask: MAX_CALLS, deadlineMs: DEADLINE_MS },
    limitations: ["Not an end-to-end test: no router, Director, store, account, provider execution or publication. The public evidence and failed lookup are fixed conditions.",
      "The frozen seven fixtures, gold drafts, run plan, stage seeds and production model budgets are unchanged. Expected answers and rubrics are never generation instructions.",
      "Real registry.sceneContract builds the failed web_search premise and grounding instruction. Candidate scoping is invoked only through its real exported availability gate and scope helper; baseline retains the raw contract.",
      "Only the initial request is transformed; production recovery and subsequent review requests are not rewritten. Neutral inputs, actual initial scenes, exact review scenes and outbound requests remain separately inspectable.",
      "The test intentionally does not exercise semanticFlagsPremise or router correctness. Full-chain evidence remains a separate requirement.",
      "A malformed reviewer response is not credited as a correct semantic rejection. Final prose quality requires manual review."], results: [] };
  console.log(`DM production-contract component evaluation: ${directory}`);
  for (const entry of plan) {
    const result = await evaluateProductionTask({ ...entry, runtime, transport, model: health.id });
    report.results.push(result); await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ id: result.id, task: result.task, repetition: result.repetition, projection: result.contractProjection?.projection, lines: result.lines, decision: result.overallDecision, expected: result.expectedDecision, error: result.error, elapsedMs: result.elapsedMs }));
    if (result.error || result.privacyViolations.length || result.matchesExpectedDecision === false || result.matchesExpectedGrounding === false || (result.task === "generation" && !result.lines.length)) process.exitCode = 1;
    if (result.cleanupUnsettled || result.privacyViolations.length) break;
  }
  console.log(`Report: ${join(directory, "report.json")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
