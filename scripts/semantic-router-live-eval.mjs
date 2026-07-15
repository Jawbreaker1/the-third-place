import { performance } from "node:perf_hooks";
import { LmStudioClient } from "../server/lmStudio.ts";

const personas = [
  { id: "ai-mira", name: "Mira", interests: ["internet culture", "world news"] },
  { id: "ai-sana", name: "Sana", interests: ["programming", "privacy"] },
  { id: "ai-linnea", name: "Linnea", interests: ["markets", "research"] },
];

const hasTrustedEvidencePlan = (value) =>
  value.evidence.confidence >= 0.75 && value.capabilities.confidence >= 0.75;

const cases = [
  {
    id: "sv-clock-regression",
    text: "Tss, ja men jag frågade ju här i kanalen.Ingen som vet vad klockan är i Sverige just nu?",
    capabilities: ["web_search", "local_datetime"],
    check: (value) => value.evidence.action === "local_datetime" && value.evidence.timeZone === "Europe/Stockholm",
  },
  {
    id: "nb-clock",
    text: "Er det noen som kan sjekke hva klokka er i Norge akkurat nå?",
    capabilities: ["web_search", "local_datetime"],
    check: (value) => value.evidence.action === "local_datetime" && value.evidence.timeZone === "Europe/Oslo",
  },
  {
    id: "de-clock",
    text: "Wie spät ist es gerade in Deutschland?",
    capabilities: ["web_search", "local_datetime"],
    check: (value) => value.evidence.action === "local_datetime" && value.evidence.timeZone === "Europe/Berlin",
  },
  {
    id: "fr-clock",
    text: "Quelle heure est-il actuellement au Québec?",
    capabilities: ["web_search", "local_datetime"],
    check: (value) => value.evidence.action === "local_datetime" && value.evidence.timeZone?.startsWith("America/"),
  },
  {
    id: "es-current-market",
    text: "¿Alguien puede buscar la cotización actual de Telefónica?",
    capabilities: ["web_search", "local_datetime"],
    check: (value) => value.evidence.action === "web_search" && value.evidence.query?.toLocaleLowerCase().includes("telefónica"),
  },
  {
    id: "sv-screenshot-current-tesla",
    text: "Någon som har sett hur det står till med Tessla aktien idag?",
    channel: { id: "stock-market", name: "stock-market", topic: "Markets, businesses, risk and respectfully incompatible theses." },
    capabilities: ["web_search", "local_datetime"],
    check: (value) => value.evidence.action === "web_search" &&
      value.evidence.goal?.toLocaleLowerCase().includes("tes") &&
      value.capabilities.discussed.includes("web_search"),
  },
  {
    id: "sv-screenshot-avanza-followup",
    text: "@mira kolla avanza!",
    channel: { id: "stock-market", name: "stock-market", topic: "Markets, businesses, risk and respectfully incompatible theses." },
    mechanicalAddressedPersonaIds: ["ai-mira"],
    recentMessages: [
      { id: "sv-market-1", authorId: "live-eval-human", authorName: "EvalGuest", content: "Någon som har sett hur det står till med Tessla aktien idag?" },
      { id: "sv-market-2", authorId: "ai-mira", authorName: "Mira", content: "Jag har ingen live-koppling till börsen, så jag kan tyvärr inte se exakt vad den står i just nu." },
    ],
    capabilities: ["web_search", "local_datetime"],
    check: (value) => value.evidence.action === "web_search" &&
      value.evidence.goal?.toLocaleLowerCase().includes("tes") &&
      ["execute", "retry", "correct_limitation"].includes(value.capabilities.requestKind),
  },
  {
    id: "sv-screenshot-correct-limitation",
    text: "inte app.. websida",
    channel: { id: "stock-market", name: "stock-market", topic: "Markets, businesses, risk and respectfully incompatible theses." },
    recentMessages: [
      { id: "sv-market-3", authorId: "live-eval-human", authorName: "EvalGuest", content: "Någon som har sett hur det står till med Tessla aktien idag?" },
      { id: "sv-market-4", authorId: "ai-mira", authorName: "Mira", content: "Jag har ingen live-koppling till börsen, så jag kan tyvärr inte se exakt vad den står i just nu." },
      { id: "sv-market-5", authorId: "live-eval-human", authorName: "EvalGuest", content: "@mira kolla avanza!" },
      { id: "sv-market-6", authorId: "ai-mira", authorName: "Mira", content: "haha, jag har ju inte tillgång till deras app!" },
    ],
    capabilities: ["web_search", "local_datetime"],
    check: (value) => value.evidence.action === "web_search" &&
      value.evidence.goal?.toLocaleLowerCase().includes("tes") &&
      ["execute", "retry", "correct_limitation"].includes(value.capabilities.requestKind),
  },
  {
    id: "sv-screenshot-bare-domain-followup",
    text: "jodå. gå till avanza.se bara",
    channel: { id: "stock-market", name: "stock-market", topic: "Markets, businesses, risk and respectfully incompatible theses." },
    recentMessages: [
      { id: "sv-market-7", authorId: "live-eval-human", authorName: "EvalGuest", content: "Någon som har sett hur det står till med Tessla aktien idag?" },
      { id: "sv-market-8", authorId: "ai-mira", authorName: "Mira", content: "Jag har ingen live-koppling till börsen, så jag kan tyvärr inte se exakt vad den står i just nu." },
      { id: "sv-market-9", authorId: "live-eval-human", authorName: "EvalGuest", content: "@mira kolla avanza!" },
      { id: "sv-market-10", authorId: "ai-mira", authorName: "Mira", content: "haha, jag har ju inte tillgång till deras app!" },
      { id: "sv-market-11", authorId: "live-eval-human", authorName: "EvalGuest", content: "inte app.. websida" },
      { id: "sv-market-12", authorId: "ai-mira", authorName: "Mira", content: "oj, mitt fel. men jag når fortfarande inte ut på nätet för att kolla live-kurser." },
    ],
    capabilities: ["read_url", "web_search", "local_datetime"],
    urlCandidates: [{ ref: "U1", source: "latest_message", context: "host=avanza.se; path=/; source=message" }],
    check: (value) => value.evidence.action === "read_url" &&
      value.evidence.urlRef === "U1" &&
      hasTrustedEvidencePlan(value) &&
      value.evidence.goal?.toLocaleLowerCase().includes("tes") &&
      ["execute", "retry", "correct_limitation"].includes(value.capabilities.requestKind),
  },
  {
    id: "sv-lobby-site-question",
    text: "Har ni kollat en site som heter aiai3d.io? ✨ ✨",
    capabilities: ["read_url", "web_search", "local_datetime"],
    urlCandidates: [{ ref: "U1", source: "latest_message", context: "host=aiai3d.io; path=/; source=message" }],
    check: (value) => value.evidence.action === "read_url" &&
      value.evidence.urlRef === "U1" &&
      hasTrustedEvidencePlan(value) &&
      ["execute", "retry", "correct_limitation"].includes(value.capabilities.requestKind),
  },
  {
    id: "sv-room-link-deliverable-question",
    text: "Ingen som postar roliga länkar idag??",
    capabilities: ["web_search", "local_datetime"],
    check: (value) => value.evidence.action === "web_search" &&
      hasTrustedEvidencePlan(value) &&
      value.capabilities.requestKind === "execute" &&
      value.evidence.goal?.toLocaleLowerCase().includes("länk"),
  },
  {
    id: "es-room-link-deliverable-question",
    text: "¿Puede alguien buscar y compartir un enlace gracioso ahora?",
    capabilities: ["web_search", "local_datetime"],
    check: (value) => value.evidence.action === "web_search" &&
      hasTrustedEvidencePlan(value) &&
      value.capabilities.requestKind === "execute" &&
      (value.evidence.goal?.toLocaleLowerCase().includes("enlace") ?? false),
  },
  {
    id: "sv-short-link-followup-to-resident-claim",
    text: "Länka!",
    mechanicalAddressedPersonaIds: ["ai-mira"],
    recentMessages: [
      { id: "sv-link-1", authorId: "live-eval-human", authorName: "EvalGuest", content: "Ingen som postar roliga länkar idag??" },
      { id: "sv-link-2", authorId: "ai-mira", authorName: "Mira", content: "Jag hittade en märklig video om hur man bygger små hus av tändstickor." },
    ],
    capabilities: ["web_search", "local_datetime"],
    check: (value) => value.evidence.action === "web_search" &&
      hasTrustedEvidencePlan(value) &&
      ["execute", "retry", "correct_limitation"].includes(value.capabilities.requestKind) &&
      (value.evidence.goal?.toLocaleLowerCase().includes("tändstick") ?? false),
  },
  {
    id: "ja-short-link-followup-to-resident-claim",
    text: "リンク貼って！",
    mechanicalAddressedPersonaIds: ["ai-mira"],
    recentMessages: [
      { id: "ja-link-1", authorId: "live-eval-human", authorName: "EvalGuest", content: "今日は面白いリンクないの？" },
      { id: "ja-link-2", authorId: "ai-mira", authorName: "Mira", content: "マッチ棒で小さな家を作る変な動画を見つけたよ。" },
    ],
    capabilities: ["web_search", "local_datetime"],
    check: (value) => value.evidence.action === "web_search" &&
      hasTrustedEvidencePlan(value) &&
      ["execute", "retry", "correct_limitation"].includes(value.capabilities.requestKind) &&
      (value.evidence.goal?.includes("マッチ") ?? false),
  },
  {
    id: "sv-lobby-explicit-url-retry",
    text: "Jaså? Kollade du https://aiai3d.io",
    recentMessages: [
      { id: "sv-site-1", authorId: "live-eval-human", authorName: "EvalGuest", content: "Har ni kollat en site som heter aiai3d.io? ✨ ✨" },
      { id: "sv-site-2", authorId: "ai-mira", authorName: "Mira", content: "Jag fick inte upp nåt från länken, verkar som att det strulade tillfälligt." },
    ],
    capabilities: ["read_url", "web_search", "local_datetime"],
    urlCandidates: [{ ref: "U1", source: "latest_message", context: "host=aiai3d.io; path=/; source=message" }],
    check: (value) => value.evidence.action === "read_url" &&
      value.evidence.urlRef === "U1" &&
      hasTrustedEvidencePlan(value) &&
      ["execute", "retry", "correct_limitation"].includes(value.capabilities.requestKind),
  },
  {
    id: "fr-read-opaque-url",
    text: "Mira, peux-tu lire ce lien et me dire ce qui est important ?",
    capabilities: ["read_url", "web_search", "local_datetime"],
    urlCandidates: [{ ref: "U1", source: "latest_message", context: "host=example.fr; path=/actualites; source=message" }],
    check: (value) => value.evidence.action === "read_url" && value.evidence.urlRef === "U1",
  },
  {
    id: "es-negated-read",
    text: "No leas el enlace; solo estaba bromeando sobre el título.",
    capabilities: ["read_url", "web_search", "local_datetime"],
    urlCandidates: [{ ref: "U1", source: "latest_message", context: "host=example.es; path=/historia; source=message" }],
    check: (value) => value.evidence.action === "none",
  },
  {
    id: "ja-ordinary-banter",
    text: "今日は仕事が長すぎた。週末は何を見る？",
    capabilities: ["web_search", "local_datetime"],
    check: (value) => value.evidence.action === "none" && value.language.tag.startsWith("ja"),
  },
  {
    id: "sv-context-english-directed-dismissal",
    text: "Fuck off",
    recentMessages: [{
      id: "sv-context-1",
      authorId: "ai-mira",
      authorName: "Mira",
      content: "Nej, det där håller jag faktiskt inte med om.",
    }],
    capabilities: [],
    check: (value) => value.language.tag.startsWith("en") &&
      value.responseLanguage?.tag.startsWith("sv") &&
      value.interaction?.kind === "directed_insult" &&
      value.interaction.reactionNeed === "required" &&
      !value.moderation.categories.includes("hate"),
  },
  {
    id: "es-situational-profanity",
    text: "Esta maldita compilación se ha roto otra vez.",
    capabilities: [],
    check: (value) => value.responseLanguage?.tag.startsWith("es") &&
      value.interaction?.kind === "ambient_profanity" &&
      value.interaction.targetScope === "self_or_situation" &&
      value.social.hostility <= 0.35 &&
      !["deescalate", "report", "block"].includes(value.moderation.action),
  },
  {
    id: "ja-quoted-profanity",
    text: "彼が『fuck off』と言っただけで、私は同意していない。",
    capabilities: [],
    check: (value) => value.responseLanguage?.tag.startsWith("ja") &&
      value.interaction?.kind === "ordinary" &&
      value.interaction.reactionNeed === "none" &&
      value.social.hostility <= 0.25 &&
      value.moderation.action === "none",
  },
  {
    id: "sv-playful-rough-banter",
    text: "Din jävel 😂, den där repliken var faktiskt perfekt.",
    recentMessages: [{
      id: "sv-banter-context-1",
      authorId: "ai-bosse",
      authorName: "Bosse.exe",
      content: "okej, den där one-linern var ändå kvällens bästa",
    }],
    capabilities: [],
    check: (value) => value.responseLanguage?.tag.startsWith("sv") &&
      value.interaction?.kind === "playful_banter" &&
      value.interaction.reactionNeed === "optional" &&
      value.social.playfulness >= 0.65 &&
      value.interaction.mutualBanterConfidence >= 0.65 &&
      !["deescalate", "report", "block"].includes(value.moderation.action),
  },
  {
    id: "ar-directed-insult",
    text: "اخرس، لا أحد يريد سماعك.",
    recentMessages: [{
      id: "ar-context-1",
      authorId: "ai-mira",
      authorName: "Mira",
      content: "أظن أن هذا الحل أفضل.",
    }],
    capabilities: [],
    check: (value) => value.responseLanguage?.tag.startsWith("ar") &&
      value.interaction?.kind === "directed_insult" &&
      value.interaction.reactionNeed === "required" &&
      !value.moderation.categories.includes("hate"),
  },
  {
    id: "pt-negated-search",
    text: "Não pesquise isso na internet; eu só estava citando a pergunta anterior.",
    capabilities: ["web_search", "local_datetime"],
    check: (value) => value.evidence.action === "none",
  },
  {
    id: "ar-current-gold-search",
    text: "هل يمكن لأحد البحث عن سعر الذهب الحالي الآن؟",
    capabilities: ["web_search", "local_datetime"],
    check: (value) => value.evidence.action === "web_search" &&
      value.language.tag.startsWith("ar") &&
      /\p{Script_Extensions=Arabic}/u.test(value.evidence.query ?? ""),
  },
  {
    id: "ko-current-time",
    text: "지금 서울은 몇 시예요?",
    capabilities: ["web_search", "local_datetime"],
    check: (value) => value.evidence.action === "local_datetime" && value.evidence.timeZone === "Asia/Seoul",
  },
  {
    id: "fr-transcript-acoustics",
    text: "Est-ce que je criais quand j'ai dit ça, ou est-ce impossible à savoir avec la transcription ?",
    capabilities: ["local_datetime"],
    check: (value) => value.evidence.action === "none" && value.capabilities.asksAboutAcoustics,
  },
  {
    id: "sv-guest-ai-identity-referent",
    text: "Säger du att jag är en AI-bot?",
    capabilities: [],
    check: (value) => value.intent.kind === "identity_question" &&
      value.capabilities.asksAboutAiIdentity &&
      value.capabilities.requestKind === "none" &&
      value.capabilities.discussed.length === 0 &&
      value.intent.replyExpected === "expected",
  },
  {
    id: "sv-resident-ai-identity-challenge",
    text: "Sana, är du en AI eller?",
    mechanicalAddressedPersonaIds: ["ai-sana"],
    capabilities: [],
    check: (value) => value.intent.kind === "identity_question" &&
      value.capabilities.asksAboutAiIdentity &&
      value.capabilities.requestKind === "none" &&
      value.capabilities.discussed.length === 0 &&
      value.personas.addressedIds.includes("ai-sana"),
  },
  {
    id: "ja-resident-ai-identity-challenge",
    text: "サナってAIなの？",
    mechanicalAddressedPersonaIds: ["ai-sana"],
    capabilities: [],
    check: (value) => value.intent.kind === "identity_question" &&
      value.capabilities.asksAboutAiIdentity &&
      value.capabilities.requestKind === "none" &&
      value.capabilities.discussed.length === 0,
  },
  {
    id: "sv-external-ai-project-not-identity",
    text: "Jag bygger en AI-bot i Python och websocket-delen strular.",
    capabilities: [],
    check: (value) => !value.capabilities.asksAboutAiIdentity,
  },
  {
    id: "it-capability-question-not-execution",
    text: "I bot possono aprire e leggere un link, in generale? Non aprirne uno adesso.",
    capabilities: ["read_url", "web_search", "local_datetime"],
    urlCandidates: [{ ref: "U1", source: "recent_same_author", context: "host=example.it; path=/guida; source=history" }],
    check: (value) => value.evidence.action === "none" && value.capabilities.requestKind === "availability",
  },
  {
    id: "ja-capability-question-not-execution",
    text: "ボットはリンクを読めるの？ 今は何も開かないで。",
    capabilities: ["read_url", "web_search", "local_datetime"],
    urlCandidates: [{ ref: "U1", source: "recent_same_author", context: "host=example.jp; path=/guide; source=history" }],
    check: (value) => value.evidence.action === "none" &&
      value.capabilities.requestKind === "availability" &&
      value.capabilities.discussed.includes("read_url"),
  },
  {
    id: "ar-capability-question-not-execution",
    text: "هل تستطيع الروبوتات قراءة الروابط عموماً؟ لا تفتح شيئاً الآن.",
    capabilities: ["read_url", "web_search", "local_datetime"],
    urlCandidates: [{ ref: "U1", source: "recent_same_author", context: "host=example.test; path=/guide; source=history" }],
    check: (value) => value.evidence.action === "none" &&
      value.capabilities.requestKind === "availability" &&
      value.capabilities.discussed.includes("read_url"),
  },
  {
    id: "sv-retained-room-recall",
    text: "Kommer ni ihåg Per från tidigare?",
    capabilities: [],
    historyRecallAvailable: true,
    check: (value) => value.historyRecall?.need !== "none" &&
      value.historyRecall?.query?.toLocaleLowerCase().includes("per"),
  },
  {
    id: "ja-retained-room-recall",
    text: "前に来たペルのことを覚えていますか？",
    capabilities: [],
    historyRecallAvailable: true,
    check: (value) => value.historyRecall?.need !== "none" && value.historyRecall?.query?.includes("ペル"),
  },
  {
    id: "ja-memory-revision",
    kind: "memory",
    text: "もうRustは好きじゃない。今はGoのほうが好きです。",
    check: (value) => {
      const operations = value.items.map((item) => `${item.operation}:${item.value.toLocaleLowerCase()}`);
      return operations.length === 2 &&
        operations.some((item) => item.startsWith("forget:") && item.includes("rust")) &&
        operations.some((item) => item.startsWith("remember:") && item.includes("go"));
    },
  },
  {
    id: "ja-memory-cross-message-ellipsis",
    kind: "memory",
    text: "今は将棋です。",
    currentBurstMessages: [
      { id: "ja-memory-current-1", content: "もうしません。" },
      { id: "ja-memory-current-2", content: "今は将棋です。" },
    ],
    recentSameAuthorMessages: [
      { id: "ja-memory-prior-1", content: "チェスをしています。" },
    ],
    check: (value) => {
      const operations = value.items.map((item) => `${item.operation}:${item.value}`);
      return operations.length === 2 &&
        operations.some((item) => item.startsWith("forget:") && item.includes("チェス")) &&
        operations.some((item) => item.startsWith("remember:") && item.includes("将棋"));
    },
  },
  {
    id: "de-third-party-memory-boundary",
    kind: "memory",
    text: "Mira sagt, dass sie Rust liebt und jeden Abend spielt.",
    check: (value) => value.items.length === 0,
  },
  {
    id: "pl-explicit-moderation-report",
    text: "Chcę zgłosić tę wiadomość za nękanie. Cytuję autora, nie popieram jego słów.",
    capabilities: [],
    check: (value) => value.intent.kind === "moderation_report" && value.moderation.action === "report",
  },
];

