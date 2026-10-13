#!/usr/bin/env node

// Parked, isolated person-reference experiment; not used by the app.
// Baseline: real analyzeTurn.
// Candidate: pure DM reference schema/prompt/parser and one production-backend
// call. No app, stores, accounts, memory lookup, research, writer or reviewer.
// Import and --dry-run never load runtime modules, call models or write files.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { scenarios, externalLookupControl, inferenceSettings, privateSentinelHits } from "./dm-public-memory-live-eval.mjs";
import { controls, inputForControl, assessControl, FIXED_NOW } from "./dm-classification-controls-live-eval.mjs";
import { readEvaluationText } from "./evaluation-archive.mjs";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const clone = (value) => structuredClone(value);
const SUBJECT = "synthetic-dm-memory-subject";
const MATCH = { selectedIds: [SUBJECT], statuses: ["matched"] };
const NONE = { selectedIds: [], statuses: ["not_applicable"] };
export const MAX_RESOLVER_TOKENS = 384;
export const CALL_DEADLINE_MS = 20_000;
export const BASELINE_REPORT = new URL("../docs/evaluations/dm-public-memory-simplify-baseline-2026-10-13.results.json.gz", import.meta.url);
export const EXTERNAL_REPORT = new URL("../docs/evaluations/dm-public-memory-simplify-baseline-external-2026-10-13.results.json.gz", import.meta.url);

// Frozen before live evaluation. Expectations and descriptions never enter
// either classifier's payload. Opaque numeric input IDs are assigned below.
export const identityControls = [
  { id: "es-unknown-single-candidate", language: "es", text: "¿Qué te parece NubeAzul? ¿Lo conoces?",
    candidates: [{ id: "edge-human-a", displayLabel: "BrisaVerde" }], expected: { selectedIds: [], statuses: ["unknown"] } },
  { id: "de-similar-handles-exact", language: "de", text: "Was hältst du von Cedar_77?",
    candidates: [{ id: "edge-human-a", displayLabel: "Cedar_7" }, { id: "edge-human-b", displayLabel: "Cedar_77" }], expected: { selectedIds: ["edge-human-b"], statuses: ["matched"] } },
  { id: "de-similar-handles-underspecified", language: "de", text: "Was hältst du von Cedar?",
    candidates: [{ id: "edge-human-a", displayLabel: "Cedar_7" }, { id: "edge-human-b", displayLabel: "Cedar_77" }], expected: { selectedIds: [], statuses: ["ambiguous", "unknown"] } },
  { id: "pt-candidate-order-a", language: "pt", text: "O que você achou de LuaMansa?",
    candidates: [{ id: "edge-human-a", displayLabel: "RioClaro" }, { id: "edge-human-b", displayLabel: "LuaMansa" }], expected: { selectedIds: ["edge-human-b"], statuses: ["matched"] } },
  { id: "pt-candidate-order-b", language: "pt", text: "O que você achou de LuaMansa?",
    candidates: [{ id: "edge-human-b", displayLabel: "LuaMansa" }, { id: "edge-human-a", displayLabel: "RioClaro" }], expected: { selectedIds: ["edge-human-b"], statuses: ["matched"] } },
  { id: "fr-pronoun-antecedent", language: "fr", text: "Et tu penses quoi de cette personne ?",
    history: [{ role: "human", content: "Je parlais de LuneClaire." }, { role: "resident", content: "Oui, de LuneClaire." }],
    candidates: [{ id: "edge-human-a", displayLabel: "LuneClaire" }, { id: "edge-human-b", displayLabel: "MerCalme" }], expected: { selectedIds: ["edge-human-a"], statuses: ["matched"] } },
  { id: "ja-corrected-reference", language: "ja", text: "名前を間違えた。HoshiMoriのこと。どう思った？",
    history: [{ role: "human", content: "YukiSoraのこと、どう思う？" }],
    candidates: [{ id: "edge-human-a", displayLabel: "HoshiMori" }, { id: "edge-human-b", displayLabel: "YukiSora" }], expected: { selectedIds: ["edge-human-a"], statuses: ["matched"] } },
  { id: "sv-resident-address", language: "sv", text: "Mira, vad tycker du om att samla på gamla vykort?",
    candidates: [{ id: "edge-human-a", displayLabel: "MiraCollector" }], expected: NONE },
  { id: "fr-duplicate-display-labels", language: "fr", text: "Tu penses quoi d'Alex ?",
    candidates: [{ id: "edge-human-a", displayLabel: "Alex" }, { id: "edge-human-b", displayLabel: "Alex" }], expected: { selectedIds: [], statuses: ["ambiguous", "unknown"] },
    limitation: "The old general-router input schema rejects duplicate labels; record that rejection separately, not as semantic baseline failure." },
  { id: "ar-named-reference", language: "ar", text: "ما رأيك في OasisOne؟ هل تتذكر حديثكما؟",
    candidates: [{ id: "edge-human-a", displayLabel: "OasisOne" }, { id: "edge-human-b", displayLabel: "DesertTwo" }], expected: { selectedIds: ["edge-human-a"], statuses: ["matched"] } },
];

