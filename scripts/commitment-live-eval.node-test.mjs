import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./commitment-live-eval.mjs", import.meta.url));
const cwd = fileURLToPath(new URL("../", import.meta.url));
const environment = { ...process.env, LM_STUDIO_BASE_URL: "http://127.0.0.1:1" };
const run = (...args) => spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
  cwd, encoding: "utf8", timeout: 15_000, env: environment,
});
const inline = (source) => spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], {
  cwd, encoding: "utf8", timeout: 15_000, env: environment,
});
const json = (result) => {
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
};

test("offline commitment manifest covers six deliveries, four controls, three languages and direct review cases", () => {
  const result = json(run("--list"));
  assert.equal(result.scenarios.length, 10);
  assert.equal(result.scenarios.filter((scenario) => scenario.category === "delivery").length, 6);
  assert.equal(result.scenarios.filter((scenario) => scenario.category === "control").length, 4);
  assert.deepEqual(new Set(result.scenarios.map((scenario) => scenario.language)), new Set(["sv", "en", "es"]));
  assert.equal(result.scenarios.reduce((sum, scenario) => sum + scenario.directReviewCases, 0), 9);
});

test("dry-run and selection are offline and preserve chosen cases", () => {
  const result = json(run("--dry-run", "--scenarios=en-code-example,en-greeting-control", "--samples=1", "--mode=review"));
  assert.equal(result.samples, 1);
  assert.equal(result.mode, "review");
  assert.deepEqual(result.scenarios.map((scenario) => scenario.id), ["en-code-example", "en-greeting-control"]);
});

test("known correct/incorrect artifact contrast is repeatable but excluded from the original default suite", () => {
  const optIn = json(run("--list", "--correctness-regression"));
  assert.equal(optIn.scenarios.length, 11);
  assert.equal(optIn.scenarios.filter((scenario) => scenario.category === "review-regression").length, 1);
  const only = json(run("--dry-run", "--scenarios=en-sequential-state-review", "--mode=review"));
  assert.equal(only.scenarios.length, 1);
  assert.equal(only.scenarios[0].directReviewCases, 2);
  assert.equal(only.scenarios[0].category, "review-regression");
  const fixtures = json(inline(`
    import { reviewRegressionScenarios } from ${JSON.stringify(new URL("./commitment-live-eval.mjs", import.meta.url).href)};
    const [s] = reviewRegressionScenarios;
    console.log(JSON.stringify({ good: s.goodDraft, bad: s.badDraft, expected: s.badDraftExpected }));
  `));
  assert.equal(fixtures.expected, "reject_incorrect_artifact");
  assert.notEqual(fixtures.good, fixtures.bad);
  assert.ok(fixtures.good.endsWith("console.log(original); // [1, 2, 3, 4]\n```"));
  assert.ok(fixtures.bad.endsWith("console.log(original); // [1, 2, 3]\n```"));
});

test("unknown cases, duplicated cases, modes and unsafe call bounds fail before network access", () => {
  for (const flags of [
    ["--scenarios=missing"], ["--scenarios=sv-riddle,sv-riddle"], ["--concurrency=3"],
    ["--samples=0"], ["--max-calls=25"], ["--mode=unrestricted"],
    ["--mode=generation", "--scenarios=en-sequential-state-review"],
  ]) assert.notEqual(run("--list", ...flags).status, 0);
});

test("review fixtures distinguish a greeting from explicit resumption, and keep synthetic memory bounded", () => {
  const result = json(inline(`
    import { scenarios, reviewRequest } from ${JSON.stringify(new URL("./commitment-live-eval.mjs", import.meta.url).href)};
    import { fixtureContext } from ${JSON.stringify(new URL("./memory-context-live-eval.mjs", import.meta.url).href)};
    const selected = scenarios.filter(s => ["en-code-example", "en-greeting-control", "en-history-resumption"].includes(s.id));
    console.log(JSON.stringify(selected.map(s => {
      const context = fixtureContext(s);
      try { return { id: s.id, request: reviewRequest(s, context) }; }
      finally { context.close(); }
    })));
  `));
  const byId = Object.fromEntries(result.map((entry) => [entry.id, entry.request]));
  assert.deepEqual(byId["en-code-example"].requestOwnerIds, ["ai-sana"]);
  assert.deepEqual(byId["en-greeting-control"].requestOwnerIds, []);
  assert.deepEqual(byId["en-history-resumption"].relationshipNotes, {});
  assert.equal(byId["en-history-resumption"].history.length, 1);
  assert.ok(byId["en-code-example"].relationshipNotes["ai-sana"].includes("openLoop"));
});

test("trace transport freezes exact input without altering it and enforces its model-call budget", () => {
  const result = json(inline(`
    import { traceTransport } from ${JSON.stringify(new URL("./commitment-live-eval.mjs", import.meta.url).href)};
    const calls = [];
    const original = { messages: [{ role: "user", content: "synthetic fixture" }] };
    let forwarded;
    const backend = traceTransport({ providerId: "lmstudio", probe: async () => ({}), complete: async body => { forwarded = body; return { choices: [] }; } }, calls, 1);
    await backend.complete(original, new AbortController().signal);
    original.messages[0].content = "changed after request";
    let bounded = false;
    try { await backend.complete(original, new AbortController().signal); } catch { bounded = true; }
    console.log(JSON.stringify({ sameBody: forwarded === original, recorded: calls[0].request.messages[0].content, count: calls.length, bounded }));
  `));
  assert.equal(result.sameBody, true);
  assert.equal(result.recorded, "synthetic fixture");
  assert.equal(result.count, 1);
  assert.equal(result.bounded, true);
});
