#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  CONVERSATION_MAX_PUBLICATIONS,
  conversationOpportunity,
} from "../server/conversationScheduling.ts";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIRECTOR_PATH = resolve(SCRIPT_DIRECTORY, "../server/director.ts");
const round = (value, digits = 4) => Number(value.toFixed(digits));

/** A tiny reproducible PRNG; it is test machinery, never production pacing. */
export const seededRandom = (seed) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const frequencyReport = (values) => {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .map(([value, count]) => ({ value, count, share: round(count / values.length) }))
    .sort((left, right) => right.count - left.count || String(left.value).localeCompare(String(right.value)));
};

/**
 * Feed explicitly fake model decisions into the production opportunity policy.
 * It is the supplied model stream, not a sampled rhetorical move or target
 * length, that decides whether anyone speaks. This proves scheduling bounds;
 * it cannot establish real-model interest, language or conversation quality.
 */
export const simulateAmbientScenario = ({
  decisions,
  eligibleIds = ["mira", "bosse", "juno", "sana"],
  seed = 0xa11d1e,
}) => {
  const rng = seededRandom(seed);
  const ledger = [];
  const attempts = [];
  let quietCandidateIds = [];
  let lastAuthorId;
  let stop = "stream_exhausted";
  for (const decision of decisions) {
    const opportunity = conversationOpportunity({
      publishedCount: ledger.length,
      lastAuthorId,
      quietCandidateIds,
      eligibleIds,
    });
    if (opportunity.status !== "ready") {
      stop = opportunity.status;
      break;
    }
    const candidateId = opportunity.candidateIds[Math.floor(rng() * opportunity.candidateIds.length)];
    attempts.push({ candidateId, kind: decision.kind, publishedBefore: ledger.length });
    if (decision.kind === "abstain") {
      quietCandidateIds = [...new Set([...quietCandidateIds, candidateId])];
      // Production abandons an empty opening; nothing was ever published.
      if (!ledger.length) { stop = "empty_opening"; break; }
      continue;
    }
    if (decision.kind !== "speak") throw new Error(`Unknown fake model decision: ${decision.kind}`);
    if (decision.publicationSucceeded === false) { stop = "publication_failed"; break; }
    ledger.push({ messageId: `published-${ledger.length + 1}`, authorId: candidateId, content: decision.content });
    lastAuthorId = candidateId;
    quietCandidateIds = [];
  }
  if (stop === "stream_exhausted") {
    const final = conversationOpportunity({ publishedCount: ledger.length, lastAuthorId, quietCandidateIds, eligibleIds });
    if (final.status !== "ready") stop = final.status;
  }
  return { stop, attempts, ledger };
};