function archivedRouterInput(row) {
  const call = row?.calls.find((item) => item.schema === "multilingual_turn_router_v2");
  const archived = call?.userPayload?.[0];
  if (!archived || archived.medium !== "dm") throw new Error("Missing archived DM router input");
  const input = clone(archived), inputNormalizations = [];
  // The outgoing payload serializes an absent optional transport hint as
  // null; the incoming production schema requires omission instead. No
  // conversation, catalog or semantic field is altered when replaying it.
  if (Object.hasOwn(input, "transportLanguageHint") && input.transportLanguageHint === null) {
    delete input.transportLanguageHint;
    inputNormalizations.push({ field: "transportLanguageHint", archivedValue: null, replayValue: "omitted" });
  }
  return { input, inputNormalizations, archivedInputSha256: sha(JSON.stringify(archived)) };
}

function edgeInput(control, index) {
  const base = inputForControl(controls[0]);
  const prefix = `synthetic-reference-${index + 1}`;
  const speaker = "edge-speaker", resident = "ai-mira";
  const recentMessages = (control.history ?? []).map((row, position) => ({
    id: `${prefix}-row-${position}`, authorId: row.role === "human" ? speaker : resident,
    authorName: row.role === "human" ? "Sam" : "Mira", authorKind: row.role === "human" ? "human" : "ai",
    content: row.content, createdAt: new Date(FIXED_NOW - 60_000 + position * 10_000).toISOString(),
  }));
  const latestMessage = { id: `${prefix}-latest`, authorId: speaker, authorName: "Sam", authorKind: "human", content: control.text, createdAt: new Date(FIXED_NOW).toISOString() };
  const rows = [...recentMessages, latestMessage];
  return { ...base, turnId: `${prefix}-turn`, channel: { id: `dm:${resident}:${speaker}`, name: "Private chat with Mira" }, latestMessage, recentMessages,
    currentParticipantCandidates: [speaker, resident].flatMap((id) => {
      const authored = rows.filter((row) => row.authorId === id);
      return authored.length ? [{ id, displayLabel: authored[0].authorName, kind: authored[0].authorKind, publicBio: null, recentMessageIds: authored.map((row) => row.id) }] : [];
    }),
    personaCandidates: [{ id: resident, name: "Mira", interests: ["art", "music", "collecting"] }],
    humanCandidates: clone(control.candidates), mechanicalAddressedPersonaIds: [resident], urlCandidates: [],
  };
}

