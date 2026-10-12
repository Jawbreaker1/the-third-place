#!/usr/bin/env node

// PARKED experiment: offline-first, isolated comparison. Never imported by the application. The
// shadow assessment cannot change publication, memory, accounts or routing.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LmStudioBackend } from "../server/lmStudioBackend.ts";
import { LmStudioClient } from "../server/lmStudio.ts";
import { PERSONAS } from "../server/personas.ts";
import { FACTUAL_SHADOW_SYSTEM_PROMPT, factualShadowInputSchema, runFactualShadowReview } from "./experiments/factualShadowReview.ts";
import { fixtureContext, FIXED_NOW } from "./memory-context-live-eval.mjs";
import { reviewRegressionScenarios, reviewRequest, traceTransport } from "./commitment-live-eval.mjs";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const promptHash = () => sha256(FACTUAL_SHADOW_SYSTEM_PROMPT);
const KNOWN_OPTIONS = new Set(["--split", "--samples", "--concurrency", "--cases", "--output", "--frozen-prompt"]);
const BOOLEAN_OPTIONS = new Set(["--list", "--dry-run"]);
const VERDICTS = new Set(["supported", "contradicted", "insufficient_evidence", "not_factual", "uncertain"]);
const FACTUAL_ISSUES = new Set([
  "evidence_ungrounded", "unsupported_external_evidence_claim", "false_evidence_denial",
  "evidence_not_answer_bearing", "evidence_irrelevant", "unsupported_room_recall",
  "current_context_mismatch", "participant_identity_conflation", "community_capability_contradiction",
  "unsupported_visual_claim", "unsupported_acoustic_assertion", "incorrect_temporal_claim",
  "permanent_web_denial", "written_medium_illusion",
]);
const MAX_MODEL_CALLS_PER_CELL = 3; // Existing reviewer may use two calls; shadow uses exactly one.

