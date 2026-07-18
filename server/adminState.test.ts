import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminChannelConfig, AdminPersonaConfig } from "../shared/adminTypes.js";
import { CHANNEL_PROFILES, CHANNELS } from "./channels.js";
import { AdminStateError, AdminStateStore } from "./adminState.js";
import { PERSONAS, isActiveResidentActorId } from "./personas.js";
import { participantIdentityKey } from "./participantIdentity.js";

const pathFor = () => `/tmp/the-third-place-admin-${randomUUID()}.json`;
const makeStore = (persist: (state: unknown) => Promise<void> = async () => undefined) =>
  new AdminStateStore({
    path: pathFor(),
    persist,
    voiceOptions: {
      languages: ["sv", "en"],
      voices: [
        { id: "lisa-warm", label: "Lisa warm", languages: ["sv"] },
        { id: "alloy", label: "Alloy", languages: ["en"] },
      ],
    },
  });

const resetCatalog = async () => {
  const store = makeStore();
  await store.load();
};

afterEach(async () => {
  await resetCatalog();
});

const customPersona = (channels: readonly string[]): AdminPersonaConfig => ({
  id: "ai-test-resident",
  name: "Test Resident",
  role: "Resident · test",
  bio: "A bounded custom resident used by the admin-state tests.",
  prompt: "Respond as a concise peer with one concrete point and no generic assistant framing.",
  core: {
    talkativeness: 61,
    warmth: 72,
    curiosity: 83,
    mischief: 22,
    conscientiousness: 77,
    disagreement: 48,
  },
  canResearch: true,
  fictionalAdult: false,
  roomAffinities: Object.fromEntries(channels.slice(0, 2).map((id, index) => [id, 70 - index * 10])),
  voices: { sv: "lisa-warm", en: "alloy" },
});

const customChannel = (): AdminChannelConfig => ({
  id: "test-room",
  name: "test-room",
  description: "A bounded custom room for catalog tests.",
  icon: "T",
  topic: "testing live catalog updates and runtime reconciliation",
  guidance: "Use concrete test failures and short peer replies instead of abstract process talk.",
  register: "technical",
  mode: "discussion",
  seeds: [
    "A test that passes only when watched is measuring theatre; name the first hidden dependency to inspect.",
    "A flaky failure can reveal a real race; pick one observable timestamp that would distinguish it from bad randomness.",
  ],
});

