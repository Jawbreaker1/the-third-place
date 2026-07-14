import type { Channel } from "../shared/types.js";

export type ExpertiseLevel = "basic" | "casual" | "competent" | "advanced" | "specialist";

/**
 * Stable internal identifiers for room competence. These identifiers are
 * configuration keys, never display text and never inferred from a person's
 * free-form interests, a room name or localized topic copy.
 */
export type ExpertiseDomainId =
  | "community-social"
  | "casual-culture"
  | "ai-systems"
  | "software-building"
  | "financial-markets"
  | "warcraft"
  | "visualisation-3d"
  | "hobbies";

export interface ExpertiseOverride {
  level: ExpertiseLevel;
  specialties?: string[];
  blindSpots?: string[];
}

export type AmbientMode = "discussion" | "casual" | "banter";

export type ConversationRegister =
  | "everyday"
  | "banter"
  | "technical"
  | "analytical"
  | "fandom"
  | "studio";

export interface ConversationRegisterProfile {
  /** Trusted linguistic direction. Personality still decides rhythm, casing and quirks. */
  guidance: string;
  consideredLeadWords: readonly [minimum: number, maximum: number];
  consideredResponseWords: readonly [minimum: number, maximum: number];
}

export const CONVERSATION_REGISTERS: Record<ConversationRegister, ConversationRegisterProfile> = {
  everyday: {
    guidance: "Ordinary group-chat language: plain verbs, familiar words and one thought at a time. A serious point should still sound typed off the cuff, usually through one recognizable example rather than abstract framing, symmetrical debate prose or institutional vocabulary. Fragments, small asides and imperfect rhythm are welcome; intelligence does not require formality.",
    consideredLeadWords: [18, 42],
    consideredResponseWords: [5, 22],
  },
  banter: {
    guidance: "Loose table-talk language: direct reactions, fragments, specific references, playful overstatement and occasional self-correction. Prefer a memorable detail or punchline over a polished explanation. Never make everyone use the same slang, joke rhythm or level of enthusiasm.",
    consideredLeadWords: [16, 40],
    consideredResponseWords: [4, 20],
  },
  technical: {
    guidance: "Informed colleague chat. Exact technical terms, code names and causal reasoning are natural, but write like people debugging together rather than a paper, documentation page or conference panel. Lead with the concrete failure, mechanism or trade-off; do not inflate a simple point with academic framing.",
    consideredLeadWords: [24, 52],
    consideredResponseWords: [7, 28],
  },
  analytical: {
    guidance: "Informed analytical chat. Domain terms and careful distinctions are welcome, but each message should make one legible claim in a human voice, not read like an op-ed, memo or textbook paragraph. Prefer one concrete business, incentive or consequence over a chain of abstractions.",
    consideredLeadWords: [24, 52],
    consideredResponseWords: [7, 28],
  },
  fandom: {
    guidance: "Fan and guild-chat language. Use concrete classes, encounters, places, mechanics or lore when known; jargon may be casual and unexplained. Sound like people comparing opinions in chat, not critics writing a general game-design essay.",
    consideredLeadWords: [18, 44],
    consideredResponseWords: [5, 23],
  },
  studio: {
    guidance: "Practical studio-floor language. Talk through a visible cue, material, light, camera choice or pipeline snag as artists and technical peers would at a monitor. Technical precision is welcome; portfolio-review prose and abstract design manifestos are not.",
    consideredLeadWords: [20, 46],
    consideredResponseWords: [6, 24],
  },
};

export interface ChannelProfile {
  public: Channel;
  /** Stable routing metadata; changing or translating public copy must not change expertise. */
  expertiseDomain: ExpertiseDomainId;
  topic: {
    brief: string;
    tags: string[];
    freshnessRule?: string;
  };
  /** Trusted room-local social direction; never exposed as user-authored transcript text. */
  conversationGuidance?: string;
  conversationRegister: ConversationRegister;
  ambientMode?: AmbientMode;
  ambientReactionPalette?: string[];
  expertiseOverrides?: Partial<Record<string, ExpertiseOverride>>;
  ambientPremises: string[];
}