export function parseOptions(args) {
  const values = {};
  for (const arg of args) {
    if (BOOLEAN_OPTIONS.has(arg)) {
      if (values[arg] !== undefined) throw new Error(`Repeated argument ${arg}`);
      values[arg] = true;
      continue;
    }
    const position = arg.indexOf("=");
    const key = position < 0 ? arg : arg.slice(0, position);
    if (!KNOWN_OPTIONS.has(key) || position < 0 || !arg.slice(position + 1)) throw new Error(`Unknown or incomplete argument ${arg}`);
    if (values[key] !== undefined) throw new Error(`Repeated argument ${key}`);
    values[key] = arg.slice(position + 1);
  }
  const bounded = (key, fallback, maximum) => {
    const value = Number(values[key] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${key} must be 1..${maximum}`);
    return value;
  };
  const split = values["--split"] ?? "discovery";
  if (!["discovery", "holdout"].includes(split)) throw new Error("--split must be discovery or holdout");
  const frozenPrompt = values["--frozen-prompt"];
  if (frozenPrompt && frozenPrompt !== promptHash()) throw new Error("Frozen prompt hash does not match the current shadow prompt");
  if (split === "holdout" && !frozenPrompt) throw new Error("Holdout requires --frozen-prompt=<sha256> before loading its fixtures");
  const caseIds = values["--cases"] ? values["--cases"].split(",") : [];
  if (caseIds.some((id) => !id) || new Set(caseIds).size !== caseIds.length) throw new Error("Empty or repeated case ID");
  const output = values["--output"];
  if (output && !isAbsolute(output)) throw new Error("--output must be an absolute path below the system temp directory");
  if (output) validateOutputPath(output);
  return { split, samples: bounded("--samples", 1, 3), concurrency: bounded("--concurrency", 2, 2),
    caseIds, output, frozenPrompt, offline: Boolean(values["--list"] || values["--dry-run"]) };
}

export function validateOutputPath(output) {
  if (!isAbsolute(output) || ![resolve(tmpdir()), "/tmp", "/private/tmp"].some((root) => {
    const child = relative(root, resolve(output));
    return child && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(child);
  })) throw new Error("Reports must be in a new directory below the system temp directory");
  return resolve(output);
}

export function selectCases(cases, options) {
  if (!cases.length || cases.length > 80) throw new Error("Fixture count must be 1..80");
  if (new Set(cases.map((item) => item.id)).size !== cases.length) throw new Error("Duplicate fixture ID");
  const allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
  for (const item of cases) {
    if (!item.id || ![...item.id].every((char) => allowed.includes(char))) throw new Error("Unsafe fixture ID");
    if (item.split !== options.split || !VERDICTS.has(item.expected)) throw new Error(`Invalid split/expectation for ${item.id}`);
    // Validation does not pass expected labels or rationale into either model.
    shadowInputForCase(item);
  }
  if (options.caseIds.some((id) => !cases.some((item) => item.id === id))) throw new Error("Unknown case in selected split");
  return options.caseIds.length ? cases.filter((item) => options.caseIds.includes(item.id)) : cases;
}

export function shadowInputForCase(item) {
  return factualShadowInputSchema.parse({
    request: item.request,
    context: (item.context ?? []).map((row, i) => ({ id: `C${i + 1}`, author: row.author, content: row.content })),
    candidate: item.candidate,
    sources: (item.sources ?? []).map(({ id, title, text }) => ({ id, title, text })),
    citedSourceIds: item.citedSourceIds ?? (item.sources ?? []).map((source) => source.id),
    evidenceStatus: item.evidenceStatus ?? (item.sources?.length ? "succeeded" : "none"),
  });
}

export function broadRequestForCase(item) {
  if (item.legacyScenario) {
    const scenario = reviewRegressionScenarios.find((entry) => entry.id === item.legacyScenario);
    if (!scenario) throw new Error("Unknown legacy scenario");
    const context = fixtureContext(scenario);
    try { return reviewRequest(scenario, context); }
    finally { context.close(); }
  }
  const persona = PERSONAS.find((entry) => entry.id === "ai-sana");
  if (!persona) throw new Error("Missing synthetic fixture persona");
  const expected = item.mustFulfillRequest !== false;
  return {
    kind: "public", channelId: item.room ?? "lobby",
    channelName: item.room ?? "lobby", selected: [persona],
    history: (item.context ?? []).map((row) => ({ author: row.author, content: row.content,
      authorId: row.author === "Sana" ? persona.id : "synthetic-factual-shadow-alex",
      kind: row.author === "Sana" ? "ai" : "human", createdAt: new Date(FIXED_NOW - 30_000).toISOString() })),
    trigger: { authorId: "synthetic-factual-shadow-alex", authorKind: "human", author: "Alex", content: item.request,
      messageId: "synthetic-factual-shadow-turn", createdAt: new Date(FIXED_NOW).toISOString() },
    mustReplyIds: [persona.id], responseRecoveryIds: [persona.id], requestOwnerIds: expected ? [persona.id] : [],
    relationshipNotes: {}, languageHint: item.language,
    semanticContext: { languageTag: item.language, intentTrusted: true, replyExpected: expected ? "expected" : "optional",
      answerDepth: "normal", asksForList: false, asksAboutAiIdentity: false, asksAboutAcoustics: false },
    temporalPolicy: "reactive_only", evidenceOutcome: item.evidenceStatus ?? "none",
    ...(item.sources?.length ? { research: { kind: "page", query: item.request,
      retrievedAt: new Date(FIXED_NOW).toISOString(), results: item.sources.map((source) => ({
        id: source.id, title: source.title, snippet: source.text,
        url: `https://synthetic-source.invalid/${encodeURIComponent(source.id)}`,
      })) } } : {}),
  };
}