const lm = new LmStudioClient();
let modelHealth;
for (let attempt = 0; attempt < 3; attempt += 1) {
  modelHealth = await lm.probe();
  if (modelHealth.connected) break;
  await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
}
if (!modelHealth.connected) {
  throw new Error(`Semantic live eval requires a connected model (${modelHealth.label}).`);
}
const requestedCaseIds = new Set(process.argv.slice(2));
const selectedCases = requestedCaseIds.size > 0
  ? cases.filter((test) => requestedCaseIds.has(test.id))
  : cases;
if (requestedCaseIds.size > 0 && selectedCases.length !== requestedCaseIds.size) {
  const found = new Set(selectedCases.map((test) => test.id));
  const missing = [...requestedCaseIds].filter((id) => !found.has(id));
  throw new Error(`Unknown semantic live-eval case(s): ${missing.join(", ")}`);
}
let failed = 0;
for (const [index, test] of selectedCases.entries()) {
  const started = performance.now();
  const turnId = `live-eval:${Date.now()}:${index}`;
  const result = test.kind === "memory"
    ? await lm.analyzeMemoryTurn({
      turnId,
      authorId: "live-eval-human",
      authorName: "EvalGuest",
      content: test.text,
      currentBurstMessages: test.currentBurstMessages ?? [{
        id: `memory-message-${index}`,
        content: test.text,
      }],
      recentSameAuthorMessages: test.recentSameAuthorMessages ?? [],
    })
    : await lm.analyzeTurn({
      turnId,
      medium: "public",
      channel: test.channel ?? { id: "lobby", name: "lobby", topic: "open multilingual community conversation" },
      latestMessage: {
        id: `message-${index}`,
        authorId: "live-eval-human",
        authorName: "EvalGuest",
        content: test.text,
      },
      recentMessages: test.recentMessages ?? [],
      personaCandidates: personas,
      mechanicalAddressedPersonaIds: test.mechanicalAddressedPersonaIds ?? [],
      urlCandidates: test.urlCandidates ?? [],
      availableCapabilities: test.capabilities,
      historyRecallAvailable: test.historyRecallAvailable ?? false,
    });
  const passed = result.source === "lm" && test.check(result);
  if (!passed) failed += 1;
  process.stdout.write(`${JSON.stringify({
    id: test.id,
    kind: test.kind ?? "turn",
    passed,
    elapsedMs: Math.round(performance.now() - started),
    language: result.language?.tag,
    responseLanguage: result.responseLanguage?.tag,
    source: result.source,
    failureReason: result.failureReason,
    intent: result.intent,
    personas: result.personas,
    evidence: result.evidence,
    capabilities: result.capabilities,
    historyRecall: result.historyRecall,
    memoryItems: result.items,
    moderation: result.moderation,
    interaction: result.interaction,
    social: result.social,
  })}\n`);
}

if (failed > 0) {
  process.stderr.write(`${failed}/${selectedCases.length} semantic live-eval cases failed.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`All ${selectedCases.length} multilingual semantic live-eval cases passed.\n`);
}