export const simulateAmbientEngine = ({ seed = 0xa11d1e } = {}) => {
  const speak = (content, extra = {}) => ({ kind: "speak", content, ...extra });
  const abstain = { kind: "abstain" };
  const fixtures = [
    { name: "empty opening", decisions: [abstain], expectedCount: 0, expectedStop: "empty_opening" },
    ...[1, 2, 4, 7].map((count) => ({
      name: `model supplies ${count} contributions then silence`,
      decisions: [...Array.from({ length: count }, (_, index) => speak(`Source contribution ${index + 1}`)), abstain, abstain],
      expectedCount: count,
      expectedStop: "quiet",
    })),
    {
      name: "another candidate can speak after abstention",
      decisions: [speak("An actual opening"), abstain, speak("Another resident has something to add"), abstain, abstain],
      expectedCount: 2,
      expectedStop: "quiet",
    },
    {
      name: "fairness hard cap",
      decisions: Array.from({ length: 12 }, (_, index) => speak(`Long fake discussion ${index + 1}`)),
      expectedCount: CONVERSATION_MAX_PUBLICATIONS,
      expectedStop: "budget",
    },
    {
      name: "failed publication never enters public ledger",
      decisions: [speak("Actually published"), speak("A draft that must stay absent", { publicationSucceeded: false })],
      expectedCount: 1,
      expectedStop: "publication_failed",
    },
    { name: "no eligible speaker waits", decisions: [speak("Not published")], eligibleIds: [], expectedCount: 0, expectedStop: "wait" },
  ];
  const issues = [];
  const scenarios = fixtures.map(({ name, expectedCount, expectedStop, ...input }, index) => {
    const result = simulateAmbientScenario({ ...input, seed: seed + index });
    if (result.ledger.length !== expectedCount) issues.push(`${name}: published ${result.ledger.length}, expected ${expectedCount}`);
    if (result.stop !== expectedStop) issues.push(`${name}: stopped as ${result.stop}, expected ${expectedStop}`);
    if (result.ledger.some((entry, position) => entry.authorId === result.ledger[position - 1]?.authorId)) {
      issues.push(`${name}: a resident replied to themselves consecutively`);
    }
    for (let position = 1; position < result.attempts.length; position += 1) {
      const previous = result.attempts[position - 1];
      const current = result.attempts[position];
      if (previous.kind === "abstain" && previous.candidateId === current.candidateId) issues.push(`${name}: abstention retried the same candidate`);
    }
    const acceptedContents = input.decisions.filter((decision) => decision.kind === "speak" && decision.publicationSucceeded !== false)
      .slice(0, expectedCount).map((decision) => decision.content);
    if (JSON.stringify(result.ledger.map((entry) => entry.content)) !== JSON.stringify(acceptedContents)) {
      issues.push(`${name}: the public ledger differs from successful publications`);
    }
    return { name, ...result };
  });
  return {
    seed,
    scope: "Fake model streams exercising production scheduling; not an LLM quality evaluation",
    episodes: scenarios.length,
    lengthFrequency: frequencyReport(scenarios.map((scenario) => scenario.ledger.length)),
    scenarios,
    naturalStops: scenarios.filter((scenario) => ["quiet", "empty_opening"].includes(scenario.stop)).length,
    hardCapStops: scenarios.filter((scenario) => scenario.stop === "budget").length,
    hardCapViolations: scenarios.filter((scenario) => scenario.ledger.length > CONVERSATION_MAX_PUBLICATIONS).length,
    passed: issues.length === 0,
    issues,
  };
};

const methodName = (method, sourceFile) => {
  if (!method.name) return undefined;
  if (ts.isIdentifier(method.name) || ts.isStringLiteral(method.name)) return method.name.text;
  return method.name.getText(sourceFile);
};

const classMethods = (sourceFile, className) => {
  const methods = new Map();
  const visit = (node) => {
    if (ts.isClassDeclaration(node) && node.name?.text === className) {
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member)) methods.set(methodName(member, sourceFile), member);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return methods;
};

const calledMemberName = (call) => {
  const expression = call.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
};

const callsIn = (node) => {
  const calls = [];
  const visit = (candidate) => {
    if (ts.isCallExpression(candidate)) {
      calls.push({ name: calledMemberName(candidate), position: candidate.getStart() });
    }
    ts.forEachChild(candidate, visit);
  };
  if (node) visit(node);
  return calls;
};

