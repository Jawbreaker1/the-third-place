import { describe, expect, it, vi } from "vitest";
import { ActorChannelRuntime } from "./actorChannels.js";
import { PERSONAS } from "./personas.js";
import { RoomStore } from "./store.js";
import {
  addressedPersonaIds,
  ambientConversationPremise,
  ambientLanguageHint,
  ambientSceneWordLimits,
  analyzeSocialSignals,
  consideredConversationLeadPremise,
  consideredConversationPremise,
  consideredConversationResponsePremise,
  consideredConversationWordLimits,
  ensureEvidenceResponder,
  evidenceFailureFallback,
  groundedEvidenceFallback,
  normalizeGeneratedMessageContent,
  pageEvidenceAnswerContract,
  selectAmbientLead,
  selectConsideredConversation,
  selectResponders,
  SocialDirector,
  shouldRejectPublicCandidate,
  shouldStartConsideredConversation,
  sourceIdsForPageResponder,
  trailingAiMessageCount,
  type ConsideredConversationGate,
} from "./director.js";

describe("social director", () => {
  it("requires concrete host-aware answers from successful page reads", () => {
    const packet = (title: string, url: string) => ({
      kind: "page" as const,
      query: "read it",
      retrievedAt: new Date().toISOString(),
      results: [{ id: "S1", title, url, snippet: "A concrete supported detail from the page." }],
    });
    expect(pageEvidenceAnswerContract(packet("Avanza – Börsen idag", "https://www.avanza.se/"))).toContain("headline-index level");
    expect(pageEvidenceAnswerContract(packet("Avanza article", "https://www.avanza.se/placera/redaktionellt/article")))
      .not.toContain("headline-index level");
    expect(pageEvidenceAnswerContract(packet("Avanza – Börsen idag", "https://example.com/spoof")))
      .not.toContain("headline-index level");
    expect(pageEvidenceAnswerContract(packet("News - WoW", "https://worldofwarcraft.blizzard.com/en-us/News")))
      .toContain("exact supplied headline");
    expect(pageEvidenceAnswerContract(packet("Example", "https://example.com/article")))
      .toContain("at least one concrete supported detail");
  });

  it("builds a Swedish Avanza fallback from only the first complete validated index row", () => {
    const answer = groundedEvidenceFallback({
      kind: "page",
      query: "dagens kurser",
      retrievedAt: new Date().toISOString(),
      results: [{
        id: "S1",
        title: "Avanza – Börsen idag",
        url: "https://www.avanza.se/",
        snippet: "Avanzas publika marknadsöversikt. Detta är huvudindex.\nOMX Stockholm 30 (OMXS30): 3 167,16 indexpunkter, -0,33 % idag, uppdaterad 17:30.\nDow Jones U.S. Index (DJUS): 1 826,71 indexpunkter, -0,78 % idag, uppdaterad 22:04.",
      }],
    }, "vilka är dagens kurser?");
    expect(answer).toEqual({
      content: "Avanza visar OMX Stockholm 30 (OMXS30): 3 167,16 indexpunkter, -0,33 % idag (uppdaterad 17:30). Säg vilken aktie eller ticker du menar om du vill ha en enskild kurs.",
      sourceIds: ["S1"],
    });
    expect(answer?.content).not.toContain("Dow Jones");
  });

  it("preserves punctuation in the first validated Avanza index label", () => {
    const answer = groundedEvidenceFallback({
      kind: "page",
      query: "dagens kurser",
      retrievedAt: new Date().toISOString(),
      results: [{
        id: "S1",
        title: "Avanza – Börsen idag",
        url: "https://www.avanza.se/",
        snippet: "Avanzas publika marknadsöversikt.\nDow Jones U.S. Index (DJUS): 1 826,71 indexpunkter, -0,78 % idag, uppdaterad 22:04.",
      }],
    }, "dagens kurser?");
    expect(answer?.content).toContain("Dow Jones U.S. Index (DJUS)");
    expect(answer?.content).not.toContain("Avanza visar Index (DJUS)");
  });

  it("builds bounded page and search fallbacks with the server-owned source", () => {
    const page = groundedEvidenceFallback({
      kind: "page",
      query: "read it",
      retrievedAt: new Date().toISOString(),
      results: [{
        id: "S1",
        title: "News - WoW",
        url: "https://worldofwarcraft.blizzard.com/en-us/News",
        snippet: "Stoneforged Sentinel arrives\n\nThe mount supports more than 300,000 customization combinations.\n\nA second unrelated block.",
      }],
    }, "which item is interesting?");
    expect(page).toEqual({
      content: "From “News - WoW”: Stoneforged Sentinel arrives",
      sourceIds: ["S1"],
    });
    expect(page?.content.length).toBeLessThanOrEqual(360);

    const search = groundedEvidenceFallback({
      kind: "search",
      query: "site:example.com update",
      retrievedAt: new Date().toISOString(),
      results: [{ id: "S1", title: "Official update", url: "https://example.com/update", snippet: "Details" }],
    }, "vad hittade du?");
    expect(search).toEqual({ content: "Första källträffen är “Official update”.", sourceIds: ["S1"] });
    expect(groundedEvidenceFallback({
      kind: "search",
      query: "missing source",
      retrievedAt: new Date().toISOString(),
      results: [{ id: "S2", title: "Wrong source", url: "https://example.com", snippet: "Details" }],
    })).toBeUndefined();
  });

  it("uses a temporary deterministic failure instead of generic social chatter", () => {
    expect(evidenceFailureFallback(true, "kan ni läsa länken?")).toEqual({
      content: "Jag fick inte fram något läsbart från just den länken den här gången.",
      sourceIds: [],
    });
    expect(evidenceFailureFallback(false, "please check the latest prices")).toEqual({
      content: "I didn't get a usable source result for that search this time.",
      sourceIds: [],
    });
  });

  it("wires DM evidence fallbacks to the actual message source metadata", async () => {
    vi.useFakeTimers();
    try {
      const human = {
        id: "guest-evidence",
        name: "Jaw_B",
        kind: "human" as const,
        status: "online" as const,
        avatar: { color: "#123", accent: "#456", glyph: "J" },
      };
      const persona = PERSONAS.find((candidate) => candidate.id === "ai-linnea")!;
      const pagePacket = {
        kind: "page" as const,
        query: "dagens kurser",
        retrievedAt: new Date().toISOString(),
        results: [{
          id: "S1",
          title: "Avanza – Börsen idag",
          url: "https://www.avanza.se/",
          snippet: "Avanzas publika marknadsöversikt.\nOMX Stockholm 30 (OMXS30): 3 167,16 indexpunkter, -0,33 % idag, uppdaterad 17:30.",
        }],
      };
      const runCase = async (evidence: typeof pagePacket | undefined) => {
        const emit = vi.fn();
        const store = new RoomStore("/tmp/director-evidence-test-unused.json");
        const thread = store.openDm(human.id, persona.id);
        const incoming = store.addDmMessage(
          thread.id,
          human.id,
          "@Linnea kolla dagens kurser på https://www.avanza.se",
        )!;
        const lm = {
          generateScene: vi.fn(async () => evidence ? [] : [{
            personaId: persona.id,
            content: "okej, det där fick min uppmärksamhet",
            source: "lm" as const,
            sourceIds: [],
          }]),
          rememberDeliveredLine: vi.fn(),
        };
        const pageReader = {
          resolveRequest: vi.fn(() => ({
            url: new URL("https://www.avanza.se/"),
            requestedAt: new Date().toISOString(),
            intent: incoming.content,
            source: "message" as const,
          })),
          read: vi.fn(async () => evidence),
        };
        const researchBroker = {
          shouldResearch: vi.fn(() => false),
          researchUrlFallback: vi.fn(async () => undefined),
        };
        const humanMemory = {
          getRelation: vi.fn(() => undefined),
          updateRelation: vi.fn(),
          promptNote: vi.fn(() => undefined),
        };
        const director = new SocialDirector(
          { to: vi.fn(() => ({ emit })) } as never,
          store,
          lm as never,
          new ActorChannelRuntime(),
          researchBroker as never,
          humanMemory as never,
          () => [human, ...PERSONAS],
          () => 1,
          { pageReader: pageReader as never, now: () => Date.now() },
        );
        const pending = director.onDirectMessage(incoming, human, persona);
        await vi.runAllTimersAsync();
        await pending;
        director.stop();
        return store.getDmMessages(thread.id).at(-1)!;
      };

      const sourced = await runCase(pagePacket);
      expect(sourced.generation).toBe("fallback");
      expect(sourced.content).toContain("OMX Stockholm 30 (OMXS30)");
      expect(sourced.sources).toEqual([{ title: "Avanza – Börsen idag", url: "https://www.avanza.se/" }]);

      const failed = await runCase(undefined);
      expect(failed.generation).toBe("fallback");
      expect(failed.content).toBe("Jag fick inte fram något läsbart från just den länken den här gången.");
      expect(failed.sources).toEqual([]);
      expect(failed.content).not.toContain("uppmärksamhet");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps mentions while reserving one bounded slot for a capable evidence reader", () => {
    const researcher = PERSONAS.find((persona) => persona.canResearch)!;
    const nonResearchers = PERSONAS.filter((persona) => !persona.canResearch).slice(0, 3);
    const result = ensureEvidenceResponder(
      nonResearchers,
      [researcher, ...nonResearchers],
      [nonResearchers[0]!.id],
      new Map([[researcher.id, 1]]),
    );
    expect(result.selected).toHaveLength(3);
    expect(result.selected.map((persona) => persona.id)).toContain(nonResearchers[0]!.id);
    expect(result.selected.map((persona) => persona.id)).toContain(researcher.id);
    expect(result.responder?.id).toBe(researcher.id);
  });

  it("can designate a mentioned resident for a supplied page when all three slots are mentioned", () => {
    const mentioned = PERSONAS.filter((persona) => !persona.canResearch).slice(0, 3);
    const result = ensureEvidenceResponder(mentioned, mentioned, mentioned.map((persona) => persona.id), new Map(), false);
    expect(result.selected).toEqual(mentioned);
    expect(result.responder?.id).toBe(mentioned[0]?.id);
  });

  it("always gives explicit evidence a single owner when no specialist is attentive", () => {
    const ordinary = PERSONAS.filter((persona) => !persona.canResearch).slice(0, 2);
    const result = ensureEvidenceResponder(ordinary, ordinary, [], new Map(), true);
    expect(result.responder?.id).toBe(ordinary[0]?.id);
    expect(result.selected.filter((persona) => persona.id === result.responder?.id)).toHaveLength(1);
  });

  it("guarantees the validated page source on the designated generated answer only", () => {
    const pageResearch = {
      kind: "page" as const,
      query: "read it",
      retrievedAt: new Date().toISOString(),
      results: [{ id: "S1", title: "Example", url: "https://example.com", snippet: "evidence" }],
    };
    expect(sourceIdsForPageResponder(pageResearch, [], true)).toEqual(["S1"]);
    expect(sourceIdsForPageResponder(pageResearch, ["S1"], true)).toEqual(["S1"]);
    expect(sourceIdsForPageResponder(pageResearch, [], false)).toEqual([]);
    expect(sourceIdsForPageResponder(pageResearch, ["S1"], false)).toEqual([]);
    expect(sourceIdsForPageResponder({ ...pageResearch, kind: "search" }, [], true)).toEqual([]);
  });

  it("always prioritises a directly mentioned quiet resident", () => {
    const signals = analyzeSocialSignals("@moss what do you think about this?");
    const selected = selectResponders(PERSONAS, signals, new Map(), Date.now(), () => 0.99);
    expect(selected.map((persona) => persona.id)).toContain("ai-moss");
  });

  it("treats a Discord reply to an AI resident as direct address even outside their roster", () => {
    expect(addressedPersonaIds([], { authorId: "ai-kim" })).toEqual(["ai-kim"]);
    expect(addressedPersonaIds(["ai-sana"], { authorId: "ai-kim" })).toEqual(["ai-sana", "ai-kim"]);
    expect(addressedPersonaIds([], { authorId: "human-johan" })).toEqual([]);
    expect(addressedPersonaIds([], { authorId: "ai-kim", system: true })).toEqual([]);
  });

  it("recognises high-energy absurd messages", () => {
    const signals = analyzeSocialSignals("HEAR ME OUT!!! what if the banana runs the server? 🤯🤯");
    expect(signals.absurdity).toBeGreaterThan(0.4);
    expect(signals.energy).toBeGreaterThan(0.5);
  });

  it("measures an uninterrupted autonomous tail without letting room notices reset it", () => {
    const history = [
      { authorId: "human-johan" },
      { authorId: "ai-sana" },
      { authorId: "room", system: true },
      { authorId: "ai-vale" },
    ];
    expect(trailingAiMessageCount(history)).toBe(2);
    expect(trailingAiMessageCount([...history, { authorId: "human-friend" }])).toBe(0);
  });

  it("anchors autonomous language to the latest human-authored message", () => {
    const now = Date.parse("2026-07-13T12:00:00.000Z");
    const oldHuman = {
      id: "old",
      authorId: "human-old",
      content: "old thought",
      createdAt: new Date(now - 31 * 60_000).toISOString(),
    };
    const freshHuman = {
      id: "fresh",
      authorId: "human-johan",
      content: "hur skulle ni lösa det här?",
      createdAt: new Date(now - 60_000).toISOString(),
    };
    const aiTail = {
      id: "ai-tail",
      authorId: "ai-sana",
      content: "en tidigare replik",
      createdAt: new Date(now - 30_000).toISOString(),
    };
    expect(ambientLanguageHint([oldHuman, freshHuman, aiTail])).toBe("Swedish");
  });

  it("chooses a room-relevant lead over the loudest generic resident", () => {
    const candidates = PERSONAS.filter((persona) => ["ai-bosse", "ai-sana"].includes(persona.id));
    const lead = selectAmbientLead(candidates, (id) => (id === "ai-sana" ? 1 : 0), () => 0);
    expect(lead?.id).toBe("ai-sana");
  });

  it("rotates among the strongest room-relevant leads instead of crowning one permanent host", () => {
    const candidates = PERSONAS.filter((persona) => ["ai-pixel", "ai-bosse", "ai-juno"].includes(persona.id));
    const affinities = new Map([
      ["ai-pixel", 0.95],
      ["ai-bosse", 0.86],
      ["ai-juno", 0.84],
    ]);
    const leads = [0.05, 0.55, 0.95].map((roll) =>
      selectAmbientLead(candidates, (id) => affinities.get(id) ?? 0, () => roll)?.id,
    );
    expect(new Set(leads).size).toBeGreaterThan(1);
    expect(leads).not.toContain(undefined);
  });

  it("lets sociable voices open pub banter while quieter experts remain available to reply", () => {
    const candidates = PERSONAS.filter((persona) => ["ai-juno", "ai-mira", "ai-farah"].includes(persona.id));
    const lead = selectAmbientLead(candidates, () => 0.8, () => 0, "banter");
    expect(["ai-juno", "ai-mira"]).toContain(lead?.id);
    expect(lead?.id).not.toBe("ai-farah");
  });

  it("turns a concrete seed into a bounded claim-and-response contract", () => {
    const lead = PERSONAS.find((persona) => persona.id === "ai-sana")!;
    const responder = PERSONAS.find((persona) => persona.id === "ai-vale")!;
    const seed = "Fail-silent background agents create more trust than canned fallback chatter.";
    const premise = ambientConversationPremise(seed, lead, responder, false, true);
    const limits = ambientSceneWordLimits(lead, responder, false);
    expect(premise).toContain(seed);
    expect(premise).toContain("specific, defensible claim");
    expect(premise).toContain("counterexample or hidden cost");
    expect(premise).toContain("Exactly the selected residents speak in order");
    expect(limits[lead.id]).toEqual({ minimum: lead.style.typicalWords[0], maximum: lead.style.hardMaxWords });
    expect(limits[responder.id]).toEqual({ minimum: responder.style.typicalWords[0] - 1, maximum: 28 });
  });

  it("turns the same machinery into short social banter for the pub", () => {
    const lead = PERSONAS.find((persona) => persona.id === "ai-juno")!;
    const responder = PERSONAS.find((persona) => persona.id === "ai-bosse")!;
    const seed = "Put one beloved film on trial for its ending.";
    const premise = ambientConversationPremise(seed, lead, responder, false, true, "banter");
    const limits = ambientSceneWordLimits(lead, responder, false, "banter");
    expect(premise).toContain(seed);
    expect(premise).toContain("one concrete social hook");
    expect(premise).toContain("countertake, adjacent recommendation, punchline");
    expect(premise).not.toContain("specific, defensible claim");
    expect(premise).not.toContain("counterexample or hidden cost");
    expect(limits[lead.id]).toEqual({ minimum: lead.style.typicalWords[0], maximum: 26 });
    expect(limits[responder.id]).toEqual({ minimum: 2, maximum: 20 });
  });

  it("uses an everyday, shorter contract in casual rooms without rewarding complexity as the house voice", () => {
    const lead = PERSONAS.find((persona) => persona.id === "ai-ibrahim")!;
    const responder = PERSONAS.find((persona) => persona.id === "ai-mira")!;
    const premise = ambientConversationPremise(
      "A quiet regular remembers why the room made an odd decision.",
      lead,
      responder,
      false,
      false,
      "casual",
    );
    const limits = ambientSceneWordLimits(lead, responder, false, "casual");

    expect(premise).toContain("ordinary phrase, recognizable example or specific detail");
    expect(premise).toContain("No miniature essay");
    expect(premise).not.toContain("specific, defensible claim");
    expect(limits[lead.id]!.maximum).toBeLessThan(lead.style.hardMaxWords);
    expect(limits[lead.id]!.minimum).toBe(lead.style.typicalWords[0]);
  });

  it("keeps autonomous rooms silent when the model is offline or returns no valid lines", async () => {
    const runCase = async (
      connected: boolean,
      recentMessages: Array<Record<string, unknown>> = [],
      knownHumanChannel = false,
    ) => {
      const emit = vi.fn();
      const io = { to: vi.fn(() => ({ emit })) };
      const store = {
        getRecent: vi.fn(() => recentMessages),
        addPublicMessage: vi.fn(),
      };
      const lm = {
        health: vi.fn(() => ({ connected, queueDepth: 0, label: connected ? "Gemma" : "offline" })),
        generateScene: vi.fn(async () => []),
      };
      const director = new SocialDirector(
        io as never,
        store as never,
        lm as never,
        new ActorChannelRuntime(),
        {} as never,
        {} as never,
        () => PERSONAS,
        () => 1,
        { rng: () => 0, now: () => 2_000_000, consideredConversationChance: 0 },
      );
      if (knownHumanChannel) {
        (director as unknown as { lastHumanMessageAtByChannel: Map<string, number> })
          .lastHumanMessageAtByChannel.set("lobby", 1_900_000);
      }
      await (director as unknown as { runAmbient: () => Promise<void> }).runAmbient();
      director.stop();
      return { store, lm };
    };

    const offline = await runCase(false);
    const empty = await runCase(true);
    const freshRestartTail = await runCase(true, [{
      id: "recent-ai",
      channelId: "lobby",
      authorId: "ai-sana",
      content: "one prior autonomous line",
      createdAt: new Date(1_970_000).toISOString(),
      reactions: [],
    }]);
    const humanTriggeredTail = await runCase(true, [{
      id: "human-triggered-ai",
      channelId: "lobby",
      authorId: "ai-sana",
      content: "a reply caused by a known human message",
      createdAt: new Date(1_970_000).toISOString(),
      reactions: [],
    }], true);
    expect(offline.lm.generateScene).not.toHaveBeenCalled();
    expect(offline.store.addPublicMessage).not.toHaveBeenCalled();
    expect(empty.lm.generateScene).toHaveBeenCalledTimes(1);
    expect(empty.store.addPublicMessage).not.toHaveBeenCalled();
    expect(freshRestartTail.lm.generateScene).not.toHaveBeenCalled();
    expect(freshRestartTail.store.addPublicMessage).not.toHaveBeenCalled();
    expect(humanTriggeredTail.lm.generateScene).toHaveBeenCalledTimes(1);
    expect(humanTriggeredTail.store.addPublicMessage).not.toHaveBeenCalled();
  });

  it("does not recruit the moderator for ordinary banter", () => {
    const signals = analyzeSocialSignals("pineapple pizza is obviously the best");
    const selected = selectResponders(PERSONAS, signals, new Map(), Date.now(), () => 0.5);
    expect(selected.map((persona) => persona.id)).not.toContain("ai-runa");
  });

  it("does not confuse names with substrings", () => {
    expect(analyzeSocialSignals("det här är en beautiful idé").mentionedIds).not.toContain("ai-bea");
    expect(analyzeSocialSignals("vad tycker ni om valet?").mentionedIds).not.toContain("ai-vale");
    expect(analyzeSocialSignals("Vale, vad tycker du?").mentionedIds).toContain("ai-vale");
  });

  it("routes a single clear attack to the moderator", () => {
    const signals = analyzeSocialSignals("du är en idiot");
    const selected = selectResponders(PERSONAS, signals, new Map(), Date.now(), () => 0.99);
    expect(signals.aggression).toBeGreaterThanOrEqual(0.4);
    expect(selected.map((persona) => persona.id)).toEqual(["ai-runa"]);
  });

  it("treats a single absolute claim as dissent-worthy without substring false positives", () => {
    expect(analyzeSocialSignals("Gemma är bäst").claimStrength).toBeGreaterThan(0.28);
    expect(analyzeSocialSignals("min beställning kom idag").claimStrength).toBeLessThan(0.28);
  });

  it("opens a considered beat only on the rare roll after quiet and cooldown", () => {
    const now = 2_000_000;
    const base: ConsideredConversationGate = {
      now,
      lastStartedAt: now - 600_000,
      lastHumanActivityAt: now - 75_000,
      cooldownMs: 600_000,
      humanQuietMs: 75_000,
      chance: 0.1,
      queueDepth: 0,
      availableMessageSlots: 2,
      voiceRoomActive: false,
      alreadyInFlight: false,
      rng: () => 0.099,
    };

    expect(shouldStartConsideredConversation(base)).toBe(true);
    expect(shouldStartConsideredConversation({ ...base, rng: () => 0.1 })).toBe(false);
  });

  it("blocks considered beats before rolling when people, voice, queue, spam limits or another beat intervene", () => {
    const now = 2_000_000;
    let rolls = 0;
    const base: ConsideredConversationGate = {
      now,
      lastStartedAt: now - 600_000,
      lastHumanActivityAt: now - 75_000,
      cooldownMs: 600_000,
      humanQuietMs: 75_000,
      chance: 1,
      queueDepth: 0,
      availableMessageSlots: 2,
      voiceRoomActive: false,
      alreadyInFlight: false,
      rng: () => {
        rolls += 1;
        return 0;
      },
    };
    const blocked: Partial<ConsideredConversationGate>[] = [
      { voiceRoomActive: true },
      { alreadyInFlight: true },
      { queueDepth: 1 },
      { availableMessageSlots: 1 },
      { lastStartedAt: now - 599_999 },
      { lastHumanActivityAt: now - 74_999 },
    ];

    for (const override of blocked) {
      expect(shouldStartConsideredConversation({ ...base, ...override })).toBe(false);
    }
    expect(rolls).toBe(0);
  });

  it("pairs distinct relevant residents and gives the responder a non-echo role", () => {
    const candidates = PERSONAS.filter((persona) => ["ai-sana", "ai-vale", "ai-mira"].includes(persona.id));
    const affinities = new Map([
      ["ai-sana", 0.95],
      ["ai-vale", 0.8],
      ["ai-mira", 0.7],
    ]);
    const plan = selectConsideredConversation(candidates, new Map(), 2_000_000, (id) => affinities.get(id) ?? 0, () => 0);

    expect(plan?.lead.id).toBe("ai-sana");
    expect(plan?.responder.id).toBe("ai-vale");
    expect(plan?.responseRole).toBe("challenge");
    expect(plan?.lead.id).not.toBe(plan?.responder.id);
    const challengePremise = consideredConversationPremise(plan!);
    const anchoredPremise = consideredConversationPremise(plan!, "A deterministic director should own pacing.");
    const leadPremise = consideredConversationLeadPremise(plan!, "A deterministic director should own pacing.");
    const responsePremise = consideredConversationResponsePremise(plan!);
    const examplePremise = consideredConversationPremise({ ...plan!, responseRole: "example" });
    const questionPremise = consideredConversationPremise({ ...plan!, responseRole: "question" });
    expect(challengePremise).toContain("24–52 words");
    expect(challengePremise).toContain("7–28 words");
    expect(examplePremise).toContain("7–28 words");
    expect(questionPremise).toContain("7–24 words");
    expect([challengePremise, examplePremise, questionPremise].join(" ")).not.toContain("12–35 words");
    expect(challengePremise).toContain("hidden assumption");
    expect(challengePremise).toContain("nobody piles on");
    expect(anchoredPremise).toContain("A deterministic director should own pacing.");
    expect(leadPremise).toContain("Only Sana speaks in this generation");
    expect(responsePremise).toContain("Respond directly to Sana's latest transcript line");
    expect(responsePremise).toContain("Only Vale speaks in this generation");
  });

  it("keeps a rare deeper pub beat conversational and shorter than a technical considered post", () => {
    const plan = {
      lead: PERSONAS.find((persona) => persona.id === "ai-juno")!,
      responder: PERSONAS.find((persona) => persona.id === "ai-nox")!,
      responseRole: "example" as const,
    };
    const lead = consideredConversationLeadPremise(plan, "Defend one flawed film.", "banter");
    const response = consideredConversationResponsePremise(plan, "banter");
    const combined = consideredConversationPremise(plan, "Defend one flawed film.", "banter");
    expect(lead).toContain("16–40-word");
    expect(response).toContain("4–20 words");
    expect(combined).toContain("deeper table-talk beat");
    expect(combined).not.toContain("45–75-word");
  });

  it("keeps every register inside the actor's own hard maximum", () => {
    const plan = {
      lead: PERSONAS.find((persona) => persona.id === "ai-ibrahim")!,
      responder: PERSONAS.find((persona) => persona.id === "ai-farah")!,
      responseRole: "challenge" as const,
    };
    const everyday = consideredConversationWordLimits(plan, "everyday");
    const technical = consideredConversationWordLimits(plan, "technical");
    const fandom = consideredConversationWordLimits(plan, "fandom");
    const studio = consideredConversationWordLimits(plan, "studio");

    for (const limits of [everyday, technical, fandom, studio]) {
      expect(limits.lead.maximum).toBeLessThanOrEqual(plan.lead.style.hardMaxWords);
      expect(limits.response.maximum).toBeLessThanOrEqual(plan.responder.style.hardMaxWords);
      expect(limits.lead.minimum).toBeLessThanOrEqual(limits.lead.maximum);
    }
    expect(everyday.lead.maximum).toBeLessThan(technical.lead.maximum);
    expect(everyday.lead.maximum).toBeLessThan(fandom.lead.maximum);
    expect(studio.lead.maximum).toBe(plan.lead.style.hardMaxWords);
  });

  it("does not recruit a relevant resident who is still cooling down", () => {
    const now = 2_000_000;
    const candidates = PERSONAS.filter((persona) => ["ai-sana", "ai-vale", "ai-mira"].includes(persona.id));
    const plan = selectConsideredConversation(
      candidates,
      new Map([["ai-vale", now - 1_000]]),
      now,
      (id) => (id === "ai-sana" ? 0.95 : id === "ai-vale" ? 0.8 : 0.7),
      () => 0,
    );

    expect(plan?.lead.id).toBe("ai-sana");
    expect(plan?.responder.id).toBe("ai-mira");
    expect(plan?.responseRole).toBe("question");
  });

  it("rejects exact channel duplicates and high-severity repetition of the same persona", () => {
    const exactPeerHistory = [
      { channelId: "ai-programming", authorId: "ai-vale", content: "samma lilla tanke" },
    ];
    expect(shouldRejectPublicCandidate({
      channelId: "ai-programming",
      personaId: "ai-sana",
      content: "Samma lilla tanke!",
      history: exactPeerHistory,
    })).toBe(true);

    const ownHistory = [
      {
        channelId: "ai-programming",
        authorId: "ai-sana",
        content: "Jag tror faktiskt att en liten TURN-server löser det här för de flesta användare.",
      },
    ];
    expect(shouldRejectPublicCandidate({
      channelId: "ai-programming",
      personaId: "ai-sana",
      content: "Jag tror faktiskt att en liten TURN-server löser nog det här för de flesta användare.",
      history: ownHistory,
    })).toBe(true);
  });

  it("allows medium self-similarity and near repetition of a peer", () => {
    const prior = "Jag tror faktiskt att en liten TURN-server löser det här för de flesta användare.";
    expect(shouldRejectPublicCandidate({
      channelId: "ai-programming",
      personaId: "ai-sana",
      content: "En liten TURN-server löser nog det här för de flesta användare.",
      history: [{ channelId: "ai-programming", authorId: "ai-sana", content: prior }],
    })).toBe(false);

    expect(shouldRejectPublicCandidate({
      channelId: "ai-programming",
      personaId: "ai-sana",
      content: "Jag tror faktiskt att en liten TURN-server löser nog det här för de flesta användare.",
      history: [{ channelId: "ai-programming", authorId: "ai-vale", content: prior }],
    })).toBe(false);
  });

  it("keeps short natural replies and shared technical vocabulary publishable", () => {
    expect(shouldRejectPublicCandidate({
      channelId: "lobby",
      personaId: "ai-mira",
      content: "haha ja exakt",
      history: [{ channelId: "lobby", authorId: "ai-mira", content: "haha exakt" }],
    })).toBe(false);

    expect(shouldRejectPublicCandidate({
      channelId: "ai-programming",
      personaId: "ai-sana",
      content: "WebRTC behöver ofta TURN bakom restriktiv NAT, medan ngrok bara bär signaleringen.",
      history: [
        {
          channelId: "ai-programming",
          authorId: "ai-sana",
          content: "WebRTC använder ICE-kandidater för att hitta en fungerande väg mellan webbläsarna.",
        },
        {
          channelId: "ai-programming",
          authorId: "ai-sana",
          content: "En TURN-server reläar media när direkt P2P blockeras av nätet.",
        },
      ],
    })).toBe(false);
  });

  it("preserves technical fragments and intentional line breaks through publication cleanup", () => {
    const input = "Testa i den här ordningen:\n1. Kör `npm test`\n2. Läs https://example.com/docs.\n```ts\nconst x = 1;\n```";
    expect(normalizeGeneratedMessageContent(input)).toBe(input);
  });

  it("removes standalone model-written source tokens in common punctuation forms", () => {
    const cleaned = normalizeGeneratedMessageContent("[S1]: svar\n[S2]; mer\n[S3]-slut\n`[S4]` kod");
    expect(cleaned).not.toMatch(/\[S\d+\]/u);
    expect(cleaned).toContain("svar");
    expect(cleaned).toContain("mer");
    expect(normalizeGeneratedMessageContent("Läs https://example.com/[S1]/docs")).toContain("https://example.com/[S1]/docs");
  });

  it("rejects an overlong generated message atomically instead of cutting a URL", () => {
    const longUrl = `https://example.com/${"a".repeat(520)}`;
    expect(normalizeGeneratedMessageContent(`läs ${longUrl}`)).toBeUndefined();
  });
});