const CLEAN_ASSESSMENT = { acceptable: true, severity: "none", reasons: [], reasonCodes: [], hints: [] };
export async function evaluateShadowCell({ item, sample, order, backend, model }) {
  const trace = [];
  const transport = traceTransport(backend, trace, MAX_MODEL_CALLS_PER_CELL);
  const client = new LmStudioClient({ backend: transport, now: () => FIXED_NOW,
    communityTimeZone: "Europe/Stockholm", maxConcurrentPredictions: 1, maxBackgroundPredictions: 1 });
  const request = broadRequestForCase(item);
  const personaId = request.selected[0].id;
  const sourceIds = item.citedSourceIds ?? (item.sources ?? []).map((source) => source.id);
  const shadowInput = shadowInputForCase(item);
  const result = { caseId: item.id, pairId: item.pairId ?? null, split: item.split, domain: item.domain, language: item.language,
    expected: item.expected, rationale: item.rationale, sample, order, candidate: item.candidate,
    broadRequest: request, shadowInput, trace };
  const broad = async () => {
    const started = performance.now();
    const first = trace.length;
    try {
      const reviews = await client.reviewCandidateLines(request, [{ personaId, content: item.candidate, sourceIds }], model, AbortSignal.timeout(90_000));
      const review = reviews?.get(personaId);
      result.broad = review ? { status: "completed", review,
        overallDisposition: client.applyCandidateReview(structuredClone(CLEAN_ASSESSMENT), review, false).acceptable ? "clear" : "blocked",
        factualIssues: review.issues.filter((issue) => FACTUAL_ISSUES.has(issue)) }
        : { status: "unavailable", reason: "Existing reviewer returned no validated assessment" };
    } catch (error) { result.broad = { status: "unavailable", reason: error instanceof Error ? error.message : String(error) }; }
    finally {
      result.broad.elapsedMs = Math.round(performance.now() - started);
      result.broad.traceIndexes = Array.from({ length: trace.length - first }, (_, i) => first + i);
    }
  };
  const shadow = async () => {
    const first = trace.length;
    const started = performance.now();
    try { result.shadow = await runFactualShadowReview({ input: shadowInput, backend: transport, model, timeoutMs: 20_000 }); }
    catch (error) { result.shadow = { status: "unavailable", reason: error instanceof Error ? error.message : String(error), elapsedMs: Math.round(performance.now() - started) }; }
    result.shadow.traceIndexes = Array.from({ length: trace.length - first }, (_, i) => first + i);
  };
  // Both receive fixed fixture data only, never the other review's result.
  for (const arm of order === "shadow-first" ? [shadow, broad] : [broad, shadow]) await arm();
  return result;
}

const expectedDecision = (expected) => ["supported", "not_factual"].includes(expected) ? "accept"
  : ["contradicted", "insufficient_evidence"].includes(expected) ? "reject" : "abstain";