export async function buildManifest() {
  const baselineText = await readEvaluationText(BASELINE_REPORT), externalText = await readEvaluationText(EXTERNAL_REPORT);
  const baseline = JSON.parse(baselineText), external = JSON.parse(externalText);
  const original = scenarios.map((scenario) => {
    const replay = archivedRouterInput(baseline.scenarios.find((row) => row.id === scenario.id && row.repetition === 1));
    const { input } = replay;
    if (input.latestMessage.content !== scenario.text) throw new Error(`Archived fixture drift: ${scenario.id}`);
    const expected = scenario.id === "en-unknown" || scenario.id === "en-ambiguous"
      ? { selectedIds: [], statuses: ["unknown", "ambiguous"] } : scenario.id === "sv-greeting" ? NONE : MATCH;
    return { id: scenario.id, group: "original-memory", language: scenario.language, expected: clone(expected), ...replay,
      ...(scenario.id === "en-ambiguous" ? { limitation: "Preserved existing catalog: duplicate Alex profiles were filtered before the old router call." } : {}) };
  });
  const externalReplay = archivedRouterInput(external.externalControls.find((row) => row.repetition === 1));
  if (externalReplay.input.latestMessage.content !== externalLookupControl.text) throw new Error("Archived external-control drift");
  const fixtures = [
    ...original,
    { id: externalLookupControl.id, group: "external-control", language: "en", expected: clone(MATCH), ...externalReplay, expectedEvidenceAction: externalLookupControl.expectedEvidenceAction },
    ...controls.map((control) => ({ id: control.id, group: "held-out", language: control.language,
      // These are nonmatching controls; broad social/technical meaning is not
      // this resolver's job. No positive ID is authorized in any of them.
      expected: { selectedIds: [], statuses: ["not_applicable", "unknown"] }, input: inputForControl(control) })),
    ...identityControls.map((control, index) => ({ id: control.id, group: "identity-edge", language: control.language,
      expected: clone(control.expected), input: edgeInput(control, control.id === "pt-candidate-order-b" ? index - 1 : index), ...(control.limitation ? { limitation: control.limitation } : {}) })),
  ].map((fixture, index) => ({ ...fixture, index, seedIndex: fixture.id === "pt-candidate-order-b" ? index - 1 : index, inputSha256: sha(JSON.stringify(fixture.input)) }));
  return { fixtures, sourceHashes: { baselineReport: sha(baselineText), externalReport: sha(externalText) }, manifestSha256: sha(JSON.stringify(fixtures)) };
}

export function toResolverInput(input) {
  if (input.medium !== "dm" || input.personaCandidates.length !== 1) throw new Error("Resolver evaluation requires one-resident DM");
  const speakerId = input.latestMessage.authorId, residentId = input.personaCandidates[0].id;
  const pair = new Set([speakerId, residentId]);
  const row = ({ id, authorId, content }) => ({ id, authorId, content });
  return { speakerId, residentId, latestMessage: row(input.latestMessage),
    recentMessages: input.recentMessages.filter((message) => pair.has(message.authorId) && message.id !== input.latestMessage.id).slice(-12).map(row),
    publicHumanCandidates: input.humanCandidates.filter((person) => !pair.has(person.id)).map(({ id, displayLabel }) => ({ id, displayLabel })) };
}

export function parseOptions(argv) {
  const values = {}, flags = new Set(["--list", "--dry-run"]);
  const options = new Set(["--mode", "--runtime-root", "--output", "--label", "--repeats", "--cases"]);
  for (const argument of argv) {
    const position = argument.indexOf("="), key = position < 0 ? argument : argument.slice(0, position);
    if (Object.hasOwn(values, key)) throw new Error(`Repeated option: ${key}`);
    if (flags.has(key) && position < 0) values[key] = true;
    else if (options.has(key) && position >= 0 && argument.slice(position + 1)) values[key] = argument.slice(position + 1);
    else throw new Error(`Unknown or incomplete option: ${key}`);
  }
  const mode = values["--mode"] ?? "candidate", repeats = Number(values["--repeats"] ?? 2);
  if (!["baseline", "candidate"].includes(mode)) throw new Error("--mode must be baseline or candidate");
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 2) throw new Error("--repeats must be 1 or 2");
  const cases = values["--cases"]?.split(",");
  if (cases && (cases.some((id) => !id) || new Set(cases).size !== cases.length)) throw new Error("Empty or repeated case ID");
  const output = values["--output"];
  if (output) validateOutput(output);
  return { mode, repeats, cases, runtimeRoot: values["--runtime-root"], output,
    label: values["--label"] ?? mode, dryRun: Boolean(values["--list"] || values["--dry-run"]) };
}

