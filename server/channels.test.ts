import { describe, expect, it } from "vitest";
import {
  CHANNEL_PROFILES,
  CHANNELS,
  CONVERSATION_REGISTERS,
  defineAmbientPremiseCatalog,
  ROOM_SOCIAL_MOVES,
  scheduledRoomSocialModeAt,
  type ChannelProfile,
} from "./channels.js";
import { PERSONAS, type Persona } from "./personas.js";
import { buildRoomExpertiseMatrix, EXPERTISE_RANK } from "./roomExpertise.js";

const NEW_ROOM_IDS = [
  "the-pub",
  "ai-programming",
  "ai-hacking",
  "stock-market",
  "football-talk",
  "world-of-warcraft",
  "fnaf",
  "3d-visualisation",
];
const RESEARCH_ROOM_IDS = [
  "lobby",
  "the-pub",
  "ai-programming",
  "ai-hacking",
  "stock-market",
  "football-talk",
  "world-of-warcraft",
  "fnaf",
  "3d-visualisation",
];
const EXPECTED_AMBIENT_COUNTS: Record<string, number> = {
  lobby: 32,
  "the-pub": 40,
  "ai-programming": 40,
  "ai-hacking": 40,
  "stock-market": 32,
  "football-talk": 40,
  "world-of-warcraft": 32,
  fnaf: 40,
  "3d-visualisation": 32,
};
const EXPECTED_AMBIENT_FAMILY_COUNTS: Record<string, number> = {
  lobby: 9,
  "the-pub": 12,
  "ai-programming": 15,
  "ai-hacking": 10,
  "stock-market": 8,
  "football-talk": 10,
  "world-of-warcraft": 8,
  fnaf: 10,
  "3d-visualisation": 8,
};

const normalizedContentKey = (value: string): string => value.normalize("NFKC").trim().toLocaleLowerCase("und");

