import { describe, expect, it } from "vitest";
import { recordTurnDiagnostic, type TurnDiagnosticEvent } from "./turnDiagnostics.js";

const context = { kind: "public", channelId: "lobby", trigger: { messageId: "turn-1", authorKind: "human" } };

describe("privacy-bounded interactive turn diagnostics", () => {
  it("emits correlated ISO-timestamped typed outcomes without input prose", () => {
    const output: string[] = [];
    recordTurnDiagnostic({ ...context, content: "private conversation" } as typeof context, {
      stage: "review", outcome: "completed", durationMs: 12.9, candidateCount: 2,
      reviewIssues: ["evidence_ungrounded", "evidence_ungrounded", "secret draft"],
      body: "private model output", memory: "private recollection", error: "token=secret",
      url: "https://example.test/private", query: "private search",
    } as TurnDiagnosticEvent, (line) => output.push(line));
    expect(output).toHaveLength(1);
    const logged = JSON.parse(output[0]!);
    expect(logged).toEqual({
      event: "interactive_turn", timestamp: expect.any(String), medium: "public", triggerMessageId: "turn-1",
      channelId: "lobby", stage: "review", outcome: "completed", durationMs: 13, candidateCount: 2,
      reviewIssues: ["evidence_ungrounded"],
    });
    expect(new Date(logged.timestamp).toISOString()).toBe(logged.timestamp);
    expect(output[0]).not.toContain("private");
    expect(output[0]).not.toContain("secret");
  });

  it.each(["ambient", "welcome", "voice"])("does not add logging volume for %s scenes", (kind) => {
    const output: string[] = [];
    recordTurnDiagnostic({ ...context, kind }, { stage: "generation", outcome: "completed" }, (line) => output.push(line));
    expect(output).toEqual([]);
  });

  it("does not log uncorrelatable or autonomous peer-continuation scenes", () => {
    const output: string[] = [];
    recordTurnDiagnostic({ ...context, trigger: undefined }, { stage: "turn", outcome: "started" }, (line) => output.push(line));
    recordTurnDiagnostic({ ...context, trigger: { ...context.trigger, authorKind: "ai" } }, { stage: "turn", outcome: "started" }, (line) => output.push(line));
    expect(output).toEqual([]);
  });

  it("allows DM correlation and only finite nonnegative metrics and known issue codes", () => {
    const output: string[] = [];
    recordTurnDiagnostic({ ...context, kind: "dm" }, {
      stage: "filter", outcome: "rejected", durationMs: Infinity, queueDepth: -1,
      candidateCount: 1, mechanicalIssues: ["near_duplicate_self", "secret"],
      evidenceAction: "none", replyExpected: "optional", analysisSource: "lm",
    }, (line) => output.push(line));
    expect(JSON.parse(output[0]!)).toMatchObject({
      medium: "dm", mechanicalIssues: ["near_duplicate_self"], candidateCount: 1,
      evidenceAction: "none", replyExpected: "optional", analysisSource: "lm",
    });
    expect(JSON.parse(output[0]!)).not.toHaveProperty("durationMs");
    expect(JSON.parse(output[0]!)).not.toHaveProperty("queueDepth");
  });

  it("drops unknown runtime outcome fields instead of logging arbitrary text", () => {
    const output: string[] = [];
    recordTurnDiagnostic(context, { stage: "review", outcome: "user secret" } as unknown as TurnDiagnosticEvent, (line) => output.push(line));
    expect(output).toEqual([]);
  });

  it("never throws back into model routing or publication when a sink fails", () => {
    expect(() => recordTurnDiagnostic(context, { stage: "turn", outcome: "started" }, () => {
      throw new Error("unavailable log sink");
    })).not.toThrow();
  });
});