function validateOutput(output) {
  const destination = resolve(output);
  if (!isAbsolute(output) || ![resolve(tmpdir()), "/tmp", "/private/tmp"].some((root) => {
    const child = relative(root, destination);
    return child && child !== ".." && !child.startsWith("../") && !isAbsolute(child);
  })) throw new Error("--output must be a new directory beneath the system temporary directory");
  return destination;
}

export function selectFixtures(manifest, ids) {
  if (!ids) return manifest.fixtures;
  return ids.map((id) => {
    const fixture = manifest.fixtures.find((item) => item.id === id);
    if (!fixture) throw new Error(`Unknown case: ${id}`);
    return fixture;
  });
}

export const buildRunPlan = (fixtures, repeats) => Array.from({ length: repeats }, (_, index) =>
  fixtures.map((fixture) => ({ fixture, repetition: index + 1 }))).flat();

export function stageSeed(fixtureIndex, repetition, schema) {
  const stage = { multilingual_turn_router_v2: 1, multilingual_evidence_plan_verifier_v1: 2, dm_public_person_reference_v1: 1 }[schema];
  if (!stage) throw new Error(`Unexpected inference stage in isolated experiment: ${schema}`);
  return 1_021_000 + (repetition - 1) * 10_000 + fixtureIndex * 100 + stage;
}

export async function loadRuntime(runtimeRoot, mode) {
  const imported = {}, hashes = {};
  const names = mode === "baseline" ? ["lmStudio", "lmStudioBackend", "semanticRouter"] : ["lmStudioBackend", "dmPersonReference"];
  for (const name of names) {
    // Frozen comparison runtimes contain the original temporary server-module
    // location. Current source lives only in experiments after rejection.
    const url = runtimeRoot
      ? pathToFileURL(join(resolve(runtimeRoot), "server", `${name}.js`))
      : name === "dmPersonReference"
        ? new URL("./experiments/dmPersonReference.ts", import.meta.url)
        : new URL(`../server/${name}.ts`, import.meta.url);
    imported[name] = await import(url.href); hashes[name] = sha(await readFile(url));
  }
  return { imported, hashes };
}

export function assessIdentity(fixture, result, mode) {
  const selectedIds = [...(result.selectedIds ?? [])].sort(), expectedIds = [...fixture.expected.selectedIds].sort();
  const matchedIds = JSON.stringify(selectedIds) === JSON.stringify(expectedIds);
  const valid = result.schemaValid === true && !result.error;
  const statusMatches = mode === "baseline" ? null : fixture.expected.statuses.includes(result.resolution?.status);
  const falseMatch = selectedIds.some((id) => !expectedIds.includes(id));
  return { passed: Boolean(valid && matchedIds && statusMatches !== false), valid, matchedIds, statusMatches,
    falseMatch, missedMatch: valid && expectedIds.some((id) => !selectedIds.includes(id)), expected: clone(fixture.expected), selectedIds };
}

function recorder({ fixture, repetition, transport, calls, maximumCalls }) {
  return {
    providerId: transport.providerId, configuredModel: transport.configuredModel,
    probe: (signal) => transport.probe(signal),
    async complete(body, signal) {
      if (calls.length >= maximumCalls) throw new Error("Isolated model-call budget exhausted");
      const schema = body.response_format?.json_schema?.name;
      const userPayload = body.messages.filter((message) => message.role === "user").map((message) => JSON.parse(message.content));
      const request = { ...body, seed: stageSeed(fixture.seedIndex ?? fixture.index, repetition, schema) };
      const call = { schema, inferenceSettings: inferenceSettings(request), userPayload,
        userPayloadSha256: sha(JSON.stringify(userPayload)), systemSha256: sha(JSON.stringify(body.messages.filter((message) => message.role === "system"))),
        privateSentinelHits: privateSentinelHits(body.messages) };
      calls.push(call);
      if (call.privateSentinelHits.length) throw new Error("Forbidden private sentinel in model input");
      const started = performance.now();
      try {
        const response = await transport.complete(request, signal);
        call.content = response?.choices?.[0]?.message?.content ?? null;
        call.finishReason = response?.choices?.[0]?.finish_reason ?? null;
        call.usage = response?.usage ?? null;
        try { call.parsed = JSON.parse(call.content); } catch { call.parsed = null; }
        call.outputPrivateSentinelHits = privateSentinelHits(call.content);
        return response;
      } catch (error) { call.error = error instanceof Error ? error.message : String(error); throw error; }
      finally { call.elapsedMs = Math.round(performance.now() - started); }
    },
  };
}

