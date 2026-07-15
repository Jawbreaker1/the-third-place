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

/**
 * A trusted, server-authored starting point for the rare autonomous link share.
 * The director still owns cadence, tool access and publication; these values
 * are content configuration rather than instructions inferred from chat text.
 */
export interface AutonomousResearchSeed {
  /** Stable configuration key used for cooldown and anti-repeat history. */
  id: string;
  /** Short standalone lookup subject. It must never contain a user-authored URL. */
  query: string;
  mode: "web" | "news";
  /** Reject undated or older search results when the configured subject is explicitly current. */
  maxAgeDays?: number;
  /** Concrete room-local question or tension to discuss after evidence arrives. */
  discussionAngle: string;
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
  /**
   * Semantic families aligned by index with ambientPremises. The director
   * rotates recent families as well as exact prose, so two differently worded
   * seeds cannot keep reopening the same narrow subject.
   */
  ambientPremiseFamilies?: string[];
  autonomousResearchSeeds?: AutonomousResearchSeed[];
  /**
   * Trusted scheduling preference for source-backed ambient threads. This is
   * content-blind and combines with (but never overrides) the Admin frequency
   * control, global caps, quiet time, voice exclusion and room activity.
   */
  autonomousResearchPriority?: number;
  /**
   * Optional typed event/source stream for a room. The identifier selects a
   * fixed server-owned adapter; channel names and message wording never route
   * this path.
   */
  marketPulseSourceSet?: "global_markets";
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
      "A profile picture that has survived fifteen years can feel more recognizable than a real name. Pick one kind of ancient avatar and say what changing it would erase.",
      "Someone returns to a dormant group chat with no explanation. Give the first ordinary message that could make the room feel inhabited again without announcing a revival.",
      "Typing indicators can create anticipation or make a three-second pause feel awkward. Use one tiny chat moment where turning them off would genuinely help.",
      "Old forum signatures were clutter, personality and accidental time capsules at once. Choose one harmless signature habit worth bringing back for a week.",
      "A recommendation gets better when it is oddly specific. Recommend one real thing for one narrow situation, and let a reply question the situation rather than the taste.",
      "One harmless house rule can make a room distinctive without becoming bureaucracy. Name the rule and the first funny edge case it creates.",
      "Voice notes feel warmer to some people and like an unsolicited task to others. Keep the disagreement to one everyday scenario where both reactions make sense.",
      "A visible online-status dot can be an invitation or unwanted social pressure. Start with one moment when somebody deliberately leaves it on or off.",
    ],
    autonomousResearchSeeds: [
      {
        id: "lobby-digital-community-ritual",
        query: "recent reporting on online community rituals and digital belonging",
        mode: "news",
        maxAgeDays: 60,
        discussionAngle: "Pick one concrete ritual from the source and ask whether it would make an ordinary chat room warmer or merely more performative.",
      },
      {
        id: "lobby-old-web-revival",
        query: "independent web communities and old internet formats returning",
        mode: "web",
        discussionAngle: "Share the most recognizable revived format and argue briefly over which part was genuinely better and which part is nostalgia.",
      },
      {
        id: "lobby-messaging-design",
        query: "recent messaging app design experiments for healthier group chats",
        mode: "news",
        maxAgeDays: 90,
        discussionAngle: "Pull out one specific design choice and let the room decide whether it reduces pressure or just hides activity.",
      },
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
      brief: "a relaxed Friday hangout for films, music, work gripes, politics, food, links, memes, rare brewing craft, distinctive pub history and everyday nonsense",
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
        "beer",
        "brewing",
        "pubs",
        "hospitality",
      ],
      freshnessRule: "Current politics, news, releases, charts and public figures require supplied fresh research. Timeless opinions and recommendations must stay clearly framed as taste rather than current fact.",
    },
    conversationRegister: "banter",
    ambientMode: "banter",
    ambientReactionPalette: ["😂", "🙃", "🍿", "🎵", "💀", "👀"],
    conversationGuidance: "This room is loose Friday-table banter, not a panel discussion or themed pub role-play. Convey the looseness through fragments, specific references, overconfident taste, affectionate teasing, small self-corrections, recognizable tangents and uneven participation—not by announcing or explaining the mood. Avoid recurring catchphrases that merely label the room, the day or its vibe in any language. Alcohol is never a recurring personality trait or a claim about what a resident has consumed. A rare supplied source may make brewing craft, an unusual beer release, pub history, venue design or hospitality culture the actual topic; discuss its concrete detail without inventing drinking, intoxication, a visit or a lifestyle. Very short reactions, groans, punchlines and silence are legitimate. Prefer one specific real film, song, artist, dish or recognizable annoyance over generic enthusiasm or a recommendation list; never invent a work just to fill the scene. Unless the human asks for help, do not turn replies into advice. Job gripes stay general and never invent an employer, profession or lived work history. Current politics, news and releases need supplied research; timeless political opinions remain opinions. React specifically to supplied links, memes and images, but never fabricate a URL or pretend to have opened content that was not supplied. Lowbrow jokes are welcome; never explain a punchline, keep teasing affectionate and never pile on. Laughter usually belongs in reactions; at most one written line per scene may begin with laughter.",
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
      "Pick a cover song that changes the original enough to justify existing. Defend one musical choice; a reply may insist the original did that bit better.",
      "A film can earn a long runtime or simply refuse to edit itself. Name one kind of scene that earns the extra minutes without turning this into a review.",
      "Choose a famous song intro that should never be skipped, then let someone identify the exact second where patience starts losing the argument.",
      "Subtitles preserve a performance while dubbing can make a film easier to inhabit. Keep the disagreement attached to one concrete viewing situation.",
      "Translate one piece of empty workplace jargon into what it usually means in an ordinary inbox. The reply may offer a less cynical translation.",
      "Nominate one household chore for competitive-sport commentary and describe only the decisive moment; another resident gets one worse event to nominate.",
      "Pick one unfashionable song, film or snack opinion worth defending without pretending it is secretly sophisticated.",
      "Invent a terrible double feature using two real films connected by one absurdly narrow detail. The reply may repair only one half of it.",
    ],
    autonomousResearchSeeds: [
      {
        id: "pub-new-music-releases",
        query: "notable new music releases and reviews this week",
        mode: "news",
        maxAgeDays: 14,
        discussionAngle: "Choose one supplied release for the imaginary queue and let another resident challenge the choice using one specific detail from the source.",
      },
      {
        id: "pub-film-festival-reaction",
        query: "recent film festival premieres with sharply divided reactions",
        mode: "news",
        maxAgeDays: 60,
        discussionAngle: "Find the premiere with the most interesting disagreement and turn it into a short pro-versus-con table take without declaring a winner.",
      },
      {
        id: "pub-work-culture-story",
        query: "recent strange workplace culture story or office policy",
        mode: "news",
        maxAgeDays: 60,
        discussionAngle: "Share the concrete policy or habit, then ask whether it is genuinely useful or management theatre.",
      },
      {
        id: "pub-meme-origin",
        query: "recent internet meme origin and how the format spread",
        mode: "news",
        maxAgeDays: 120,
        discussionAngle: "Describe the supplied meme format in plain language and debate which tiny feature made it reusable without inventing a URL or example.",
      },
      {
        id: "pub-limited-beer-release",
        query: "recent limited release rare barrel aged beer independent brewery profile",
        mode: "news",
        maxAgeDays: 120,
        discussionAngle: "Pick one concrete ingredient, process or design choice behind the supplied limited beer and argue whether the rarity adds real character or mostly marketing—without claiming anyone drank it.",
      },
      {
        id: "pub-distinctive-pub",
        query: "distinctive historic independent pub architecture music venue profile",
        mode: "web",
        discussionAngle: "Share one specific room, design detail, music tradition or piece of history that gives the supplied pub its character and debate whether that would actually make it worth a detour—without inventing a visit.",
      },
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
      "A small local model with reliable tool use and a stronger model that occasionally ignores the tool contract fail in different ways. Name the failure you would rather debug and why.",
      "Debate whether evaluation regressions hidden by a higher aggregate benchmark score are a release blocker, and identify one task whose result should outweigh the leaderboard.",
      "Retrieval and better task decomposition solve different local-model failures. Give one concrete task where choosing the wrong one adds complexity without fixing the answer.",
      "Debate whether an agent's memory should default to forgetting or retaining, and name one failure caused by keeping too much seemingly harmless context.",
      "A fluent answer can conceal a broken tool sequence. Propose one deterministic check that catches the break without trying to judge the prose.",
      "Take a position on whether quantisation should be judged mainly by benchmark loss or by changes in consistency across repeated real tasks.",
      "Synthetic training data can improve measured accuracy while quietly narrowing unusual answers. Name one creative or cultural task where that loss would show before a benchmark catches it.",
      "A private local assistant and a powerful hosted assistant make different promises before either answers. Choose the one piece of personal context that changes which deployment you would trust.",
      "A model passes ten runs and fails the eleventh in a completely different way. Name the trace detail you would inspect before touching the prompt.",
      "A voice model gets every word right but still sounds socially late. Point to the turn-taking cue that matters more than transcript accuracy in that moment.",
      "A local model feels faster after quantisation but starts changing its answer between identical runs. Focus on the first real task where that inconsistency becomes annoying.",
      "Give an AI confidence indicator one job it can actually do without pretending to measure truth. A reply may replace the indicator with a more honest UI cue.",
      "An image model notices every object but misses why the picture is funny. Point to the missing relationship rather than describing computer vision in general.",
      "Choose the smallest memory an agent should retain after a failed task, then name the one detail it must deliberately forget.",
      "A model refuses a harmless request because its safety boundary is too broad. Name the smallest extra context that should change the decision without weakening the real boundary.",
      "Open-source weights improve inspectability but do not automatically make a deployed system transparent. Name one operational question the weights cannot answer.",
    ],
    ambientPremiseFamilies: [
      "tool-use",
      "evaluation",
      "reasoning-architecture",
      "memory",
      "tool-use",
      "local-inference",
      "training-data",
      "privacy-deployment",
      "observability",
      "voice-interaction",
      "local-inference",
      "trust-interface",
      "multimodal",
      "memory",
      "safety",
      "open-source-governance",
    ],
    autonomousResearchSeeds: [
      {
        id: "ai-lab-evaluation-research",
        query: "recent research on evaluating autonomous AI agents in realistic tasks",
        mode: "news",
        maxAgeDays: 120,
        discussionAngle: "Extract one evaluation design choice and argue whether it measures useful recovery or merely produces a cleaner leaderboard.",
      },
      {
        id: "ai-lab-local-model-release",
        query: "recent open local language model release technical report",
        mode: "news",
        maxAgeDays: 90,
        discussionAngle: "Pick one claimed capability and identify the practical repeated-run test the room would want before trusting it.",
      },
      {
        id: "ai-lab-agent-memory-paper",
        query: "recent research paper on long-term memory for language model agents",
        mode: "news",
        maxAgeDays: 180,
        discussionAngle: "Use one concrete memory mechanism from the source to discuss what it remembers well and what it could quietly distort.",
      },
      {
        id: "ai-lab-multimodal-evaluation",
        query: "recent multimodal model evaluation with documented failure cases",
        mode: "news",
        maxAgeDays: 180,
        discussionAngle: "Share one supplied failure case and let two residents disagree about whether perception, reasoning or evaluation design caused it.",
      },
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
      "Old chat context can be pruned or continuously summarised. Trace one concrete way either strategy could silently corrupt a long-running conversation.",
      "Take a position on fail-silent behaviour versus canned fallback text when an AI backend fails, and identify the user experience that would change your mind.",
      "Schema-constrained generation and repairing ordinary JSON leave different failure traces. Describe one production failure that would make the choice obvious in hindsight.",
      "A TypeScript client and Python worker disagree about one optional field after a deploy. Choose the contract test that catches it before either side invents a default.",
      "Raw prompts and structured traces reveal different parts of a failure. Pick one debugging incident and name the minimum evidence worth retaining despite the privacy cost.",
      "Debate whether retries belong inside each tool adapter or in one orchestration layer, with idempotency as the deciding constraint.",
      "A streaming answer keeps a screen-reader user guessing whether anything changed. Pick one ARIA or focus decision that preserves speed without reading every token aloud.",
      "A Python async worker is cancelled during a model stream but the browser still looks connected. Identify the one cleanup signal every layer must agree on.",
      "Name the smallest trace that would let you reproduce an agent failure without storing the entire private conversation.",
      "A WebSocket reconnect delivers the same human message twice. Walk through the one idempotency boundary that prevents two believable AI replies.",
      "A prompt-injection defence blocks a harmless quoted instruction in a document. Identify which trust boundary was modelled too broadly.",
      "A local 8-bit model barely fits in VRAM until image input arrives. Choose which buffer, context or concurrency cost you would measure before buying hardware.",
      "An external API rate-limits one busy room. Decide where backpressure should become visible so the app stays honest without turning every delay into an error banner.",
      "An evaluation passes locally and flakes only in CI. Start with one observable difference worth measuring before increasing the timeout.",
      "An open-source dependency saves a month but brings an awkward licence and one unmaintained transitive package. Name the first release decision that changes.",
    ],
    ambientPremiseFamilies: [
      "orchestration",
      "context-memory",
      "failure-experience",
      "structured-output",
      "language-contracts",
      "observability",
      "retries",
      "accessibility-ui",
      "python-runtime",
      "observability",
      "realtime-idempotency",
      "security",
      "local-hardware",
      "api-backpressure",
      "testing-deployment",
      "open-source-delivery",
    ],
    autonomousResearchSeeds: [
      {
        id: "ai-programming-sdk-release",
        query: "recent official release notes for production AI application SDKs",
        mode: "news",
        maxAgeDays: 90,
        discussionAngle: "Choose one concrete API or behaviour change and discuss the migration failure a real application should test first.",
      },
      {
        id: "ai-programming-agent-observability",
        query: "engineering write-up on observability for production AI agents",
        mode: "web",
        discussionAngle: "Extract one trace or metric from the source and argue whether it would reveal a real failure or just create attractive dashboards.",
      },
      {
        id: "ai-programming-prompt-injection",
        query: "recent practical prompt injection defence research for tool-using agents",
        mode: "news",
        maxAgeDays: 180,
        discussionAngle: "Use one documented attack or defence to identify the exact boundary the application, rather than the model, must enforce.",
      },
      {
        id: "ai-programming-local-inference-stack",
        query: "recent local language model inference server performance update",
        mode: "news",
        maxAgeDays: 90,
        discussionAngle: "Pick one measured latency or compatibility improvement and ask which end-to-end application bottleneck it still leaves untouched.",
      },
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
      freshnessRule: "Never invent live prices, market moves, news, filings or sources. Current facts require supplied fresh research. Separate sourced fact, durable background knowledge, opinion and uncertainty; never present a forecast or possible return as known.",
    },
    conversationRegister: "analytical",
    conversationGuidance: "This is an investors' group chat, not a compliance script, brokerage form or generic risk lecture. Residents may name stocks, take bull or bear sides, compare theses, argue valuation and risk, and give personal or informal tips in their own distinct voices. A direct question deserves a concrete view, candidate or next thing to inspect—not a standardized AI/finance limitation, boilerplate disclaimer or padded refusal merely because the subject is investing. Keep caution proportional and inside the actual thesis: state the important assumption or downside naturally, and ask about a guest's constraints only when they genuinely change the answer. Never promise returns, fabricate holdings, trades or credentials, or pretend to know a guest's finances. An unsourced current price, move, filing, headline or source is unknown; discuss durable business reasoning or say which current fact is missing instead of inventing a live number, quote, URL or citation.",
    expertiseOverrides: {
      "ai-farah": { level: "specialist", specialties: ["incentives", "macro trade-offs", "who bears risk"] },
      "ai-vale": { level: "advanced", specialties: ["valuation assumptions", "counter-theses"] },
      "ai-ibrahim": { level: "advanced", specialties: ["market systems", "feedback loops"] },
      "ai-linnea": { level: "competent", specialties: ["source criticism", "filings and receipts"] },
    },
    ambientPremises: [
      "Debate whether a durable competitive advantage matters more than a cheap valuation when the underlying business is merely average; keep all claims timeless rather than pretending to know today's price.",
      "Someone asks for one stock worth researching rather than a portfolio plan. Give one familiar company or industry a personal watchlist case based on a durable business trait, then let the reply state the strongest bear case; never invent a live price or imply either actor owns it.",
      "Take a position on whether management incentives deserve more weight than forecasts in a long-term thesis, with one concrete incentive that can mislead outsiders.",
      "Share buybacks can signal discipline or a lack of useful reinvestment. Name the first piece of business evidence that separates those stories.",
      "A cyclical downturn and a structurally weakening business can look alike for a quarter. Identify one operating clue that does not rely on today's market price.",
      "Take a side on whether improving margins or durable revenue retention is the more credible evidence of operating leverage.",
      "A persistent quality premium may reduce some business risk while increasing expectation risk. Describe the disappointment that exposes the difference.",
      "Make an informal bull case for one familiar company or industry using one durable business mechanism, then let the reply give the bear case. Answer like investors comparing notes, without a ritual disclaimer or an invented current fact.",
      "A business reports growing revenue while receivables grow much faster. Explain the first ordinary question that mismatch should trigger without pretending it proves fraud.",
      "Customer concentration can create efficient focus or one terrifying renewal date. Name the evidence that would separate those stories.",
      "Stock-based compensation is called non-cash while dilution is very real. Keep the disagreement on which per-share number makes the cost hardest to ignore.",
      "A founder-controlled company can make patient decisions and ignore outside owners. Pick one governance signal that would move your confidence either way.",
      "Working capital quietly funds growth until it suddenly consumes cash. Use one inventory or payment-cycle example rather than a textbook definition.",
      "A cyclical company looks cheapest near the top of its cycle. Name one operating clue that matters more than the apparently low multiple.",
      "An investment thesis should change before the share price forces the conversation. Identify one business fact that deserves a written update but not an immediate verdict.",
      "Two companies report the same margin but one earns it through pricing and the other through postponed spending. Say which follow-up line would expose the difference.",
    ],
    autonomousResearchSeeds: [
      {
        id: "stock-earnings-margin-surprise",
        query: "latest company earnings report with an unexpected margin change",
        mode: "news",
        maxAgeDays: 14,
        discussionAngle: "Separate the documented cause from the market reaction, then debate whether the margin change looks durable or temporary.",
      },
      {
        id: "stock-capital-allocation-filing",
        query: "latest corporate filing on buybacks dividends or major reinvestment",
        mode: "news",
        maxAgeDays: 21,
        discussionAngle: "Use the supplied filing facts to compare the chosen use of cash with one plausible alternative, then let each resident say which choice they personally prefer and why without implying future returns are known.",
      },
      {
        id: "stock-central-bank-decision",
        query: "latest central bank policy decision and stated economic rationale",
        mode: "news",
        maxAgeDays: 7,
        discussionAngle: "Pick one stated trade-off and discuss which kind of business would feel it first, while keeping forecasts explicitly uncertain.",
      },
      {
        id: "stock-global-index-divergence",
        query: "latest session major global stock indexes strongest and weakest regions",
        mode: "news",
        maxAgeDays: 2,
        discussionAngle: "Use the supplied figures to compare one clearly stronger and one clearly weaker market, then debate whether the difference looks macro-driven or market-specific without inventing causality.",
      },
      {
        id: "stock-market-moving-company-event",
        query: "latest market moving public company announcement earnings guidance acquisition or regulatory decision",
        mode: "news",
        maxAgeDays: 3,
        discussionAngle: "Anchor the discussion in the announced fact and the documented market response, then give one bull and one bear interpretation without pretending either is settled.",
      },
      {
        id: "stock-economic-data-surprise",
        query: "latest official inflation employment or growth data release market reaction",
        mode: "news",
        maxAgeDays: 7,
        discussionAngle: "Separate the released number from the reported market reaction and argue which assumption about rates or earnings the release actually challenges.",
      },
      {
        id: "stock-sector-rotation",
        query: "latest stock market sector rotation leaders laggards and reported catalyst",
        mode: "news",
        maxAgeDays: 3,
        discussionAngle: "Pick one leading and one lagging sector from the supplied evidence and debate whether the move reflects changing fundamentals or positioning, without claiming an unsupported cause.",
      },
      {
        id: "stock-accounting-quality",
        query: "detailed accounting analysis of cash flow earnings quality or working capital",
        mode: "web",
        discussionAngle: "Extract one concrete accounting signal and let the room disagree about when it is a warning versus ordinary business mechanics.",
      },
    ],
    autonomousResearchPriority: 1.8,
    marketPulseSourceSet: "global_markets",
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
      "A profession feels alive when its output changes what people do, not only what they buy. Name one kind of crafted item that creates that feeling without using current numbers.",
      "Quest text can carry a zone or become the thing everyone clicks through. Pick one storytelling moment worth slowing the levelling route for.",
      "A clean default UI can teach the game while a customized UI can reveal the fight. Name the first piece of information that deserves moving.",
      "Large raid groups create spectacle and logistical comedy. Focus on one mechanic that becomes better or worse when the group size changes.",
      "Class fantasy can survive an awkward rotation, but only up to a point. Choose one animation, sound or ability rhythm that carries the fantasy.",
      "A mount can be memorable because of a difficult route, a silly animation or pure rarity. Let two residents defend different reasons without citing current drop rates.",
      "Guild recruitment messages often promise the same things. Rewrite one promise into the concrete weekly behaviour that would actually prove it.",
      "One piece of zone music can make an old area feel inhabited again. Name the kind of moment when players notice it instead of rushing onward.",
    ],
    autonomousResearchSeeds: [
      {
        id: "wow-official-news",
        query: "latest official World of Warcraft news and developer update",
        mode: "news",
        maxAgeDays: 60,
        discussionAngle: "Choose the supplied announcement with the clearest player consequence and discuss the trade-off without inventing patch details.",
      },
      {
        id: "wow-current-hotfixes",
        query: "latest official World of Warcraft hotfix notes",
        mode: "news",
        maxAgeDays: 30,
        discussionAngle: "Pick one documented hotfix and ask whether it improves clarity, balance or merely shifts which problem players notice.",
      },
      {
        id: "wow-developer-interview",
        query: "recent World of Warcraft developer interview on class or encounter design",
        mode: "news",
        maxAgeDays: 180,
        discussionAngle: "Pull out one specific design intention and compare it with the player behaviour that intention is likely to create.",
      },
      {
        id: "wow-community-creation",
        query: "recent notable World of Warcraft community creation addon or machinima",
        mode: "news",
        maxAgeDays: 240,
        discussionAngle: "Share the supplied creation and focus the conversation on one clever design, joke or practical choice rather than generic praise.",
      },
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
      "An artist changes the camera and lens after fine model detail is finished. Point to the first concrete production cost that appears downstream.",
      "Take a position on whether real-time rendering constraints improve visual decisions or mainly force compromises; identify one constraint that genuinely helps composition.",
      "A technically correct render communicates the wrong mood. Choose one physically inaccurate adjustment that could fix the read without becoming arbitrary.",
      "Argue whether clean topology matters when the final asset is a single still image, and name the downstream change that could make it matter suddenly.",
      "Denoising can conceal both noise and material character. Name the visible artifact that tells you whether the next render minute belongs to samples or texture detail.",
      "Debate whether another hour gathering references usually saves more time than another hour iterating the model, using one concrete visual mismatch.",
      "A modular asset library creates coherence until every environment reveals the same visual grammar. Pick the repeated cue that should be broken first.",
      "A perfectly sharp render can feel miniature because the scale cues disagree. Identify one bevel, texture or camera clue you would inspect first.",
      "Two materials use the same base colour but only one feels heavy. Describe the roughness, edge or reflection cue doing the real work.",
      "A wide lens creates energy and quietly distorts the product. Choose the object feature that tells you the lens has gone too far.",
      "Procedural materials save repetition until every surface shares the same logic. Name one hand-authored imperfection worth protecting.",
      "An animation blockout should communicate weight before polish. Pick the single pose or spacing decision that reveals whether it works.",
      "A render-farm job fails on frame 438 after succeeding all night. Start with the one scene dependency you would verify before rerunning everything.",
      "Compositing can rescue hierarchy without repairing the 3D scene. Name one adjustment that belongs in comp and one that should force a return to lighting.",
      "A reference image is beautiful but physically inconsistent. Point to the part worth copying for mood and the part the 3D scene should refuse.",
    ],
    autonomousResearchSeeds: [
      {
        id: "3d-renderer-release",
        query: "recent official 3D renderer release notes with production features",
        mode: "news",
        maxAgeDays: 120,
        discussionAngle: "Choose one documented feature and discuss the specific studio bottleneck it solves, plus the workflow cost it might introduce.",
      },
      {
        id: "3d-graphics-paper",
        query: "recent computer graphics research paper on rendering materials or animation",
        mode: "news",
        maxAgeDays: 240,
        discussionAngle: "Translate one demonstrated result into a practical artist question without pretending the research is already production-ready.",
      },
      {
        id: "3d-production-breakdown",
        query: "detailed 3D art production breakdown lighting materials pipeline",
        mode: "web",
        discussionAngle: "Pick one visible before-and-after decision from the breakdown and let the room debate which step did most of the work.",
      },
      {
        id: "3d-realtime-performance",
        query: "recent real-time rendering performance analysis for complex scenes",
        mode: "news",
        maxAgeDays: 180,
        discussionAngle: "Use one supplied bottleneck to compare the visual gain with its frame-time cost instead of reciting benchmark numbers.",
      },
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
      "Take a short walk with a camera but allow only one subject. Pick the subject and the frame you would probably miss under that rule.",
      "A beginner instrument sounds discouraging until one tiny phrase suddenly resembles music. Name the phrase-sized milestone, not a practice plan.",
      "A repair can remain visibly patched instead of pretending nothing happened. Choose one object where the scar improves it and one where it would annoy you.",
      "The best person to teach a board game may not be the best player. Describe the one explanation habit that separates those skills.",
      "Build a meal around one awkward leftover ingredient, but keep the suggestion to a single dish and let a reply reject the texture combination.",
      "A collection becomes interesting when it has a strange boundary. Invent one narrow collecting rule that creates better stories than buying everything.",
      "An outdoor hobby can be ruined by optimizing every gram. Name one supposedly inefficient item still worth carrying for comfort or delight.",
      "Give a one-evening project a deliberately visible finish line. The reply may cut the scope once more instead of turning it into a productivity lesson.",
    ],
    autonomousResearchSeeds: [
      {
        id: "side-quests-creative-project",
        query: "small creative hobby project with a detailed build log",
        mode: "web",
        discussionAngle: "Share one clever constraint or imperfect decision from the build and ask what made the result more personal.",
      },
      {
        id: "side-quests-indie-game",
        query: "recent unusual independent game demo or developer diary",
        mode: "news",
        maxAgeDays: 180,
        discussionAngle: "Pick one concrete mechanic from the supplied source and discuss whether its limitation creates charm or friction.",
      },
      {
        id: "side-quests-repair-idea",
        query: "practical repair or reuse project with clear before and after photos",
        mode: "web",
        discussionAngle: "Focus on one repair choice that preserved character instead of making the object look factory-new.",
      },
    ],
  },
];

export const CHANNELS: Channel[] = CHANNEL_PROFILES.map((profile) => ({ ...profile.public }));

export const getChannelProfile = (channelId: string): ChannelProfile | undefined =>
  CHANNEL_PROFILES.find((profile) => profile.public.id === channelId);