const shadowDecision = (result) => result?.status !== "completed" ? "unavailable" : expectedDecision(result.assessment.verdict);
const broadDecision = (result) => result?.status !== "completed" ? "unavailable" : result.overallDisposition === "blocked" ? "reject" : "accept";
const factualFlagDecision = (result) => result?.status !== "completed" ? "unavailable" : result.factualIssues.length ? "reject" : "accept";
function counters(cells, decide) {
  const count = { total: cells.length, expectedAccept: 0, expectedReject: 0, expectedAbstain: 0,
    correctDecisions: 0, falseApprovals: 0, falseRejections: 0, abstentions: 0, unavailable: 0, confusion: {} };
  for (const cell of cells) {
    const expected = expectedDecision(cell.expected), observed = decide(cell);
    count[expected === "accept" ? "expectedAccept" : expected === "reject" ? "expectedReject" : "expectedAbstain"]++;
    const key = `${expected} -> ${observed}`;
    count.confusion[key] = (count.confusion[key] ?? 0) + 1;
    if (observed === "unavailable") count.unavailable++;
    else if (observed === "abstain") count.abstentions++;
    else if (expected === observed) count.correctDecisions++;
    else if (expected === "reject" && observed === "accept") count.falseApprovals++;
    else if (expected === "accept" && observed === "reject") count.falseRejections++;
  }
  return count;
}
function timing(cells, arm) {
  const values = cells.map((cell) => cell[arm]?.elapsedMs).filter(Number.isFinite).sort((a, b) => a - b);
  const quantile = (q) => values.length ? values[Math.min(values.length - 1, Math.ceil(q * values.length) - 1)] : null;
  return { count: values.length, totalMs: values.reduce((a, b) => a + b, 0), medianMs: quantile(0.5), p95Ms: quantile(0.95) };
}
function usage(cells, arm) {
  const total = { calls: 0, callsWithUsage: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  for (const cell of cells) for (const index of cell[arm]?.traceIndexes ?? []) {
    total.calls++;
    const raw = cell.trace?.[index]?.response?.usage;
    if (!raw) continue;
    total.callsWithUsage++;
    for (const [target, source] of [["promptTokens", "prompt_tokens"], ["completionTokens", "completion_tokens"], ["totalTokens", "total_tokens"]]) {
      if (Number.isFinite(raw[source])) total[target] += raw[source];
    }
  }
  return total;
}
export function summarize(cells) {
  const decisions = { broad: (cell) => broadDecision(cell.broad), broadFactualFlags: (cell) => factualFlagDecision(cell.broad), shadow: (cell) => shadowDecision(cell.shadow) };
  const forArm = (arm, rows, decide) => {
    const result = counters(rows, decide);
    if (arm !== "broad") return result;
    // Overall blocks may correctly enforce delivery/safety/style even when the
    // candidate is factually fine. These are disagreements, not factual errors.
    const { falseApprovals, falseRejections, correctDecisions, ...rest } = result;
    return { ...rest, factualRejectCleared: falseApprovals, factualAcceptBlocked: falseRejections,
      matchedFactualDecision: correctDecisions };
  };
  const summaries = Object.fromEntries(Object.entries(decisions).map(([arm, decide]) => [arm, forArm(arm, cells, decide)]));
  const verdictConfusion = {};
  for (const cell of cells) {
    const actual = cell.shadow?.status === "completed" ? cell.shadow.assessment.verdict : "unavailable";
    const key = `${cell.expected} -> ${actual}`;
    verdictConfusion[key] = (verdictConfusion[key] ?? 0) + 1;
  }
  const pairs = new Map();
  for (const cell of cells) if (cell.pairId) {
    const key = `${cell.pairId}:${cell.sample}`;
    pairs.set(key, [...(pairs.get(key) ?? []), cell]);
  }
  const pairResults = [...pairs.entries()].map(([id, entries]) => ({ id, cases: entries.map((cell) => cell.caseId),
    completeContrast: entries.some((cell) => expectedDecision(cell.expected) === "accept") && entries.some((cell) => expectedDecision(cell.expected) === "reject"),
    ...Object.fromEntries(Object.entries(decisions).map(([arm, decide]) => [arm, {
      allDecisionsCorrect: entries.every((cell) => expectedDecision(cell.expected) !== "abstain" && expectedDecision(cell.expected) === decide(cell)),
      decisions: entries.map((cell) => decide(cell)),
    }])) }));
  return { ...summaries, verdictConfusion,
    byDomain: Object.fromEntries([...new Set(cells.map((cell) => cell.domain))].map((domain) => [domain,
      Object.fromEntries(Object.entries(decisions).map(([arm, decide]) => [arm, forArm(arm, cells.filter((cell) => cell.domain === domain), decide)]))])),
    byLanguage: Object.fromEntries([...new Set(cells.map((cell) => cell.language))].map((language) => [language,
      Object.fromEntries(Object.entries(decisions).map(([arm, decide]) => [arm, forArm(arm, cells.filter((cell) => cell.language === language), decide)]))])),
    pairs: pairResults, latency: { broad: timing(cells, "broad"), shadow: timing(cells, "shadow") },
    usage: { broad: usage(cells, "broad"), shadow: usage(cells, "shadow") } };
}

async function sourceHashes(split) {
  const paths = ["scripts/factual-shadow-live-eval.mjs", `scripts/fixtures/factual-shadow-${split}.mjs`,
    "scripts/experiments/factualShadowReview.ts", "server/lmStudio.ts", "server/semanticRouter.ts", "server/requestDeliveryReview.ts"];
  return Object.fromEntries(await Promise.all(paths.map(async (path) => [path, sha256(await readFile(new URL(`../${path}`, import.meta.url)))])));
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args); // Validate frozen prompt before importing holdout data.
  const module = await import(`./fixtures/factual-shadow-${options.split}.mjs`);
  const selected = selectCases(options.split === "holdout" ? module.holdoutCases : module.discoveryCases, options);
  const fixtureHash = sha256(JSON.stringify(selected));
  const manifest = { split: options.split, samples: options.samples, concurrency: options.concurrency, promptHash: promptHash(), fixtureHash,
    cells: selected.length * options.samples, maxModelCalls: selected.length * options.samples * MAX_MODEL_CALLS_PER_CELL,
    cases: selected.map(({ id, pairId, domain, language, expected }) => ({ id, pairId, domain, language, expected })) };
  if (options.offline) { console.log(JSON.stringify(manifest, null, 2)); return; }
  const transport = new LmStudioBackend();
  const health = await transport.probe(AbortSignal.timeout(8_000));
  if (!health.connected || !health.id) throw new Error("LM Studio unavailable; no application or alternate provider will be started");
  const output = options.output ? validateOutputPath(options.output) : await mkdtemp(join(tmpdir(), "third-place-factual-shadow-"));
  if (options.output) await mkdir(output); // Never overwrite prior evidence.
  const report = { ...manifest, output, model: health.id, startedAt: new Date().toISOString(),
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--short"], { encoding: "utf8" }).trim(),
    sourceHashes: await sourceHashes(options.split), frozenPrompt: options.frozenPrompt ?? null,
    limitations: ["Synthetic fixtures only; no application, accounts, real memory or publication path is run or modified.",
      "Expected labels are manually authored fixture truth, never an LLM grading its own output.",
      "Overall existing-review blocks include non-factual concerns; factual flags are reported separately and absence is not proof of factual correctness.",
      "Uncertain and unavailable results are not automatically counted correct. Evidence insufficiency is distinct from a proven falsehood.",
      "Source text is synthetic and supplied identically as existing-review snippets and narrow-review sources; no web fetching occurs.",
      "Holdout prompt hash freezes the narrow prompt, not an independent model or proof against training-set contamination.",
      "The existing reviewer may include persona and room guidance intentionally omitted from the narrow factual task.",
      "This harness does not evaluate canonical narrative policies, voice, live feeds or private personal-memory retrieval."], cells: [] };
  const jobs = selected.flatMap((item, i) => Array.from({ length: options.samples }, (_, j) => ({ item, sample: j + 1,
    order: (i + j) % 2 ? "shadow-first" : "broad-first" })));
  let cursor = 0;
  console.log(`PARKED factual shadow experiment (manual run only): ${jobs.length} cells; ${output}`);
  await Promise.all(Array.from({ length: options.concurrency }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const cell = await evaluateShadowCell({ ...job, backend: transport, model: health.id });
      report.cells.push(cell);
      const name = `${cell.caseId}-${cell.sample}.json`;
      await writeFile(join(output, name), JSON.stringify(cell, null, 2), { flag: "wx" });
      console.log(`Completed ${name}: broad=${cell.broad.status === "completed" ? cell.broad.overallDisposition : "unavailable"}, shadow=${cell.shadow.status === "completed" ? cell.shadow.assessment.verdict : "unavailable"}`);
    }
  }));
  report.cells.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.sample - b.sample);
  report.summary = summarize(report.cells);
  report.finishedAt = new Date().toISOString();
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  await writeFile(join(output, "summary.json"), JSON.stringify({ ...manifest, output, model: health.id, summary: report.summary }, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ output, model: health.id, summary: report.summary }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error); process.exitCode = 1; });