export async function runFixture({ fixture, repetition, mode, runtime, transport }) {
  const result = { id: fixture.id, group: fixture.group, repetition, input: clone(fixture.input), inputSha256: fixture.inputSha256, calls: [] };
  const backend = recorder({ fixture, repetition, transport, calls: result.calls, maximumCalls: mode === "candidate" ? 1 : 3 });
  const started = performance.now();
  let client, timeout;
  const controller = new AbortController();
  try {
    const work = async () => {
      if (mode === "baseline") {
        const { semanticRouter, lmStudio } = runtime.imported;
        const validated = semanticRouter.turnAnalysisInputSchema.safeParse(fixture.input);
        result.inputSchemaValid = validated.success;
        if (!validated.success) { result.inputIssues = validated.error.issues; result.schemaValid = false; result.selectedIds = []; return; }
        client = new lmStudio.LmStudioClient({ backend, now: () => FIXED_NOW, maxConcurrentPredictions: 1, maxBackgroundPredictions: 1,
          communityTimeZone: fixture.input.communityClock?.timeZone, communityLocationLabel: fixture.input.communityClock?.locationLabel });
        result.analysis = await client.analyzeTurn(fixture.input, { signal: controller.signal });
        result.schemaValid = result.analysis.source === "lm" && result.analysis.failureReason === null;
        result.selectedIds = result.analysis.referencedHumanConfidence >= semanticRouter.TURN_TRUST_THRESHOLDS.referencedHuman ? result.analysis.referencedHumanIds : [];
        const primary = result.calls.find((call) => call.schema === "multilingual_turn_router_v2");
        const parsedPrimary = primary ? semanticRouter.parseTurnAnalysisContent(primary.content, validated.data) : undefined;
        result.primarySchemaValid = Boolean(parsedPrimary);
        result.primaryAnalysis = parsedPrimary ?? null;
        result.primarySelectedIds = parsedPrimary && parsedPrimary.referencedHumanConfidence >= semanticRouter.TURN_TRUST_THRESHOLDS.referencedHuman ? parsedPrimary.referencedHumanIds : [];
        const existingControl = controls.find((control) => control.id === fixture.id);
        if (existingControl) result.existingControlAssessment = assessControl(existingControl, result.analysis, semanticRouter.TURN_TRUST_THRESHOLDS);
        if (fixture.expectedEvidenceAction) result.externalControl = { expected: fixture.expectedEvidenceAction, actual: result.analysis.evidence.action, passed: result.analysis.evidence.action === fixture.expectedEvidenceAction };
      } else {
        const module = runtime.imported.dmPersonReference;
        result.resolverInput = toResolverInput(fixture.input);
        const validated = module.dmPersonReferenceInputSchema.safeParse(result.resolverInput);
        result.inputSchemaValid = validated.success;
        if (!validated.success) { result.inputIssues = validated.error.issues; result.schemaValid = false; result.selectedIds = []; return; }
        const body = { model: transport.configuredModel, temperature: 0, top_p: 1, reasoning_effort: "none", stream: false, max_tokens: MAX_RESOLVER_TOKENS,
          response_format: module.buildDmPersonReferenceResponseFormat(validated.data),
          messages: [{ role: "system", content: module.buildDmPersonReferenceSystemPrompt() }, { role: "user", content: JSON.stringify(module.buildDmPersonReferenceUserData(validated.data)) }] };
        await backend.complete(body, controller.signal);
        const raw = result.calls[0];
        result.resolution = module.parseDmPersonReferenceContent(raw.content, validated.data) ?? null;
        result.schemaValid = Boolean(result.resolution) && raw.finishReason === "stop";
        // Retain parser output even if transport truncation makes it unusable.
        result.selectedIds = result.schemaValid && result.resolution.status === "matched" ? result.resolution.references.map((reference) => reference.personId) : [];
        result.nonIdentityFieldsAssessed = false;
      }
    };
    await Promise.race([work(), new Promise((_, reject) => { timeout = setTimeout(() => {
      controller.abort(); client?.cancelPending("Person-reference evaluation deadline"); reject(new Error("Person-reference evaluation exceeded 20 seconds"));
    }, CALL_DEADLINE_MS); })]);
  } catch (error) { result.error = error instanceof Error ? error.message : String(error); }
  finally { clearTimeout(timeout); controller.abort(); client?.cancelPending("Person-reference evaluation complete"); result.elapsedMs = Math.round(performance.now() - started); }
  result.assessment = assessIdentity(fixture, result, mode);
  return result;
}

