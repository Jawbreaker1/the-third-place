import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActorChannelRuntime } from "./actorChannels.js";
import { SocialDirector } from "./director.js";
import type { SceneRequest } from "./lmStudio.js";
import { PERSONAS } from "./personas.js";
import { createFailClosedTurnAnalysis, projectTrustedTurnAnalysis, type TurnAnalysis } from "./semanticRouter.js";
import { RoomStore } from "./store.js";

const human = {
  id: "synthetic-dm-owner-human", name: "Alex", kind: "human" as const, status: "online" as const,
  avatar: { color: "#123456", accent: "#654321", glyph: "A" },
};
const persona = PERSONAS.find((candidate) => candidate.id === "ai-sana")!;
const previousPromise = "Fallible prior memory: Sana offered Alex a programming example when Alex wanted to study.";
const cleanup: Array<{ director: SocialDirector; store: RoomStore; directory: string }> = [];

afterEach(async () => {
  for (const { director, store, directory } of cleanup.splice(0)) {
    director.stop();
    await store.flush();
    await rm(directory, { recursive: true, force: true });
  }
});

const classified = (intent: Partial<TurnAnalysis["intent"]>): TurnAnalysis => {
  const base = createFailClosedTurnAnalysis("disabled");
  return {
    ...base, source: "lm", failureReason: null,
    intent: { ...base.intent, kind: "statement", isQuestion: false, replyExpected: "optional", confidence: 0.99, ...intent },
  };
};

const fixture = async (analysis: TurnAnalysis) => {
  const directory = await mkdtemp(join(tmpdir(), "third-place-dm-ownership-"));
  const store = new RoomStore(join(directory, "rooms.json"));
  const thread = store.openDm(human.id, persona.id);
  const generateScene = vi.fn(async (_request: SceneRequest) => [{
    personaId: persona.id, content: "A synthetic reviewed reply.", source: "lm" as const, sourceIds: [],
  }]);
  const research = vi.fn();
  const researchSite = vi.fn();
  const director = new SocialDirector(
    { to: () => ({ emit: vi.fn() }) } as never,
    store,
    { analyzeTurn: vi.fn(async () => analysis), generateScene, rememberDeliveredLine: vi.fn() } as never,
    new ActorChannelRuntime(),
    { research, researchSite } as never,
    {
      getRelation: vi.fn(() => undefined), updateRelation: vi.fn(),
      promptNote: vi.fn(() => previousPromise), noteClassifiedMemoryFact: vi.fn(),
    } as never,
    () => [human, ...PERSONAS],
    () => 1,
    {
      dmDebounceMs: 0,
      weatherForecastProvider: null,
      pageReader: { collectCandidates: () => ({ requestedAt: new Date().toISOString(), candidates: [] }) } as never,
    },
  );
  cleanup.push({ director, store, directory });
  return { director, store, thread, generateScene, research, researchSite };
};

describe("director current-turn DM ownership", () => {
  const scenarios: Array<{ name: string; text: string; analysis: TurnAnalysis }> = [
    {
      name: "an imperative misclassified as optional rather than a question",
      text: "Show me the small runnable example we discussed.",
      analysis: classified({ kind: "request", isQuestion: false, replyExpected: "optional" }),
    },
    {
      name: "an unavailable intent classifier",
      text: "Ready now, go ahead with the example.",
      analysis: createFailClosedTurnAnalysis("invalid_output"),
    },
    {
      name: "an under-confident intent without promoting its flags",
      text: "Can you explain the result?",
      analysis: classified({ kind: "question", isQuestion: true, replyExpected: "expected", confidence: 0.2 }),
    },
    {
      name: "a greeting while an old commitment is present",
      text: "Hej, ville bara säga god kväll före middagen!",
      analysis: classified({ kind: "greeting", replyExpected: "none" }),
    },
    {
      name: "a future-plan confirmation rather than a demand for an artifact",
      text: "No me des el ejemplo todavía, solo confirmaba el plan para mañana.",
      analysis: classified({ kind: "statement", replyExpected: "optional" }),
    },
    {
      name: "a request whose necessary input has not been supplied",
      text: "Peux-tu me dire quelle ligne de mon fichier privé est incorrecte ?",
      analysis: classified({ kind: "question", isQuestion: true, replyExpected: "expected" }),
    },
  ];

  it.each(scenarios)("retains the sole current recipient for $name", async ({ text, analysis }) => {
    const { director, store, thread, generateScene, research, researchSite } = await fixture(analysis);
    const message = store.addDmMessage(thread.id, human.id, text)!;
    const expectedSemantics = projectTrustedTurnAnalysis(analysis);
    await director.onDirectMessage(message, human, persona);

    expect(generateScene).toHaveBeenCalledOnce();
    const request = generateScene.mock.calls[0]![0];
    expect(request.kind).toBe("dm");
    expect(request.selected.map((entry) => entry.id)).toEqual([persona.id]);
    expect(request.mustReplyIds).toEqual([persona.id]);
    expect(request.requestOwnerIds).toEqual([persona.id]);
    expect(request.trigger).toMatchObject({ authorId: human.id, messageId: message.id, content: text });
    expect(request.semanticContext).toMatchObject({
      intentTrusted: expectedSemantics.intentTrusted,
      replyExpected: expectedSemantics.replyExpected,
      answerDepth: expectedSemantics.answerDepth,
    });
    expect(request.relationshipNotes?.[persona.id]).toContain(previousPromise);
    expect(request.requestDeliveryRecovery).toBeUndefined();
    expect(request.responseRecoveryBudget).toEqual({ retriesRemaining: 1 });
    expect(research).not.toHaveBeenCalled();
    expect(researchSite).not.toHaveBeenCalled();
    if (expectedSemantics.replyExpected !== "expected") {
      expect(request.premise ?? "").not.toContain("The latest turn expects a real response");
    }
    expect(store.getDmMessages(thread.id).at(-1)).toMatchObject({ authorId: persona.id, replyToId: message.id });
  });
});