describe("persistent admin overlay state", () => {
  it("starts neutral relative to runtime defaults and materializes safe live catalog CRUD", async () => {
    const store = makeStore();
    await store.load();
    const initial = store.snapshot();
    expect(initial.behavior.global).toEqual({
      activity: 50,
      autonomousLinkFrequency: 60,
      competence: 50,
      aggression: 25,
      explicitness: 50,
    });
    expect(initial.behavior.channels).toEqual({});
    expect(initial.automation.autonomousLinkChannelIds).toContain("the-pub");
    expect(initial.automation.autonomousLinkChannelIds).toContain("football-talk");
    expect(initial.automation.autonomousLinkChannelIds).toContain("ai-hacking");
    expect(initial.channels.some((channel) => channel.id === "lobby")).toBe(true);
    expect(initial.personas.every((persona) => persona.fictionalAdult)).toBe(true);
    expect(store.isRomanceEligibleResident("ai-mira")).toBe(true);
    expect(initial.channels.find((channel) => channel.id === "ai-hacking")).toMatchObject({
      name: "ai-hacking",
      register: "technical",
      mode: "discussion",
      seeds: expect.arrayContaining([expect.stringContaining("Metasploit module")]),
    });
    expect(initial.channels.find((channel) => channel.id === "football-talk")).toMatchObject({
      name: "football-talk",
      register: "banter",
      mode: "banter",
      seeds: expect.arrayContaining([expect.stringContaining("pressing trigger")]),
    });

    await store.createChannel(customChannel());
    await store.createPersona(customPersona(CHANNELS.map((channel) => channel.id)));
    expect(store.isRomanceEligibleResident("ai-test-resident")).toBe(false);
    expect(isActiveResidentActorId("ai-test-resident")).toBe(true);
    expect(CHANNELS.some((channel) => channel.id === "test-room")).toBe(true);
    expect(PERSONAS.find((persona) => persona.id === "ai-test-resident")).toMatchObject({
      name: "Test Resident",
      canResearch: true,
      talkativeness: 0.61,
      channelAffinity: expect.objectContaining({ lobby: 0.7 }),
    });
    expect(store.snapshot().personas.find((persona) => persona.id === "ai-test-resident")?.voices).toEqual({
      sv: "lisa-warm",
      en: "alloy",
    });

    const custom = store.snapshot().personas.find((persona) => persona.id === "ai-test-resident")!;
    await store.updatePersona(custom.id, { ...custom, fictionalAdult: true });
    expect(store.isRomanceEligibleResident("ai-test-resident")).toBe(true);

    await store.deletePersona("ai-test-resident");
    await store.deleteChannel("test-room");
    expect(isActiveResidentActorId("ai-test-resident")).toBe(false);
    expect(store.isRomanceEligibleResident("ai-test-resident")).toBe(false);
    expect(PERSONAS.some((persona) => persona.id === "ai-test-resident")).toBe(false);
    expect(CHANNELS.some((channel) => channel.id === "test-room")).toBe(false);
  });

  it("soft-disables and re-enables an upgraded built-in without deleting its base definition", async () => {
    const store = makeStore();
    await store.load();
    const original = store.snapshot().personas.find((persona) => persona.id === "ai-mira")!;
    await store.deletePersona("ai-mira");
    expect(PERSONAS.some((persona) => persona.id === "ai-mira")).toBe(false);
    await store.createPersona({ ...original, name: "Mira Live" });
    expect(PERSONAS.find((persona) => persona.id === "ai-mira")?.name).toBe("Mira Live");
    expect(PERSONAS.find((persona) => persona.id === "ai-mira")?.style).toBeDefined();
  });

  it("clears stale index-aligned premise families when an admin replaces seeds", async () => {
    const store = makeStore();
    await store.load();
    const current = store.snapshot().channels.find((channel) => channel.id === "ai-lab")!;
    expect(CHANNEL_PROFILES.find((profile) => profile.public.id === "ai-lab")?.ambientPremiseFamilies?.length).toBeGreaterThan(0);
    await store.updateChannel("ai-lab", {
      ...current,
      seeds: ["A replacement seed must not inherit a semantic family from the old list."],
    });
    const runtime = CHANNEL_PROFILES.find((profile) => profile.public.id === "ai-lab")!;
    expect(runtime.ambientPremises).toEqual(["A replacement seed must not inherit a semantic family from the old list."]);
    expect(runtime.ambientPremiseFamilies).toBeUndefined();
  });

  it("marks a room's link-frequency control unavailable when its trusted research topic is replaced", async () => {
    const store = makeStore();
    await store.load();
    const current = store.snapshot().channels.find((channel) => channel.id === "ai-lab")!;
    await store.updateChannel("ai-lab", {
      ...current,
      topic: "a completely replaced administrator-authored room topic",
    });
    expect(CHANNEL_PROFILES.find((profile) => profile.public.id === "ai-lab")?.autonomousResearchSeeds)
      .toBeUndefined();
    expect(store.snapshot().automation.autonomousLinkChannelIds).not.toContain("ai-lab");
  });

  it("drops a built-in research priority when an admin replaces that room's trusted topic", async () => {
    const store = makeStore();
    await store.load();
    const current = store.snapshot().channels.find((channel) => channel.id === "stock-market")!;
    expect(CHANNEL_PROFILES.find((profile) => profile.public.id === "stock-market")?.autonomousResearchPriority)
      .toBeGreaterThan(1);
    await store.updateChannel("stock-market", {
      ...current,
      topic: "a completely different administrator-authored room topic",
    });
    expect(CHANNEL_PROFILES.find((profile) => profile.public.id === "stock-market")?.autonomousResearchPriority)
      .toBeUndefined();
    expect(CHANNEL_PROFILES.find((profile) => profile.public.id === "stock-market")?.marketPulseSourceSet)
      .toBeUndefined();
  });

  it("exposes football controls, preserves room tuning and retires topic-bound automation safely", async () => {
    const store = makeStore();
    await store.load();
    const footballConfig = store.snapshot().channels.find((channel) => channel.id === "football-talk")!;
    const footballProfile = CHANNEL_PROFILES.find((profile) => profile.public.id === "football-talk")!;

    expect(footballConfig.seeds).toHaveLength(40);
    expect(footballProfile.autonomousResearchSeeds).toHaveLength(8);
    expect(footballProfile.autonomousResearchPriority).toBeGreaterThan(1);
    expect(footballProfile.ambientActivityPriority).toBeGreaterThan(1);

    const tuning = {
      activity: 92,
      autonomousLinkFrequency: 88,
      competence: 94,
      aggression: 72,
      explicitness: 55,
    };
    await store.updateBehavior({ scope: "channel", channelId: "football-talk", tuning });
    expect(store.snapshot().behavior.channels["football-talk"]).toEqual(tuning);
    expect(store.behaviorForChannel("football-talk").channel).toEqual(tuning);

    await store.updateChannel("football-talk", {
      ...footballConfig,
      topic: "a completely unrelated administrator-authored room topic",
    });
    const replaced = CHANNEL_PROFILES.find((profile) => profile.public.id === "football-talk")!;
    expect(replaced.autonomousResearchSeeds).toBeUndefined();
    expect(replaced.autonomousResearchPriority).toBeUndefined();
    expect(replaced.ambientActivityPriority).toBeUndefined();
    expect(store.snapshot().automation.autonomousLinkChannelIds).not.toContain("football-talk");
    expect(store.behaviorForChannel("football-talk").channel).toEqual(tuning);
  });

  it("rolls runtime arrays back when atomic persistence fails", async () => {
    const persist = vi.fn(async () => { throw new Error("disk unavailable"); });
    const store = makeStore(persist);
    await store.load();
    const original = store.snapshot().personas.find((persona) => persona.id === "ai-mira")!;
    await expect(store.updatePersona("ai-mira", { ...original, name: "Must Roll Back" })).rejects.toThrow("disk unavailable");
    expect(PERSONAS.find((persona) => persona.id === "ai-mira")?.name).toBe(original.name);
    expect(store.snapshot().revision).toBe("0");
  });

  it("does not expose a candidate runtime catalog while a failing write is pending", async () => {
    let enteredWrite!: () => void;
    let failWrite!: (error: Error) => void;
    const writeEntered = new Promise<void>((resolve) => { enteredWrite = resolve; });
    const pendingWrite = new Promise<void>((_resolve, reject) => { failWrite = reject; });
    const store = makeStore(async () => {
      enteredWrite();
      await pendingWrite;
    });
    await store.load();
    const original = store.snapshot().personas.find((persona) => persona.id === "ai-mira")!;
    const mutation = store.updatePersona("ai-mira", { ...original, name: "Pending Rename" });
    const rejection = expect(mutation).rejects.toThrow("disk unavailable");
    await writeEntered;

    expect(PERSONAS.find((persona) => persona.id === "ai-mira")?.name).toBe(original.name);
    expect(store.snapshot().revision).toBe("0");
    failWrite(new Error("disk unavailable"));
    await rejection;
    expect(PERSONAS.find((persona) => persona.id === "ai-mira")?.name).toBe(original.name);
  });

  it("revalidates human name reservations after disk I/O and compensates the file before exposing runtime", async () => {
    let enteredWrite!: () => void;
    let releaseWrite!: () => void;
    const writeEntered = new Promise<void>((resolve) => { enteredWrite = resolve; });
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const revisions: number[] = [];
    let firstWrite = true;
    const store = makeStore(async (raw) => {
      revisions.push((raw as { revision: number }).revision);
      if (!firstWrite) return;
      firstWrite = false;
      enteredWrite();
      await writeGate;
    });
    await store.load();
    const original = store.snapshot().personas.find((persona) => persona.id === "ai-mira")!;
    let humanReservedTarget = false;
    store.setHooks({
      validatePersonaNames: (personas) => {
        if (
          humanReservedTarget &&
          personas.some((persona) => participantIdentityKey(persona.name) === participantIdentityKey("Human Target"))
        ) {
          throw new AdminStateError(409, "PERSONA_NAME_RESERVED", "human joined during persistence");
        }
      },
    });

    const mutation = store.updatePersona("ai-mira", { ...original, name: "Human Target" });
    const rejection = expect(mutation).rejects.toMatchObject({ code: "PERSONA_NAME_RESERVED", status: 409 });
    await writeEntered;
    expect(PERSONAS.find((persona) => persona.id === "ai-mira")?.name).toBe(original.name);
    humanReservedTarget = true;
    releaseWrite();
    await rejection;

    expect(revisions).toEqual([1, 0]);
    expect(PERSONAS.find((persona) => persona.id === "ai-mira")?.name).toBe(original.name);
    expect(store.snapshot().revision).toBe("0");
  });

  it("serializes mutations and persists monotonically increasing revisions", async () => {
    const revisions: number[] = [];
    const store = makeStore(async (raw) => {
      const revision = (raw as { revision: number }).revision;
      await Promise.resolve();
      revisions.push(revision);
    });
    await store.load();
    const first = store.updateBehavior({
      scope: "global",
      tuning: { activity: 60, competence: 55, aggression: 30, explicitness: 50 },
    });
    const second = store.updateBehavior({
      scope: "channel",
      channelId: "lobby",
      tuning: { activity: 35, competence: 50, aggression: 20, explicitness: 40 },
    });
    await Promise.all([first, second]);
    expect(revisions).toEqual([1, 2]);
    expect(store.snapshot().revision).toBe("2");
    expect(store.behaviorTuning("lobby").activity).toBe(35);
  });

  it("reports only explicit room overrides and can restore global inheritance", async () => {
    const store = makeStore();
    await store.load();
    await store.updateBehavior({
      scope: "channel",
      channelId: "lobby",
      tuning: { activity: 35, competence: 61, aggression: 19, explicitness: 42 },
    });
    expect(store.snapshot().behavior.channels).toEqual({
      lobby: { activity: 35, autonomousLinkFrequency: 60, competence: 61, aggression: 19, explicitness: 42 },
    });

    await store.updateBehavior({ scope: "channel", channelId: "lobby", tuning: null });
    await store.updateBehavior({
      scope: "global",
      tuning: { activity: 72, competence: 64, aggression: 31, explicitness: 58 },
    });
    expect(store.snapshot().behavior.channels).toEqual({});
    expect(store.behaviorTuning("lobby")).toEqual({
      activity: 72,
      autonomousLinkFrequency: 60,
      competence: 64,
      aggression: 31,
      explicitness: 58,
    });
  });

  it("migrates persisted v1 behavior and keeps autonomous-link settings live and inheritable", async () => {
    const path = pathFor();
    try {
      const original = new AdminStateStore({ path });
      await original.load();
      const currentPub = original.snapshot().channels.find((channel) => channel.id === "the-pub")!;
      await original.updateChannel("the-pub", { ...currentPub, icon: "P" });
      await original.updateBehavior({
        scope: "channel",
        channelId: "the-pub",
        tuning: { activity: 55, competence: 60, aggression: 30, explicitness: 65 },
      });
      const legacy = JSON.parse(await readFile(path, "utf8")) as {
        version: number;
        behavior: {
          global: Record<string, unknown>;
          channels: Record<string, Record<string, unknown>>;
        };
        channelOverrides: Record<string, Record<string, unknown>>;
      };
      legacy.version = 1;
      legacy.channelOverrides["the-pub"]!.topic =
        "a relaxed Friday hangout for films, music, work gripes, politics, food, links, memes and everyday nonsense";
      delete legacy.behavior.global.autonomousLinkFrequency;
      for (const tuning of Object.values(legacy.behavior.channels)) {
        delete tuning.autonomousLinkFrequency;
      }
      await writeFile(path, JSON.stringify(legacy), "utf8");

      const migrated = new AdminStateStore({ path });
      await migrated.load();
      expect(migrated.behaviorTuning().autonomousLinkFrequency).toBe(60);
      expect(migrated.behaviorTuning("the-pub").autonomousLinkFrequency).toBe(60);
      expect(migrated.snapshot().channels.find((channel) => channel.id === "the-pub")?.topic)
        .toContain("brewing craft");
      expect(migrated.snapshot().automation.autonomousLinkChannelIds).toContain("the-pub");

      await migrated.updateBehavior({
        scope: "global",
        tuning: {
          ...migrated.behaviorTuning(),
          autonomousLinkFrequency: 75,
        },
      });
      await migrated.updateBehavior({
        scope: "global",
        tuning: { activity: 58, competence: 57, aggression: 31, explicitness: 62 },
      });
      expect(migrated.behaviorTuning().autonomousLinkFrequency).toBe(75);
      await migrated.updateBehavior({
        scope: "channel",
        channelId: "the-pub",
        tuning: {
          ...migrated.behaviorTuning("the-pub"),
          autonomousLinkFrequency: 0,
        },
      });
      await migrated.updateBehavior({
        scope: "channel",
        channelId: "the-pub",
        tuning: { activity: 52, competence: 59, aggression: 32, explicitness: 64 },
      });
      expect(migrated.behaviorTuning("the-pub").autonomousLinkFrequency).toBe(0);
      await migrated.updateBehavior({ scope: "channel", channelId: "the-pub", tuning: null });
      expect(migrated.behaviorTuning("the-pub").autonomousLinkFrequency).toBe(75);
    } finally {
      await rm(path, { force: true });
    }
  });

  it("migrates legacy resident adulthood fail-closed for custom actors and preserves built-ins", async () => {
    const path = pathFor();
    try {
      const original = new AdminStateStore({ path });
      await original.load();
      const mira = original.snapshot().personas.find((persona) => persona.id === "ai-mira")!;
      await original.updatePersona(mira.id, { ...mira, name: "Mira Migrated" });
      await original.createPersona({
        ...customPersona(["lobby"]),
        fictionalAdult: true,
        voices: {},
      });

      const legacy = JSON.parse(await readFile(path, "utf8")) as {
        version: number;
        personaOverrides: Record<string, Record<string, unknown>>;
        customPersonas: Array<Record<string, unknown>>;
      };
      legacy.version = 2;
      delete legacy.personaOverrides["ai-mira"]!.fictionalAdult;
      delete legacy.customPersonas[0]!.fictionalAdult;
      await writeFile(path, JSON.stringify(legacy), "utf8");

      const migrated = new AdminStateStore({ path });
      await migrated.load();
      expect(migrated.isRomanceEligibleResident("ai-mira")).toBe(true);
      expect(migrated.isRomanceEligibleResident("ai-test-resident")).toBe(false);
      expect(migrated.snapshot().personas.find((persona) => persona.id === "ai-mira")?.fictionalAdult).toBe(true);
      expect(migrated.snapshot().personas.find((persona) => persona.id === "ai-test-resident")?.fictionalAdult).toBe(false);
      expect(migrated.isRomanceEligibleResident("ai-unknown")).toBe(false);
    } finally {
      await rm(path, { force: true });
    }
  });

  it("reconciles and announces the live catalog only for catalog mutations", async () => {
    const store = makeStore();
    await store.load();
    const reconcileCatalog = vi.fn();
    const commits: boolean[] = [];
    store.setHooks({
      reconcileCatalog,
      onCommitted: (_snapshot, catalogChanged) => commits.push(catalogChanged),
    });

    await store.updateBehavior({
      scope: "global",
      tuning: { activity: 58, competence: 51, aggression: 26, explicitness: 47 },
    });
    expect(reconcileCatalog).not.toHaveBeenCalled();
    expect(commits).toEqual([false]);

    await store.createChannel(customChannel());
    expect(reconcileCatalog).toHaveBeenCalledTimes(1);
    expect(commits).toEqual([false, true]);
    await store.deleteChannel("test-room");
  });

  it("strictly bounds tuning, language voices, identity and protected catalog invariants", async () => {
    const store = makeStore();
    await store.load();
    await expect(store.updateBehavior({
      scope: "global",
      tuning: { activity: 101, competence: 50, aggression: 25, explicitness: 50 },
    })).rejects.toThrow();
    await expect(store.createPersona({ ...customPersona(["lobby"]), voices: { en: "provider-secret-voice" } }))
      .rejects.toMatchObject({ code: "INVALID_VOICE" });
    await expect(store.deleteChannel("lobby")).rejects.toMatchObject({ code: "LOBBY_REQUIRED", status: 409 });
  });

  it("loads persisted configured voice mappings while the live TTS provider is unavailable", async () => {
    const path = pathFor();
    try {
      const online = new AdminStateStore({
        path,
        configuredVoiceIds: ["lisa-warm", "alloy"],
        voiceOptions: {
          languages: ["sv", "en"],
          voices: [
            { id: "lisa-warm", label: "Lisa warm", languages: ["sv"] },
            { id: "alloy", label: "Alloy", languages: ["en"] },
          ],
        },
      });
      await online.load();
      await online.createPersona(customPersona(["lobby"]));

      const restartedWhileOffline = new AdminStateStore({
        path,
        configuredVoiceIds: ["lisa-warm", "alloy"],
        voiceOptions: { languages: [], voices: [] },
      });
      await expect(restartedWhileOffline.load()).resolves.toBeUndefined();
      expect(restartedWhileOffline.snapshot().personas.find((persona) => persona.id === "ai-test-resident")?.voices)
        .toEqual({ sv: "lisa-warm", en: "alloy" });
    } finally {
      await rm(path, { force: true });
    }
  });

  it("persists bans by member/name identity without storing network addresses or deleting catalog/history state", async () => {
    let persisted: unknown;
    const store = makeStore(async (state) => { persisted = state; });
    await store.load();
    await store.addBan({
      memberId: "human-1",
      name: "Alex",
      reason: "Repeated harassment",
      bannedAt: "2026-07-14T12:00:00.000Z",
    });
    expect(store.isBanned("human-1", "Different name")).toBe(true);
    expect(store.isBanned(undefined, "alex")).toBe(true);
    expect(JSON.stringify(persisted)).not.toMatch(/ip|address|socket/iu);
    expect(store.snapshot().channels.length).toBeGreaterThan(0);
    await store.removeBan("human-1");
    expect(store.isBanned("human-1", "Alex")).toBe(false);
  });

  it("surfaces hook conflicts as 409 and leaves the active runtime untouched", async () => {
    const store = makeStore();
    await store.load();
    store.setHooks({
      validateChannelIds: (ids) => {
        if (!ids.includes("side-quests")) throw new AdminStateError(409, "CHANNEL_IN_USE", "voice active");
      },
    });
    await expect(store.deleteChannel("side-quests")).rejects.toMatchObject({ status: 409, code: "CHANNEL_IN_USE" });
    expect(CHANNELS.some((channel) => channel.id === "side-quests")).toBe(true);
  });

  it("refuses to re-enable a resident whose name was reserved by a human while disabled", async () => {
    const store = makeStore();
    await store.load();
    const mira = store.snapshot().personas.find((persona) => persona.id === "ai-mira")!;
    await store.deletePersona(mira.id);
    store.setHooks({
      validatePersonaNames: (personas) => {
        if (personas.some((persona) => participantIdentityKey(persona.name) === participantIdentityKey("Mi_ra"))) {
          throw new AdminStateError(409, "PERSONA_NAME_RESERVED", "human name collision");
        }
      },
    });

    await expect(store.createPersona(mira)).rejects.toMatchObject({
      status: 409,
      code: "PERSONA_NAME_RESERVED",
    });
    expect(PERSONAS.some((persona) => persona.id === mira.id)).toBe(false);
  });

  it("fails startup revalidation when restored human memory conflicts with the active catalog", async () => {
    const store = makeStore();
    await store.load();
    store.setHooks({
      validatePersonaNames: (personas) => {
        if (personas.some((persona) => participantIdentityKey(persona.name) === participantIdentityKey("Mira"))) {
          throw new AdminStateError(409, "PERSONA_NAME_RESERVED", "restored human collision");
        }
      },
    });
    expect(() => store.validateActiveCatalog()).toThrowError(expect.objectContaining({
      code: "PERSONA_NAME_RESERVED",
      status: 409,
    }));
  });
});