export function summarize(results) {
  return { total: results.length, passed: results.filter((row) => row.assessment.passed).length,
    failed: results.filter((row) => row.assessment.valid && !row.assessment.passed).length,
    unavailable: results.filter((row) => row.inputSchemaValid !== false && !row.assessment.valid).length,
    falseMatches: results.filter((row) => row.assessment.falseMatch).length,
    missedMatches: results.filter((row) => row.assessment.missedMatch).length,
    eligibleInputs: results.filter((row) => row.inputSchemaValid === true).length,
    inputRejected: results.filter((row) => row.inputSchemaValid === false).length };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv), manifest = await buildManifest();
  const fixtures = selectFixtures(manifest, options.cases), plan = buildRunPlan(fixtures, options.repeats);
  if (options.dryRun) { console.log(JSON.stringify({ modelCalls: 0, ...manifest, runPlan: plan.map(({ fixture, repetition }) => `${fixture.id}#${repetition}`) }, null, 2)); return; }
  const runtime = await loadRuntime(options.runtimeRoot, options.mode), transport = new runtime.imported.lmStudioBackend.LmStudioBackend();
  const health = await transport.probe(AbortSignal.timeout(8_000));
  if (!health.connected) throw new Error(`Gemma unavailable: ${health.label}`);
  const directory = options.output ? validateOutput(options.output) : await mkdtemp(join(tmpdir(), "third-place-person-reference-"));
  if (options.output) await mkdir(directory);
  const report = { generatedAt: new Date().toISOString(), mode: options.mode, label: options.label, model: health.id,
    runtimeRoot: options.runtimeRoot ?? "current-source", runtimeHashes: runtime.hashes, harnessSha256: sha(await readFile(fileURLToPath(import.meta.url))),
    resolverPromptSha256: options.mode === "candidate" ? sha(runtime.imported.dmPersonReference.buildDmPersonReferenceSystemPrompt()) : null,
    ...manifest, concurrency: 1, repeats: options.repeats, maxResolverTokens: MAX_RESOLVER_TOKENS, deadlineMs: CALL_DEADLINE_MS,
    limitations: ["Shadow identity experiment only: candidate has no capability, language, moderation, relationship, memory or publication output.",
      "Existing scenarios and held-out controls are preserved, but their nonidentity behavior is observed only in the baseline, not claimed validated by the candidate.",
      "References select catalog identities; they do not prove acquaintance, authorize disclosure or suppress external research.",
      "Duplicate-label edge input rejection is separate from semantic correctness. All original fixtures preserve the archived filtering.",
      "The whole bounded input and raw output are synthetic. Stage seeds are independent of optional verifier calls. No text/regex outcome grading."], results: [] };
  console.log(`Isolated DM person references (${options.mode}): ${directory}`);
  for (const { fixture, repetition } of plan) {
    const result = await runFixture({ fixture, repetition, mode: options.mode, runtime, transport });
    report.results.push(result); report.summary = summarize(report.results);
    await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ id: fixture.id, repetition, status: result.resolution?.status, ids: result.selectedIds, assessment: result.assessment, error: result.error, elapsedMs: result.elapsedMs }));
  }
  console.log(JSON.stringify(report.summary)); console.log(`Report: ${join(directory, "report.json")}`);
  if (report.summary.failed || report.summary.unavailable) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