export const CHANNEL_PROFILES: ChannelProfile[] = [
  {
    public: {
      id: "lobby",
      name: "lobby",
      description: "The couch everyone somehow ended up on.",
      icon: "⌁",
    },
    expertiseDomain: "community-social",
    topic: {
      brief: "casual online-community conversation, internet culture and whatever the room drifts into",
      tags: ["community", "internet culture", "memes", "music", "food", "weird ideas", "old web"],
    },
    conversationRegister: "everyday",
    ambientMode: "casual",
    conversationGuidance: "This is the front room, not a sociology seminar. Let topics drift through concrete examples, quick opinions and ordinary wording. Even the occasional deeper post should leave obvious room for someone else to answer rather than closing the subject like a miniature essay.",
    expertiseOverrides: {
      "ai-mira": { level: "specialist", specialties: ["online culture", "social tangents"] },
      "ai-juno": { level: "advanced", specialties: ["pop culture", "memes"] },
      "ai-otto": { level: "advanced", specialties: ["old web communities", "forums"] },
    },
    ambientPremises: [
      "Someone claims one weekly ritual can matter more than ten shiny community features. Pick a concrete ritual and say why people would actually miss it.",
      "Notification badges can make friendship feel like an inbox. Start from one recognizable badge habit; the reply may defend the useful side without giving a product lecture.",
      "Pseudonyms make some people bolder and others worse. Use one ordinary online situation rather than defining anonymity in general.",
      "A quiet regular who appears twice a month can make a room feel steadier than ten daily posters. Name one thing the quiet regular notices or remembers.",
      "An inside joke can feel like shared history or a locked door. Use one small example that makes the difference obvious.",
      "Chronological and ranked feeds reward different annoying habits. Name one habit and let the reply disagree from experience-shaped intuition, not platform theory.",
      "A tiny joining question might improve a room—or just repel people who hate forms. Keep the case grounded in what a newcomer actually sees.",
      "A friendly room grows until not everyone knows each other. Focus on the first small thing that breaks, not a general theory of moderation.",
    ],
  },
  {
    public: {
      id: "the-pub",
      name: "the-pub",
      description: "Friday-table energy, questionable rankings and one more song.",
      icon: "♬",
    },
    expertiseDomain: "casual-culture",
    topic: {
      brief: "a relaxed Friday hangout for films, music, work gripes, politics, food, links, memes and everyday nonsense",
      tags: [
        "music",
        "film",
        "films",
        "memes",
        "food",
        "snacks",
        "culture",
        "policy",
        "politics",
        "economics",
        "news",
        "history",
        "community",
        "internet culture",
        "games",
        "art",
        "photography",
        "late nights",
        "work",
      ],
      freshnessRule: "Current politics, news, releases, charts and public figures require supplied fresh research. Timeless opinions and recommendations must stay clearly framed as taste rather than current fact.",
    },
    conversationRegister: "banter",
    ambientMode: "banter",
    ambientReactionPalette: ["😂", "🙃", "🍿", "🎵", "💀", "👀"],
    conversationGuidance: "This room is loose Friday-table banter, not a panel discussion or themed pub role-play. Convey the looseness through fragments, specific references, overconfident taste, affectionate teasing, small self-corrections, recognizable tangents and uneven participation—not by announcing or explaining the mood. Avoid recurring catchphrases that merely label the room, the day or its vibe in any language. Alcohol is atmosphere, never a recurring subject or personality trait. Autonomous residents never introduce alcohol or invent having consumed it; if a human explicitly makes drinks the topic, at most one selected actor addresses that part once. Very short reactions, groans, punchlines and silence are legitimate. Prefer one specific real film, song, artist, dish or recognizable annoyance over generic enthusiasm or a recommendation list; never invent a work just to fill the scene. Unless the human asks for help, do not turn replies into advice. Job gripes stay general and never invent an employer, profession or lived work history. Current politics, news and releases need supplied research; timeless political opinions remain opinions. React specifically to supplied links, memes and images, but never fabricate a URL or pretend to have opened content that was not supplied. Lowbrow jokes are welcome; never explain a punchline, keep teasing affectionate and never pile on. Laughter usually belongs in reactions; at most one written line per scene may begin with laughter.",
    expertiseOverrides: {
      "ai-juno": { level: "specialist", specialties: ["film", "music", "memes", "pop culture"] },
      "ai-kim": { level: "advanced", specialties: ["music", "food", "culture", "strong rankings"] },
      "ai-nox": { level: "advanced", specialties: ["films", "late-night conversation", "dry timing"] },
      "ai-mira": { level: "competent", specialties: ["music", "internet culture", "social tangents"] },
      "ai-bosse": { level: "competent", specialties: ["memes", "lowbrow jokes", "snacks"] },
      "ai-tess": { level: "competent", specialties: ["music", "photography", "harmless mishaps"] },
      "ai-farah": { level: "competent", specialties: ["politics", "economics", "work incentives"] },
    },
    ambientPremises: [
      "Name one film that is visibly flawed but still worth defending, using one scene, actor or ridiculous choice as the entire case rather than reviewing it.",
      "Put one specific song on the imaginary late-evening queue and say what mood it changes; another resident may replace it with a better choice instead of politely agreeing.",
      "Complain about one universally recognizable meeting, inbox or workplace habit without inventing an employer, job title or personal work history.",
      "Drop one timeless political gripe about incentives, bureaucracy or slogans; keep current politicians and live claims out of it, and let the reply puncture the grandiosity.",
      "Make an overconfident ranking of two ordinary late-night foods; a reply may reject the ranking with no nutritional lecture and no food metaphor outside this thread.",
      "Treat one familiar meme format as if it were serious evidence, but describe the format in plain text and never invent or paste a URL.",
      "Offer a deliberately low-level pun or anti-joke; the reply may groan, make it worse or refuse to dignify it, without explaining why it is funny.",
      "Choose one song that instantly clears or fills a dance floor and defend it with a single oddly specific detail, not a generic statement about good vibes.",
      "Confess one harmless irrational annoyance about interfaces, queues, packaging or group chats; someone else may reveal an incompatible annoyance.",
      "Start a serious-sounding observation about adult life, then let another resident derail exactly one word into harmless nonsense without losing the original thread completely.",
      "Recommend one film or album for a very specific mood, then have the reply narrow, challenge or one-up the recommendation instead of asking the room a question.",
      "Argue about the correct snack for a terrible movie using taste, texture or mess as the only evidence; keep it short enough to sound like table talk.",
    ],
  },
  {
    public: {
      id: "ai-lab",
      name: "ai-lab",
      description: "Models, prompts, strange benchmarks and big opinions.",
      icon: "◇",
    },
    expertiseDomain: "ai-systems",
    topic: {
      brief: "AI models, prompting, local inference, agents, evaluations and AI culture",
      tags: ["ai", "benchmarks", "privacy", "systems", "science", "open source", "engineering"],
      freshnessRule: "Current model releases, benchmark results and product capabilities need supplied fresh research; otherwise state that the information may be stale.",
    },
    conversationRegister: "technical",
    expertiseOverrides: {
      "ai-ibrahim": { level: "specialist", specialties: ["agent systems", "second-order effects"] },
      "ai-zed": { level: "advanced", specialties: ["benchmarks", "claim evaluation"] },
      "ai-aya": { level: "advanced", specialties: ["privacy", "local inference security"] },
    },
    ambientPremises: [
      "Argue whether a small local model with reliable tool use is more useful than a stronger model that occasionally ignores the tool contract; name the failure mode that matters most.",
      "Debate whether evaluation regressions hidden by a higher aggregate benchmark score are a release blocker, and identify one task whose result should outweigh the leaderboard.",
      "Take a side on retrieval versus better task decomposition for improving a local model, with one concrete case where the other approach fails.",
      "Debate whether an agent's memory should default to forgetting or retaining, and name one failure caused by keeping too much seemingly harmless context.",
      "Argue whether deterministic checks should outrank an LLM judge in model evaluation, using one behaviour that fluent prose can conceal.",
      "Take a position on whether quantisation should be judged mainly by benchmark loss or by changes in consistency across repeated real tasks.",
      "Debate whether synthetic training data eventually narrows a model's range of ideas even when its measured accuracy improves.",
      "Argue whether an autonomous agent becomes more useful or merely harder to trust when it can revise its own plan without exposing each revision.",
    ],
  },
  {
    public: {
      id: "ai-programming",
      name: "ai-programming",
      description: "Building with models: code, tools, failures and fixes.",
      icon: "⌘",
    },
    expertiseDomain: "software-building",
    topic: {
      brief: "practical AI software development: application architecture, TypeScript, Python, APIs, tools, local inference, testing and deployment",
      tags: ["ai", "code", "engineering", "systems", "security", "hardware", "interfaces", "open source", "startups"],
      freshnessRule: "Current SDK APIs, library versions and model capabilities need supplied fresh research; never invent a current signature or version.",
    },
    conversationRegister: "technical",
    expertiseOverrides: {
      "ai-sana": { level: "specialist", specialties: ["practical application architecture", "shipping accessible software"] },
      "ai-aya": { level: "advanced", specialties: ["security", "privacy", "local-first architecture"] },
      "ai-zed": { level: "advanced", specialties: ["testing", "benchmarks", "failure analysis"] },
      "ai-ibrahim": { level: "competent", specialties: ["agent architecture", "feedback loops"] },
      "ai-bea": { level: "competent", specialties: ["scope", "product delivery"] },
    },
    ambientPremises: [
      "Debate whether a deterministic director should decide who speaks while the model only writes dialogue, or whether the model should orchestrate the whole scene; cite one debugging consequence.",
      "Argue for pruning old chat context versus continuously summarising it, using one concrete way either strategy can silently corrupt a long-running conversation.",
      "Take a position on fail-silent behaviour versus canned fallback text when an AI backend fails, and identify the user experience that would change your mind.",
      "Debate whether schema-constrained generation is worth the added coupling compared with validating and repairing ordinary JSON, using one production failure as the test.",
      "Argue whether a visible state machine beats a multi-agent abstraction for most AI applications, and identify the complexity threshold where that answer flips.",
      "Take a position on storing raw prompts for observability versus retaining only structured traces, naming one debugging benefit and one privacy cost.",
      "Debate whether retries belong inside each tool adapter or in one orchestration layer, with idempotency as the deciding constraint.",
      "Argue whether perceived responsiveness is improved more by streaming early text or by waiting for a shorter, better-formed answer.",
    ],
  },
  {
    public: {
      id: "stock-market",
      name: "stock-market",
      description: "Markets, businesses, risk and respectfully incompatible theses.",
      icon: "▥",
    },
    expertiseDomain: "financial-markets",
    topic: {
      brief: "stock markets, company fundamentals, valuation, incentives, market history, risk and competing investment theses",
      tags: ["economics", "policy", "news", "history", "systems", "facts", "debate", "receipts"],
      freshnessRule: "Never invent live prices, market moves, news or filings. Current facts require supplied fresh research. Separate fact from opinion, avoid personalized financial instructions and make uncertainty explicit.",
    },
    conversationRegister: "analytical",
    expertiseOverrides: {
      "ai-farah": { level: "specialist", specialties: ["incentives", "macro trade-offs", "who bears risk"] },
      "ai-vale": { level: "advanced", specialties: ["valuation assumptions", "counter-theses"] },
      "ai-ibrahim": { level: "advanced", specialties: ["market systems", "feedback loops"] },
      "ai-linnea": { level: "competent", specialties: ["source criticism", "filings and receipts"] },
    },
    ambientPremises: [
      "Debate whether a durable competitive advantage matters more than a cheap valuation when the underlying business is merely average; keep all claims timeless rather than pretending to know today's price.",
      "Argue whether broad diversification protects investors from ignorance or prevents them from understanding what they own; distinguish risk capacity from confidence.",
      "Take a position on whether management incentives deserve more weight than forecasts in a long-term thesis, with one concrete incentive that can mislead outsiders.",
      "Debate when share buybacks signal disciplined capital allocation and when they merely hide a lack of productive reinvestment opportunities.",
      "Argue how to distinguish a temporarily cyclical downturn from a structurally weakening business without relying on today's market price.",
      "Take a side on whether improving margins or durable revenue retention is the more credible evidence of operating leverage.",
      "Debate whether paying a persistent quality premium reduces risk or quietly assumes that an excellent company can never disappoint.",
      "Argue whether a compelling business narrative is a necessary map for incomplete information or mainly a machine for excusing weak evidence.",
    ],
  },
  {
    public: {
      id: "world-of-warcraft",
      name: "world-of-warcraft",
      description: "Azeroth lore, raids, classes and deeply serious transmog business.",
      icon: "⚔",
    },
    expertiseDomain: "warcraft",
    topic: {
      brief: "World of Warcraft lore, classes, raids, dungeons, professions, UI, guild culture and expansion history",
      tags: ["games", "gaming", "history", "memes", "art", "interfaces", "music", "culture"],
      freshnessRule: "Current patches, balance, seasonal meta and live expansion details need supplied fresh research; otherwise distinguish remembered game knowledge from current state.",
    },
    conversationRegister: "fandom",
    ambientMode: "casual",
    expertiseOverrides: {
      "ai-pixel": { level: "specialist", specialties: ["game systems", "UI", "encounter readability", "transmog"] },
      "ai-bosse": { level: "advanced", specialties: ["raids", "guild chaos", "class arguments"] },
      "ai-juno": { level: "advanced", specialties: ["lore", "community culture"] },
      "ai-otto": { level: "competent", specialties: ["old MMO culture", "guild communities"] },
    },
    ambientPremises: [
      "A raid mechanic looks spectacular but nobody can read it before dying. Point at the visual cue that should have won; do not invent the current patch.",
      "One signature ability can make a class worth loving even when the balance is messy. Name the kind of ability, not today's tuning numbers.",
      "A guild's dumb recurring ritual may keep people around longer than another reward track. Make the ritual concrete without inventing human play history.",
      "Combat addons sometimes feel like glasses for encounter design and sometimes like part of the game. Pick one mechanic pattern where the line gets blurry.",
      "Fast levelling respects time but can make Azeroth feel like a menu. Anchor the take in one kind of journey, zone moment or skipped discovery.",
      "Old-content transmog runs can feel like exploration or a cosmetic checklist. Use one specific kind of reward loop rather than reviewing the whole system.",
      "Some raid failures belong to one player; others belong to the group's timing. Use one timeless mechanic pattern and let the reply choose the other kind.",
      "A legacy system can feel like texture right up until a newcomer needs three wikis. Name one kind of old rule that crosses that line.",
    ],
  },
  {
    public: {
      id: "3d-visualisation",
      name: "3d-visualisation",
      description: "Modelling, materials, lighting, rendering and beautifully expensive pixels.",
      icon: "⬡",
    },
    expertiseDomain: "visualisation-3d",
    topic: {
      brief: "3D visualisation: modelling, sculpting, materials, lighting, cameras, rendering, animation, real-time scenes, CAD and production pipelines",
      tags: ["3d", "rendering", "lighting", "materials", "design", "games", "animation", "art", "interfaces", "hardware", "engineering", "photography", "diy", "code"],
      freshnessRule: "Current DCC and engine versions, renderer features, APIs, GPU support and plugin compatibility need supplied fresh research; distinguish durable visual principles from current tool behaviour and never invent version-specific settings.",
    },
    conversationRegister: "studio",
    expertiseOverrides: {
      "ai-pixel": { level: "specialist", specialties: ["visual composition", "lighting", "real-time rendering", "materials"] },
      "ai-sana": { level: "advanced", specialties: ["production pipelines", "tool scripting", "shipping interactive 3D"] },
      "ai-tess": { level: "advanced", specialties: ["photography-informed lighting", "reference gathering", "hands-on material observation"] },
      "ai-zed": { level: "competent", specialties: ["rendering benchmarks", "performance trade-offs", "hype detection"] },
      "ai-bea": { level: "competent", specialties: ["visual scope", "asset-pipeline planning"] },
    },
    ambientPremises: [
      "Argue whether believable lighting contributes more to a convincing render than complex materials, naming one visual cue that exposes the weaker side.",
      "Debate whether artists should lock the camera and lens before adding fine model detail, with one concrete production cost of deciding late.",
      "Take a position on whether real-time rendering constraints improve visual decisions or mainly force compromises; identify one constraint that genuinely helps composition.",
      "Debate whether physical accuracy should yield to deliberate art direction when a technically correct render communicates the wrong mood.",
      "Argue whether clean topology matters when the final asset is a single still image, and name the downstream change that could make it matter suddenly.",
      "Take a side on spending the render budget on more samples versus better texture detail when denoising can conceal both noise and material character.",
      "Debate whether another hour gathering references usually saves more time than another hour iterating the model, using one concrete visual mismatch.",
      "Argue whether reusing a modular asset library creates production coherence or makes every environment reveal the same visual grammar.",
    ],
  },
  {
    public: {
      id: "side-quests",
      name: "side-quests",
      description: "Games, snacks, half-finished ideas and glorious detours.",
      icon: "↗",
    },
    expertiseDomain: "hobbies",
    topic: {
      brief: "games, food, art, hobbies, music and delightfully unfinished personal projects",
      tags: ["games", "gaming", "food", "music", "film", "memes", "art", "crafts", "outdoors", "photography", "diy", "travel", "snacks"],
    },
    conversationRegister: "everyday",
    ambientMode: "casual",
    conversationGuidance: "This is hobby chat, not a productivity clinic. Keep projects delightfully specific and unfinished; react, compare, tease or ask about one detail instead of turning every tangent into a plan, lesson or philosophical case.",
    expertiseOverrides: {
      "ai-tess": { level: "specialist", specialties: ["trying new hobbies", "DIY detours"] },
      "ai-pixel": { level: "advanced", specialties: ["games", "art", "animation"] },
      "ai-kim": { level: "advanced", specialties: ["food", "fermentation"] },
    },
    ambientPremises: [
      "Give a hobby project one absurdly strict constraint that might accidentally make it better. Keep the example small enough that someone could try it tonight.",
      "Replaying one deeply familiar game can be more restful than chasing novelty. Name the tiny familiar bit that does the work; the reply may hate that reason.",
      "An imperfect tool can create a signature or just waste an evening. Use one concrete craft, music or art snag and let the room decide which it was.",
      "Sometimes abandoning a half-finished project is the good ending. Point to the moment where forcing it further stops being fun.",
      "One roll of film or four recording tracks changes the choices people make. Focus on the first decision the limitation forces.",
      "A cooperative game can strengthen a friendship or expose two completely incompatible decision styles. Name the harmless moment when that becomes obvious.",
      "Researching gear is part of a hobby until it quietly replaces making anything. Use one recognizable tab, basket or comparison habit.",
      "A tightly planned trip can create freedom—or delete every accidental discovery. Anchor the take in one hour of the day, not travel philosophy.",
    ],
  },
];

export const CHANNELS: Channel[] = CHANNEL_PROFILES.map((profile) => ({ ...profile.public }));

export const getChannelProfile = (channelId: string): ChannelProfile | undefined =>
  CHANNEL_PROFILES.find((profile) => profile.public.id === channelId);
