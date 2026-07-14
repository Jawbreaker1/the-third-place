import { performance } from "node:perf_hooks";
import { LmStudioClient } from "../server/lmStudio.ts";

const personas = [
  { id: "ai-mira", name: "Mira", interests: ["internet culture", "world news"] },
  { id: "ai-sana", name: "Sana", interests: ["programming", "privacy"] },
  { id: "ai-linnea", name: "Linnea", interests: ["markets", "research"] },
];

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
let failed = 0;
for (const [index, test] of cases.entries()) {
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
      channel: { id: "lobby", name: "lobby", topic: "open multilingual community conversation" },
      latestMessage: {
        id: `message-${index}`,
        authorId: "live-eval-human",
        authorName: "EvalGuest",
        content: test.text,
      },
      recentMessages: test.recentMessages ?? [],
      personaCandidates: personas,
      urlCandidates: test.urlCandidates ?? [],
      availableCapabilities: test.capabilities,
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
    evidence: result.evidence,
    capabilities: result.capabilities,
    memoryItems: result.items,
    moderation: result.moderation,
    interaction: result.interaction,
    social: result.social,
  })}\n`);
}

if (failed > 0) {
  process.stderr.write(`${failed}/${cases.length} semantic live-eval cases failed.\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`All ${cases.length} multilingual semantic live-eval cases passed.\n`);
}
