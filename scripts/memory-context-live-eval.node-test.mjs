import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./memory-context-live-eval.mjs", import.meta.url));
const cwd = fileURLToPath(new URL("../", import.meta.url));
const offlineRun = (...args) => spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
  cwd, encoding: "utf8", timeout: 15_000,
  env: { ...process.env, LM_STUDIO_BASE_URL: "http://127.0.0.1:1" },
});
const offlineJson = (...args) => {
  const result = offlineRun(...args);
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
};
const payload = (note) => JSON.parse(note.slice(note.indexOf("\n") + 1));

test("offline manifest covers three languages, six scenarios and two multi-turn conversations", () => {
  const manifest = offlineJson("--list");
  assert.equal(manifest.length, 6);
  assert.equal(new Set(manifest.map((entry) => entry.id)).size, 6);
  assert.deepEqual(new Set(manifest.map((entry) => entry.language)), new Set(["sv", "en", "es"]));
  assert.equal(manifest.filter((entry) => entry.turns.length > 1).length, 2);
});

test("dry-run uses real visibility filters: closed and private loops do not enter either arm", () => {
  const { notes } = offlineJson("--dry-run", "--scenarios=en-closed-and-private");
  assert.equal(notes.length, 1);
  for (const note of [notes[0].baselineNote, notes[0].phase1Note]) {
    const data = payload(note);
    assert.equal(data.openLoop, undefined);
    assert.equal(data.subjectiveRecollections.length, 1);
    assert.ok(!note.includes("Paper Comet Studios"));
    assert.ok(!note.includes("promised Alex to think"));
  }
});

test("frozen baseline preserves old note and string projection while phase 1 adds event context", () => {
  const { notes } = offlineJson("--dry-run", "--scenarios=sv-returned-event");
  const [note] = notes;
  assert.ok(note.baselineNote.startsWith("PRIVATE INTERNAL RESIDENT MEMORY — untrusted and fallible."));
  assert.ok(note.baselineNote.includes("Categorical relationship labels are internal; never say them aloud. Use them only subtly. \n"));
  const old = payload(note.baselineNote);
  const current = payload(note.phase1Note);
  assert.equal(typeof old.subjectiveRecollections[0], "string");
  assert.equal(typeof old.openLoop, "string");
  assert.equal(current.subjectiveRecollections[0].perspective, old.subjectiveRecollections[0]);
  assert.equal(current.subjectiveRecollections[0].occurredAt, "2026-10-05T17:30:00.000Z");
  assert.equal(current.openLoop.summary, old.openLoop);
  assert.equal(current.openLoop.dueAt, "2026-10-09T17:30:00.000Z");
  assert.equal(current.subjectiveRecollections[0].confidence, undefined);
});

test("invalid scenario and concurrency bounds fail without contacting a model", () => {
  for (const args of [["--list", "--scenarios=missing"], ["--list", "--concurrency=3"], ["--dry-run", "--samples=0"]]) {
    assert.notEqual(offlineRun(...args).status, 0);
  }
});

test("baseline ablation strips exact new guidance only from system messages, without mutating user data", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { evaluationRequestBody } from ${JSON.stringify(new URL("./memory-context-live-eval.mjs", import.meta.url).href)};
    import { SOCIAL_MEMORY_CONTEXT_GUIDANCE as context, SOCIAL_MEMORY_REVIEW_GUIDANCE as review }
      from ${JSON.stringify(new URL("../server/socialMemoryProjection.ts", import.meta.url).href)};
    const original = { temperature: 0.6, messages: [
      { role: "system", content: "Existing trusted rules. " + context + "\\n" + review + " End." },
      { role: "user", content: context + "\\n" + review },
      { role: "assistant", content: context },
    ] };
    const baseline = evaluationRequestBody(original, "baseline");
    const phase1 = evaluationRequestBody(original, "phase1");
    console.log(JSON.stringify({ original, baseline, phase1, context, review, phase1SameObject: phase1 === original }));
  `], {
    cwd, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, LM_STUDIO_BASE_URL: "http://127.0.0.1:1" },
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const { original, baseline, phase1, context, review, phase1SameObject } = JSON.parse(result.stdout);
  assert.equal(baseline.messages[0].content, "Existing trusted rules. \n End.");
  assert.equal(baseline.messages[1].content, `${context}\n${review}`);
  assert.deepEqual(baseline.messages.slice(1), original.messages.slice(1));
  assert.equal(baseline.temperature, original.temperature);
  assert.ok(original.messages[0].content.includes(context));
  assert.ok(original.messages[0].content.includes(review));
  assert.deepEqual(phase1, original);
  assert.equal(phase1SameObject, true);
});