const hasPublishedMessageOperationKey = (node) => {
  let found = false;
  const visit = (candidate) => {
    if (
      ts.isVariableDeclaration(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === "operationId" &&
      candidate.initializer &&
      ts.isTemplateExpression(candidate.initializer) &&
      candidate.initializer.head.text === "publish:" &&
      candidate.initializer.templateSpans.length === 1
    ) {
      const expression = candidate.initializer.templateSpans[0].expression;
      found = ts.isPropertyAccessExpression(expression) &&
        ts.isIdentifier(expression.expression) &&
        expression.expression.text === "message" &&
        expression.name.text === "id";
    }
    if (!found) ts.forEachChild(candidate, visit);
  };
  if (node) visit(node);
  return found;
};

/**
 * Static AST audit of the durable publication boundary. This deliberately
 * checks call topology rather than matching source-code whitespace or prose.
 */
export const auditPublicationBoundarySource = (source, fileName = "director.ts") => {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const methods = classMethods(sourceFile, "SocialDirector");
  const issues = [];
  const required = ["runAmbient", "recordAmbientPost", "commitAmbientPublication"];
  for (const name of required) {
    if (!methods.has(name)) issues.push(`SocialDirector.${name} is missing`);
  }
  if (issues.length > 0) return { passed: false, issues, callSites: {} };

  const runCalls = callsIn(methods.get("runAmbient").body);
  if (!runCalls.some((call) => call.name === "conversationOpportunity")) {
    issues.push("runAmbient does not use the audited production conversation-opportunity policy");
  }
  if (runCalls.some((call) => ["decideAmbientAction", "sampleAmbientEpisodeShape"].includes(call.name))) {
    issues.push("runAmbient still prescribes semantic moves or sampled episode targets");
  }
  const postPositions = runCalls.filter((call) => call.name === "postPublic").map((call) => call.position);
  const recordPositions = runCalls.filter((call) => call.name === "recordAmbientPost").map((call) => call.position);
  if (postPositions.length === 0) issues.push("runAmbient has no public-message publication call");
  if (recordPositions.length === 0) issues.push("runAmbient never records a successful ambient post");
  if (recordPositions.some((position) => !postPositions.some((postPosition) => postPosition < position))) {
    issues.push("ambient state can be recorded before any preceding postPublic call");
  }

  const recordCalls = callsIn(methods.get("recordAmbientPost").body);
  if (recordCalls.filter((call) => call.name === "commitAmbientPublication").length !== 1) {
    issues.push("recordAmbientPost must commit episode metadata exactly once");
  }

  const commitCallers = [];
  for (const [name, method] of methods) {
    if (name === "commitAmbientPublication") continue;
    if (callsIn(method.body).some((call) => call.name === "commitAmbientPublication")) commitCallers.push(name);
  }
  if (commitCallers.length !== 1 || commitCallers[0] !== "recordAmbientPost") {
    issues.push(`durable ambient commit has unexpected caller(s): ${commitCallers.join(", ") || "none"}`);
  }

  const commitMethod = methods.get("commitAmbientPublication");
  const commitCalls = callsIn(commitMethod.body);
  if (!commitCalls.some((call) => call.name === "openEpisode")) {
    issues.push("first publication cannot open a durable episode");
  }
  if (!commitCalls.some((call) => call.name === "updateEpisode")) {
    issues.push("later publications cannot update a durable episode");
  }
  if (!hasPublishedMessageOperationKey(commitMethod.body)) {
    issues.push("durable publication operations are not idempotently keyed by published message ID");
  }

  return {
    passed: issues.length === 0,
    issues,
    callSites: {
      postPublic: postPositions.length,
      recordAmbientPost: recordPositions.length,
      commitCallers,
      ledgerOpen: commitCalls.filter((call) => call.name === "openEpisode").length,
      ledgerUpdate: commitCalls.filter((call) => call.name === "updateEpisode").length,
    },
  };
};

export const runAmbientAudit = async ({ directorPath = DEFAULT_DIRECTOR_PATH, seed } = {}) => {
  const simulation = simulateAmbientEngine({ seed });
  const publicationBoundary = auditPublicationBoundarySource(
    await readFile(directorPath, "utf8"),
    directorPath,
  );
  const issues = [
    ...simulation.issues.map((issue) => `scheduling: ${issue}`),
    ...publicationBoundary.issues.map((issue) => `publication: ${issue}`),
  ];
  return {
    simulation,
    publicationBoundary,
    passed: issues.length === 0,
    issues,
  };
};

export const renderAmbientAudit = (report) => {
  return [
    "Ambient scheduling deterministic audit",
    report.simulation.scope,
    `Scripted test scenarios: ${report.simulation.episodes}`,
    `Supplied-stream publication counts: ${report.simulation.lengthFrequency.map((entry) => `${entry.value}:${entry.count}`).join(" ")}`,
    `Natural/hard-cap stops: ${report.simulation.naturalStops}/${report.simulation.hardCapStops}`,
    `Publication boundary: ${report.publicationBoundary.passed ? "PASS" : "FAIL"}`,
    report.passed ? "Result: PASS" : `Result: FAIL\n- ${report.issues.join("\n- ")}`,
  ].join("\n");
};

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const json = process.argv.includes("--json");
  const report = await runAmbientAudit();
  console.log(json ? JSON.stringify(report, null, 2) : renderAmbientAudit(report));
  if (!report.passed) process.exitCode = 1;
}