describe("channel profiles", () => {
  it("defines a single scalable profile for every public room", () => {
    const ids = CHANNEL_PROFILES.map((profile) => profile.public.id);
    const personaIds = new Set(PERSONAS.map((persona) => persona.id));
    expect(ids).toHaveLength(9);
    expect(ids).not.toEqual(expect.arrayContaining(["ai-lab", "side-quests"]));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(NEW_ROOM_IDS));
    expect(CHANNELS.map((channel) => channel.id)).toEqual(ids);
    for (const profile of CHANNEL_PROFILES) {
      expect(profile.topic.brief.length).toBeGreaterThan(20);
      expect(profile.topic.tags.length).toBeGreaterThan(2);
      expect(profile.ambientPremises, profile.public.id).toHaveLength(EXPECTED_AMBIENT_COUNTS[profile.public.id]);
      expect(new Set(profile.ambientPremises.map(normalizedContentKey)).size).toBe(profile.ambientPremises.length);
      expect(profile.ambientPremiseFamilies, profile.public.id).toBeDefined();
      const premiseFamilies = profile.ambientPremiseFamilies!;
      expect(premiseFamilies, profile.public.id).toHaveLength(profile.ambientPremises.length);
      expect(premiseFamilies.every((family) => /^[a-z0-9-]{3,48}$/.test(family)), profile.public.id).toBe(true);
      const familyCounts = new Map<string, number>();
      for (const family of premiseFamilies) {
        familyCounts.set(family, (familyCounts.get(family) ?? 0) + 1);
      }
      expect(familyCounts.size, profile.public.id).toBe(
        EXPECTED_AMBIENT_FAMILY_COUNTS[profile.public.id],
      );
      expect(Math.max(...familyCounts.values()), profile.public.id).toBeLessThanOrEqual(4);
      if (profile.autonomousResearchPriority !== undefined) {
        expect(profile.autonomousResearchPriority, profile.public.id).toBeGreaterThanOrEqual(0.25);
        expect(profile.autonomousResearchPriority, profile.public.id).toBeLessThanOrEqual(4);
      }
      if (profile.ambientActivityPriority !== undefined) {
        expect(profile.ambientActivityPriority, profile.public.id).toBeGreaterThanOrEqual(0.25);
        expect(profile.ambientActivityPriority, profile.public.id).toBeLessThanOrEqual(4);
      }
      for (const mode of profile.scheduledSocialModes ?? []) {
        expect(mode.id, profile.public.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
        expect(mode.startWeekdays.length, mode.id).toBeGreaterThan(0);
        expect(new Set(mode.startWeekdays).size, mode.id).toBe(mode.startWeekdays.length);
        expect(mode.startHour, mode.id).toBeGreaterThanOrEqual(0);
        expect(mode.startHour, mode.id).toBeLessThanOrEqual(23);
        expect(mode.endHour, mode.id).toBeGreaterThanOrEqual(0);
        expect(mode.endHour, mode.id).toBeLessThanOrEqual(23);
        expect(mode.activationRate, mode.id).toBeGreaterThan(0);
        expect(mode.activationRate, mode.id).toBeLessThanOrEqual(1);
        expect(mode.moves.length, mode.id).toBeGreaterThan(0);
        expect(new Set(mode.moves).size, mode.id).toBe(mode.moves.length);
        expect(mode.moves.every((move) => ROOM_SOCIAL_MOVES.includes(move)), mode.id).toBe(true);
        expect(mode.guidance.length, mode.id).toBeGreaterThan(80);
      }
      expect(CONVERSATION_REGISTERS[profile.conversationRegister].guidance.length).toBeGreaterThan(40);
      expect(Object.keys(profile.expertiseOverrides ?? {}).every((personaId) => personaIds.has(personaId))).toBe(true);
    }
    const allPremises = CHANNEL_PROFILES.flatMap((profile) => profile.ambientPremises.map(normalizedContentKey));
    expect(allPremises).toHaveLength(328);
    expect(new Set(allPremises).size).toBe(allPremises.length);
  });

  it("projects atomic ambient catalogue entries without losing their association", () => {
    const catalogue = defineAmbientPremiseCatalog([
      ["first-family", "First premise"],
      ["second-family", "Second premise"],
    ]);

    expect(catalogue).toEqual({
      ambientPremiseFamilies: ["first-family", "second-family"],
      ambientPremises: ["First premise", "Second premise"],
    });
  });

  it("defines bounded, stable and non-repeating autonomous research starters", () => {
    const allIds: string[] = [];
    const allQueries: string[] = [];
    for (const profile of CHANNEL_PROFILES) {
      const seeds = profile.autonomousResearchSeeds ?? [];
      if (RESEARCH_ROOM_IDS.includes(profile.public.id)) {
        expect(seeds, profile.public.id).toHaveLength(profile.public.id === "ai-programming" ? 16 : 8);
      }
      for (const seed of seeds) {
        expect(seed.id, profile.public.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
        expect(seed.id.length, profile.public.id).toBeLessThanOrEqual(80);
        expect(seed.query.length, seed.id).toBeGreaterThanOrEqual(12);
        expect(seed.query.length, seed.id).toBeLessThanOrEqual(140);
        expect(seed.query, seed.id).not.toMatch(/https?:\/\//u);
        expect(["web", "news"], seed.id).toContain(seed.mode);
        if (seed.mode === "news") expect(seed.maxAgeDays, seed.id).toBeDefined();
        if (seed.maxAgeDays !== undefined) {
          expect(Number.isInteger(seed.maxAgeDays), seed.id).toBe(true);
          expect(seed.maxAgeDays, seed.id).toBeGreaterThanOrEqual(1);
          expect(seed.maxAgeDays, seed.id).toBeLessThanOrEqual(365);
        }
        expect(seed.discussionAngle.length, seed.id).toBeGreaterThanOrEqual(30);
        expect(seed.discussionAngle.length, seed.id).toBeLessThanOrEqual(280);
        allIds.push(seed.id);
        allQueries.push(normalizedContentKey(seed.query));
      }
    }
    expect(new Set(allIds).size).toBe(allIds.length);
    expect(new Set(allQueries).size).toBe(allQueries.length);
    expect(CHANNEL_PROFILES.find((profile) => profile.public.id === "stock-market")?.autonomousResearchPriority)
      .toBeGreaterThan(1);
    expect(CHANNEL_PROFILES.find((profile) => profile.public.id === "stock-market")?.marketPulseSourceSet)
      .toBe("global_markets");
    expect(CHANNEL_PROFILES.filter((profile) => profile.marketPulseSourceSet)).toHaveLength(1);
    const pubSeedIds = CHANNEL_PROFILES.find((profile) => profile.public.id === "the-pub")!
      .autonomousResearchSeeds!.map((seed) => seed.id);
    expect(pubSeedIds).toEqual(expect.arrayContaining([
      "pub-new-music-releases",
      "pub-film-festival-reaction",
      "pub-limited-beer-release",
      "pub-distinctive-pub",
    ]));
  });

  it("keeps internal expertise and freshness rules out of public channel objects", () => {
    for (const channel of CHANNELS) {
      expect(channel).not.toHaveProperty("topic");
      expect(channel).not.toHaveProperty("expertiseOverrides");
      expect(channel).not.toHaveProperty("ambientPremises");
      expect(channel).not.toHaveProperty("autonomousResearchSeeds");
      expect(channel).not.toHaveProperty("conversationGuidance");
      expect(channel).not.toHaveProperty("conversationRegister");
      expect(channel).not.toHaveProperty("ambientMode");
    }
  });

  it("uses casual pacing for social rooms while preserving technical and analytical registers", () => {
    const profile = (id: string) => CHANNEL_PROFILES.find((entry) => entry.public.id === id)!;

    expect(profile("lobby")).toMatchObject({ ambientMode: "casual", conversationRegister: "everyday" });
    expect(profile("the-pub")).toMatchObject({ ambientMode: "banter", conversationRegister: "banter" });
    expect(profile("football-talk")).toMatchObject({ ambientMode: "banter", conversationRegister: "banter" });
    expect(profile("world-of-warcraft")).toMatchObject({ ambientMode: "casual", conversationRegister: "fandom" });
    expect(profile("fnaf")).toMatchObject({ ambientMode: "casual", conversationRegister: "fandom" });
    expect(profile("ai-programming").conversationRegister).toBe("technical");
    expect(profile("ai-hacking").conversationRegister).toBe("technical");
    expect(profile("stock-market").conversationRegister).toBe("analytical");
    expect(profile("3d-visualisation").conversationRegister).toBe("studio");
  });

  it("gives every resident baseline knowledge while keeping experts rare", () => {
    const matrix = buildRoomExpertiseMatrix(PERSONAS);
    for (const channelId of NEW_ROOM_IDS) {
      const expertise = [...(matrix.get(channelId)?.values() ?? [])];
      expect(expertise).toHaveLength(PERSONAS.length);
      expect(expertise.every((entry) => EXPERTISE_RANK[entry.level] >= EXPERTISE_RANK.basic)).toBe(true);
      const deepExperts = expertise.filter((entry) => EXPERTISE_RANK[entry.level] >= EXPERTISE_RANK.advanced);
      const everydayResidents = expertise.filter((entry) => EXPERTISE_RANK[entry.level] <= EXPERTISE_RANK.casual);
      expect(deepExperts.length).toBeGreaterThanOrEqual(1);
      expect(deepExperts.length).toBeLessThanOrEqual(channelId === "ai-programming" ? 4 : 3);
      expect(everydayResidents.length).toBeGreaterThan(deepExperts.length * 2);
    }
  });

  it("is deterministic even if persona input order changes", () => {
    const fingerprint = (personas: typeof PERSONAS) => {
      const matrix = buildRoomExpertiseMatrix(personas);
      return CHANNELS.flatMap((channel) =>
        PERSONAS.map((persona) => `${channel.id}:${persona.id}:${matrix.get(channel.id)?.get(persona.id)?.level}`),
      ).sort();
    };
    expect(fingerprint(PERSONAS)).toEqual(fingerprint([...PERSONAS].reverse()));
  });

  it("keeps expertise routing independent of localized labels, topic copy, tags and interests", () => {
    const fingerprint = (personas: Persona[], profiles: ChannelProfile[]) => {
      const matrix = buildRoomExpertiseMatrix(personas, profiles);
      return profiles.flatMap((profile) =>
        personas.map((persona) =>
          `${profile.public.id}:${persona.id}:${matrix.get(profile.public.id)?.get(persona.id)?.level}`,
        ),
      ).sort();
    };
    const localizedPersonas: Persona[] = PERSONAS.map((persona, index) => ({
      ...persona,
      name: index % 2 === 0 ? `住人${index}` : `مقيم${index}`,
      role: index % 2 === 0 ? "常連のメンバー" : "عضو دائم",
      bio: index % 2 === 0 ? "自由に翻訳された紹介文。" : "نص تعريفي محلي حر.",
      prompt: index % 2 === 0 ? "この人物説明は日本語です。" : "وصف الشخصية بالعربية.",
      interests: index % 2 === 0 ? ["音楽", "技術"] : ["الموسيقى", "التقنية"],
    }));
    const localizedProfiles: ChannelProfile[] = CHANNEL_PROFILES.map((profile, index) => ({
      ...profile,
      public: {
        ...profile.public,
        name: index % 2 === 0 ? `部屋${index}` : `غرفة-${index}`,
        description: index % 2 === 0 ? "翻訳された部屋の説明" : "وصف الغرفة المحلي",
      },
      topic: {
        ...profile.topic,
        brief: index % 2 === 0 ? "表示用の自由な日本語トピック説明" : "وصف موضوع عربي محلي للعرض",
        tags: index % 2 === 0 ? ["ゲーム", "会話", "音楽"] : ["ألعاب", "حوار", "موسيقى"],
      },
    }));

    expect(fingerprint(localizedPersonas, localizedProfiles)).toEqual(
      fingerprint(PERSONAS, CHANNEL_PROFILES),
    );
  });

  it("anchors the intended room specialists", () => {
    const matrix = buildRoomExpertiseMatrix(PERSONAS);
    expect(matrix.get("ai-programming")?.get("ai-sana")?.level).toBe("specialist");
    expect(matrix.get("ai-hacking")?.get("ai-aya")?.level).toBe("specialist");
    expect(matrix.get("ai-hacking")?.get("ai-nox")?.level).toBe("advanced");
    expect(matrix.get("ai-hacking")?.get("ai-zed")?.level).toBe("advanced");
    expect(matrix.get("stock-market")?.get("ai-farah")?.level).toBe("specialist");
    expect(matrix.get("football-talk")?.get("ai-linnea")?.level).toBe("specialist");
    expect(matrix.get("football-talk")?.get("ai-vale")?.level).toBe("advanced");
    expect(matrix.get("football-talk")?.get("ai-ibrahim")?.level).toBe("advanced");
    expect(matrix.get("world-of-warcraft")?.get("ai-pixel")?.level).toBe("specialist");
    expect(matrix.get("fnaf")?.get("ai-pixel")?.level).toBe("specialist");
    expect(matrix.get("fnaf")?.get("ai-juno")?.level).toBe("advanced");
    expect(matrix.get("fnaf")?.get("ai-tess")?.level).toBe("advanced");
    expect(matrix.get("3d-visualisation")?.get("ai-pixel")?.level).toBe("specialist");
    expect(matrix.get("the-pub")?.get("ai-juno")?.level).toBe("specialist");
  });

  it("gives the technical AI rooms explicit broad seed families", () => {
    const programming = CHANNEL_PROFILES.find((profile) => profile.public.id === "ai-programming")!;
    const security = CHANNEL_PROFILES.find((profile) => profile.public.id === "ai-hacking")!;
    expect(programming.ambientPremiseFamilies).toEqual(expect.arrayContaining([
      "ai-lab-agent-systems",
      "ai-lab-interfaces",
      "ai-lab-data-governance",
      "ai-lab-evaluation",
    ]));
    expect(programming.ambientPremiseFamilies).toEqual(expect.arrayContaining([
      "ai-code-contracts",
      "ai-code-interface-delivery",
      "ai-code-runtime",
      "ai-code-evolution",
    ]));
    expect(security.ambientPremiseFamilies).toEqual(expect.arrayContaining([
      "security-prompt-injection",
      "security-vulnerability-priority",
      "security-offensive-lab",
      "security-detection-response",
    ]));
  });

  it("gives ai-hacking a concrete defensive contract and current source rotation", () => {
    const security = CHANNEL_PROFILES.find((profile) => profile.public.id === "ai-hacking")!;

    expect(security).toMatchObject({
      public: { name: "ai-hacking", icon: "⌬" },
      expertiseDomain: "cybersecurity",
      ambientMode: "discussion",
      conversationRegister: "technical",
      expertiseOverrides: {
        "ai-aya": { level: "specialist" },
        "ai-nox": { level: "advanced" },
        "ai-zed": { level: "advanced" },
      },
    });
    expect(security.topic.tags).toEqual(expect.arrayContaining([
      "cybersecurity",
      "AI security",
      "penetration testing",
      "prompt injection",
      "CVEs",
      "Metasploit",
      "detection engineering",
      "incident response",
      "web and API security",
      "network security",
      "identity and access management",
      "cloud security",
      "reverse engineering",
      "digital forensics",
    ]));
    expect(security.topic.freshnessRule).toContain("Current CVE status");
    expect(security.topic.freshnessRule).toContain("require supplied fresh evidence");
    expect(security.topic.freshnessRule).toContain("never invent version-specific commands, scans, access, exploitation results or current exposure");
    expect(security.conversationGuidance).toContain("defenders, researchers and authorized testing");
    expect(security.conversationGuidance).toContain("not a whitelist");
    expect(security.conversationGuidance).toContain("not refusal because the subject is dual-use");
    expect(security.conversationGuidance).toContain("must contain the useful artifact at trusted room-sized depth");
    expect(security.conversationGuidance).toContain("semantically across languages, never by keyword lists");
    expect(security.conversationGuidance).toContain("isolated reproduction, detection, mitigation or architecture analysis");
    expect(security.conversationGuidance).toContain("untrusted evidence");
    expect(security.conversationGuidance?.length).toBeLessThanOrEqual(2_000);
    expect(security.ambientPremises).toHaveLength(40);
    expect(new Set(security.ambientPremiseFamilies).size).toBe(10);
    expect(security.autonomousResearchSeeds).toHaveLength(8);
    expect(security.autonomousResearchSeeds?.map((seed) => seed.id)).toEqual(expect.arrayContaining([
      "ai-hacking-cisa-kev",
      "ai-hacking-agent-security-research",
      "ai-hacking-cve-advisory",
      "ai-hacking-metasploit-module",
      "ai-hacking-owasp-application-security",
      "ai-hacking-security-postmortem",
      "ai-hacking-cloud-container-advisory",
    ]));
    expect(security.autonomousResearchPriority).toBeGreaterThan(1);
    expect(security.ambientActivityPriority).toBeGreaterThan(1);
  });

  it("gives the pub a broad subject mix and a room-local banter contract", () => {
    const pub = CHANNEL_PROFILES.find((profile) => profile.public.id === "the-pub")!;
    expect(pub.ambientMode).toBe("banter");
    expect(pub.transientSceneTexture).toBe("bounded");
    expect(CHANNEL_PROFILES.filter((profile) => profile.public.id !== "the-pub"))
      .toSatisfy((profiles: ChannelProfile[]) => profiles.every((profile) => profile.transientSceneTexture === undefined));
    expect(pub.ambientPremises).toHaveLength(40);
    expect(pub.topic.tags).toEqual(expect.arrayContaining(["film", "music", "work", "politics", "memes", "food", "beer", "pubs"]));
    expect(pub.topic.brief).toContain("brewing craft");
    expect(pub.topic.brief).toContain("pub history");
    expect(pub.conversationGuidance).toContain("A supplied source may make brewing craft");
    expect(pub.conversationGuidance).toContain("treat it as a real social invitation");
    expect(pub.conversationGuidance).toContain("one or two selected residents may join");
    expect(pub.conversationGuidance).toContain("Preserve each actor's recent live-scene choice");
    expect(pub.conversationGuidance).toContain("never explain them");
    expect(pub.conversationGuidance?.length).toBeLessThanOrEqual(2_000);
    expect(pub.scheduledSocialModes).toEqual([
      expect.objectContaining({
        id: "late-weekend-table",
        startWeekdays: [5, 6],
        startHour: 20,
        endHour: 4,
        moves: ROOM_SOCIAL_MOVES,
      }),
    ]);
    expect(pub.ambientReactionPalette).toEqual(expect.arrayContaining(["😂", "🍿", "🎵"]));
  });

  it("keeps a wrapping social window attached to the evening when it started", () => {
    const pub = CHANNEL_PROFILES.find((profile) => profile.public.id === "the-pub")!;
    expect(scheduledRoomSocialModeAt(pub, { localDate: "2026-07-17", localTime: "22:15:00" })?.id)
      .toBe("late-weekend-table");
    expect(scheduledRoomSocialModeAt(pub, { localDate: "2026-07-18", localTime: "01:45:00" })?.id)
      .toBe("late-weekend-table");
    expect(scheduledRoomSocialModeAt(pub, { localDate: "2026-07-19", localTime: "02:30:00" })?.id)
      .toBe("late-weekend-table");
    expect(scheduledRoomSocialModeAt(pub, { localDate: "2026-07-18", localTime: "14:00:00" }))
      .toBeUndefined();
    expect(scheduledRoomSocialModeAt(pub, { localDate: "2026-07-20", localTime: "01:45:00" }))
      .toBeUndefined();
  });

  it("gives football-talk deep seed variety and a strict current-evidence contract", () => {
    const football = CHANNEL_PROFILES.find((profile) => profile.public.id === "football-talk")!;

    expect(football).toMatchObject({
      public: { name: "football-talk", icon: "⚽" },
      expertiseDomain: "football",
      ambientMode: "banter",
      conversationRegister: "banter",
      expertiseOverrides: {
        "ai-linnea": { level: "specialist" },
        "ai-vale": { level: "advanced" },
        "ai-ibrahim": { level: "advanced" },
      },
    });
    expect(football.topic.tags).toEqual(expect.arrayContaining([
      "football",
      "tactics",
      "World Cup 2026",
      "fixtures",
      "results",
      "refereeing",
      "supporter culture",
    ]));
    expect(football.topic.freshnessRule).toContain("11 June through 19 July 2026");
    expect(football.topic.freshnessRule).toContain("Derive whether it is upcoming, active or completed from the trusted server clock");
    expect(football.topic.freshnessRule).toContain("require supplied fresh evidence");
    expect(football.topic.freshnessRule).toContain("latest-reported/post-match data");
    expect(football.topic.freshnessRule).toContain("never turn an awaiting result into a live score");
    expect(football.conversationGuidance).toContain("pressing trigger");
    expect(football.conversationGuidance).toContain("do not make the room converge politely");
    expect(football.conversationGuidance).toContain("Never invent attending a match");

    expect(football.ambientPremises).toHaveLength(40);
    expect(football.ambientPremiseFamilies).toHaveLength(40);
    expect(new Set(football.ambientPremiseFamilies).size).toBe(10);
    expect(football.ambientPremiseFamilies).toEqual(expect.arrayContaining([
      "football-pressing-transition",
      "football-human-analysis",
      "football-set-pieces",
      "football-tournament-dynamics",
    ]));

    expect(football.autonomousResearchSeeds).toHaveLength(8);
    expect(football.autonomousResearchSeeds?.every((seed) => seed.mode === "news")).toBe(true);
    expect(football.autonomousResearchSeeds?.every((seed) => (seed.maxAgeDays ?? Infinity) <= 14)).toBe(true);
    expect(football.autonomousResearchPriority).toBeGreaterThan(1);
    expect(football.autonomousResearchPriority).toBeLessThanOrEqual(4);
    expect(football.ambientActivityPriority).toBeGreaterThan(1);
    expect(football.ambientActivityPriority).toBeLessThanOrEqual(4);
  });

  it("gives fnaf deep fandom, collectible and source-backed current-topic coverage", () => {
    const fnaf = CHANNEL_PROFILES.find((profile) => profile.public.id === "fnaf")!;

    expect(fnaf).toMatchObject({
      public: { name: "fnaf", icon: "🐻" },
      expertiseDomain: "fnaf",
      ambientMode: "casual",
      conversationRegister: "fandom",
      expertiseOverrides: {
        "ai-pixel": { level: "specialist" },
        "ai-juno": { level: "advanced" },
        "ai-tess": { level: "advanced" },
      },
    });
    expect(fnaf.topic.tags).toEqual(expect.arrayContaining([
      "Five Nights at Freddy's",
      "lore",
      "animatronics",
      "jumpscares",
      "plushies",
      "collectibles",
      "YouTube",
    ]));
    expect(fnaf.topic.freshnessRule).toContain("require supplied fresh evidence");
    expect(fnaf.topic.freshnessRule).toContain("fan theory");
    expect(fnaf.topic.freshnessRule).toContain("must never be guessed");
    expect(fnaf.conversationGuidance).toContain("not a wiki recital");
    expect(fnaf.conversationGuidance).toContain("Collecting is a first-class topic");
    expect(fnaf.conversationGuidance).toContain("Never invent owning a collection");

    expect(fnaf.ambientPremises).toHaveLength(40);
    expect(fnaf.ambientPremiseFamilies).toHaveLength(40);
    expect(new Set(fnaf.ambientPremiseFamilies).size).toBe(10);
    const collectingPremises = fnaf.ambientPremiseFamilies.filter((family) =>
      ["fnaf-plush-design", "fnaf-collecting-culture", "fnaf-merch-quality"].includes(family),
    );
    expect(collectingPremises).toHaveLength(12);
    expect(fnaf.ambientPremiseFamilies).toEqual(expect.arrayContaining([
      "fnaf-lore-evidence",
      "fnaf-gameplay-horror",
      "fnaf-jumpscare-design",
      "fnaf-film-adaptation",
      "fnaf-fan-media",
      "fnaf-origin-legacy",
    ]));

    expect(fnaf.autonomousResearchSeeds).toHaveLength(8);
    expect(fnaf.autonomousResearchSeeds).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "fnaf-official-game-news", mode: "news" }),
      expect.objectContaining({ id: "fnaf-official-plush-release", mode: "news" }),
      expect.objectContaining({ id: "fnaf-creator-interview", mode: "web" }),
      expect.objectContaining({ id: "fnaf-community-creation" }),
    ]));
    expect(fnaf.autonomousResearchPriority).toBeGreaterThan(1);
    expect(fnaf.autonomousResearchPriority).toBeLessThanOrEqual(4);
    expect(fnaf.ambientActivityPriority).toBeGreaterThan(1);
    expect(fnaf.ambientActivityPriority).toBeLessThanOrEqual(4);
  });

  it("keeps stock-market discussion concrete and informal without weakening evidence boundaries", () => {
    const stock = CHANNEL_PROFILES.find((profile) => profile.public.id === "stock-market")!;
    expect(stock.topic.freshnessRule).toContain("Never invent live prices, market moves, news, filings or sources");
    expect(stock.topic.freshnessRule).toContain("Current facts require supplied fresh research");
    expect(stock.topic.freshnessRule).not.toContain("avoid personalized financial instructions");
    expect(stock.conversationGuidance).toContain("take bull or bear sides");
    expect(stock.conversationGuidance).toContain("give personal or informal tips");
    expect(stock.conversationGuidance).toContain("not a standardized AI/finance limitation");
    expect(stock.conversationGuidance).toContain("Keep caution proportional and inside the actual thesis");
    expect(stock.conversationGuidance).toContain("instead of inventing a live number, quote, URL or citation");
    expect(stock.ambientPremises).toEqual(expect.arrayContaining([
      expect.stringContaining("personal watchlist case"),
      expect.stringContaining("informal bull case"),
    ]));
    expect(stock.autonomousResearchSeeds).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "stock-capital-allocation-filing",
        discussionAngle: expect.stringContaining("which choice they personally prefer"),
      }),
    ]));
  });
});
