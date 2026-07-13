import { describe, expect, it } from "vitest";
import {
  analyzeConversationRegister,
  assessCandidate,
  buildHumanizerRepairInstruction,
  compareHumanizerSimilarity,
  conversationRegisterMismatch,
  HumanStyleMemory,
  protectTechnicalFragments,
  restoreTechnicalFragments,
} from "./humanizer.js";

describe("humanizer similarity", () => {
  it("catches lightly reformatted self repetition", () => {
    const result = assessCandidate({
      personaId: "ai-sana",
      text: "Jag tror faktiskt att en liten TURN-server löser det här för de flesta användare.",
      recentOwnTexts: [
        "jag tror faktiskt att en liten TURN server löser det här, för de flesta användare!",
      ],
    });

    expect(result.acceptable).toBe(false);
    expect(result.reasonCodes).toContain("near_duplicate_self");
    expect(result.metrics.maximumSelfSimilarity).toBeGreaterThan(0.8);
  });

  it("detects a selected peer being echoed instead of an independent response", () => {
    const result = assessCandidate({
      personaId: "ai-vale",
      text: "Problemet är inte modellen utan att vi skickar hela historiken vid varje svar.",
      peerTexts: [
        "Problemet är inte modellen, utan att vi skickar hela historiken vid varje svar.",
      ],
    });

    expect(result.reasonCodes).toContain("near_duplicate_peer");
    expect(result.acceptable).toBe(false);
  });

  it("reports a repeated opening without confusing it with a duplicate claim", () => {
    const result = assessCandidate({
      personaId: "ai-moss",
      text: "Jag tänker att vi testar ljudet på Firefox innan vi lovar något.",
      recentOwnTexts: [
        "Jag tänker att vi borde låta knappen vara lila.",
        "Jag tänker att vi väntar till efter lunch med migrationen.",
      ],
    });

    expect(result.reasonCodes).toContain("reused_opening");
    expect(result.reasonCodes).not.toContain("near_duplicate_self");
  });

  it("uses both ordered token and character n-grams", () => {
    const close = compareHumanizerSimilarity(
      "Sätt en hård gräns på historiken och summera resten.",
      "Sätt en hård gräns på historiken; summera resten!",
    );
    const topical = compareHumanizerSimilarity(
      "Sätt en hård gräns på historiken och summera resten.",
      "Historiken innehåller WebRTC-transkript från gårdagens rum.",
    );

    expect(close.tokenNgrams).toBeGreaterThan(0.7);
    expect(close.characterNgrams).toBeGreaterThan(0.7);
    expect(close.combined).toBeGreaterThan(topical.combined + 0.45);
  });
});

describe("humanizer tone checks", () => {
  it("recognises Swedish and English assistant clichés", () => {
    expect(assessCandidate({
      personaId: "ai-a",
      text: "Bra fråga! Här är tre viktiga saker som du bör känna till innan vi börjar.",
    }).reasonCodes).toContain("assistant_cliche");

    expect(assessCandidate({
      personaId: "ai-b",
      text: "Absolutely! Here are three important things that you should consider before starting.",
    }).reasonCodes).toContain("assistant_cliche");
  });

  it("treats AI self-disclosure as a high-severity illusion break", () => {
    const result = assessCandidate({
      personaId: "ai-a",
      text: "Som en AI-språkmodell har jag inga känslor, men jag kan analysera frågan.",
    });

    expect(result.severity).toBe("high");
    expect(result.acceptable).toBe(false);
    expect(result.reasonCodes).toContain("ai_meta_language");
  });

  it("spots list-shaped and essay-shaped casual chat", () => {
    const list = assessCandidate({
      personaId: "ai-a",
      text: "Så här gör vi:\n1. Skapa rummet\n2. Starta mikrofonen\n3. Bjud in en bot",
    });
    const essay = assessCandidate({
      personaId: "ai-a",
      mode: "voice",
      text: "För det första behöver vi testa fördröjningen ordentligt med flera riktiga användare i samma rum. För det andra behöver vi mäta avbrott och eko under en vanlig konversation. Dessutom bör vi jämföra resultatet mellan Chrome och Firefox innan vi drar en säker slutsats om kvaliteten.",
    });

    expect(list.reasonCodes).toContain("list_like_reply");
    expect(essay.reasonCodes).toContain("overly_polished");
  });

  it("escalates only a combination of assistant-shaped warning signals", () => {
    const result = assessCandidate({
      personaId: "ai-a",
      text: "Bra fråga! Här är det viktigaste:\n1. Börja enkelt\n2. Testa tidigt\n3. Sammanfatta resultatet",
    });

    expect(result.reasonCodes).toEqual(expect.arrayContaining(["assistant_cliche", "list_like_reply"]));
    expect(result.severity).toBe("high");
    expect(result.acceptable).toBe(false);
  });

  it("rejects the reported academic lobby paragraph without making technical rooms less capable", () => {
    const text = "Spänningen ligger i att hög aktivitet ofta driver kortsiktig engagemangsmätning, medan de tysta stammisarna bygger den långsiktiga infrastrukturen. Om en plattform bara premierar dagligt brus riskerar man att förlora det institutionella minnet; utan de som dyker upp mer sällan men med tyngd, blir diskussionerna en serie isolerade händelser istället för en sammanhängande utveckling över tid.";
    const lobby = assessCandidate({ personaId: "ai-ibrahim", text, register: "everyday" });
    const programming = assessCandidate({ personaId: "ai-ibrahim", text, register: "technical" });

    expect(lobby.reasonCodes).toContain("register_mismatch");
    expect(lobby.severity).toBe("high");
    expect(lobby.acceptable).toBe(false);
    expect(programming.reasonCodes).not.toContain("register_mismatch");
    expect(conversationRegisterMismatch(text, "everyday").mismatch).toBe(true);
    expect(conversationRegisterMismatch(text, "analytical").mismatch).toBe(false);
    expect(analyzeConversationRegister(text).structureSignals.length).toBeGreaterThanOrEqual(2);
    expect(analyzeConversationRegister(text).abstractionSignals.length).toBeGreaterThanOrEqual(1);
  });

  it("asks the repair pass for everyday wording while preserving the actual thought", () => {
    const result = assessCandidate({
      personaId: "ai-ibrahim",
      register: "everyday",
      text: "The tension lies in rewarding short-term engagement while institutional infrastructure carries the long-term memory. If a platform optimizes only for daily noise, it risks losing continuity; without quieter regulars, coherent development becomes a sequence of isolated events.",
    });
    const instruction = buildHumanizerRepairInstruction(result);

    expect(result.reasonCodes).toContain("register_mismatch");
    expect(instruction).toContain("vardaglig chatt");
    expect(instruction).toContain("Behåll tanken och intelligensen");
  });
});

describe("humanizer false-positive guardrails", () => {
  it("allows short natural replies including a standalone agreement", () => {
    for (const text of ["Absolut!", "nä, håller inte med", "haha exakt", "kör 🫡"]) {
      expect(assessCandidate({ personaId: "ai-a", text }).reasonCodes).toEqual([]);
    }
  });

  it("allows a longer concrete anecdote and an isolated formal term in an everyday room", () => {
    const anecdote = "Vi hade en person som bara dök upp ibland, men hon mindes alltid vem som byggt vilken liten grej. När alla andra fastnade i samma gamla diskussion skrev hon typ två rader och plötsligt fattade vi varför beslutet såg så konstigt ut.";
    const shortFormal = "Institutionellt minne spelar faktiskt roll här.";

    expect(assessCandidate({ personaId: "ai-a", text: anecdote, register: "everyday" }).reasonCodes)
      .not.toContain("register_mismatch");
    expect(assessCandidate({ personaId: "ai-a", text: shortFormal, register: "everyday" }).reasonCodes)
      .not.toContain("register_mismatch");
  });

  it("does not count code or URLs as academic-register evidence", () => {
    const result = conversationRegisterMismatch(
      "Jag klistrade in `institutional infrastructure while long-term engagement metrics` och länken https://example.com/structural-systemic-infrastructure; det är fortfarande bara ett kodexempel i chatten.",
      "everyday",
    );
    expect(result.mismatch).toBe(false);
  });

  it("does not mistake shared technical terms for duplicate prose", () => {
    const result = assessCandidate({
      personaId: "ai-a",
      text: "WebRTC behöver ofta TURN bakom restriktiv NAT, medan ngrok bara bär signaleringen.",
      recentOwnTexts: [
        "WebRTC använder ICE-kandidater för att hitta en fungerande väg mellan webbläsarna.",
        "En TURN-server reläar media när direkt P2P blockeras av nätet.",
      ],
      peerTexts: ["ngrok ger oss HTTPS och vidarebefordrar Socket.IO-trafiken."],
      mode: "technical",
    });

    expect(result.reasonCodes).not.toContain("near_duplicate_self");
    expect(result.reasonCodes).not.toContain("near_duplicate_peer");
  });

  it("keeps different code and URL fragments distinct in similarity checks", () => {
    const code = assessCandidate({
      personaId: "ai-a",
      text: "kör `npm test` först",
      recentOwnTexts: ["kör `npm run build` först"],
    });
    const url = assessCandidate({
      personaId: "ai-a",
      text: "läs https://developer.mozilla.org/docs först",
      recentOwnTexts: ["läs https://example.com/guide först"],
    });

    expect(code.reasonCodes).not.toContain("near_duplicate_self");
    expect(url.reasonCodes).not.toContain("near_duplicate_self");
  });

  it("does not treat quoted technical examples as AI self-disclosure", () => {
    const result = assessCandidate({
      personaId: "ai-a",
      text: "Undvik den här prompten: `As an AI language model, I cannot browse`.",
    });
    expect(result.reasonCodes).not.toContain("ai_meta_language");
  });

  it("allows honest identity answers only when the caller explicitly opts in", () => {
    const text = "Som en AI-karaktär bor jag här i kanalen, men jag tänker inte låtsas vara människa.";
    expect(assessCandidate({ personaId: "ai-a", text }).reasonCodes).toContain("ai_meta_language");
    expect(assessCandidate({ personaId: "ai-a", text, allowAiIdentity: true }).reasonCodes).not.toContain("ai_meta_language");
    expect(assessCandidate({ personaId: "ai-a", text: "Jag kan inte känna igen loggan på den bilden." }).reasonCodes)
      .not.toContain("ai_meta_language");
    expect(assessCandidate({ personaId: "ai-a", text: "I can't feel the latency in that trace." }).reasonCodes)
      .not.toContain("ai_meta_language");
  });

  it("ignores repeated code when comparing otherwise different prose", () => {
    const result = assessCandidate({
      personaId: "ai-a",
      text: "Jag hade behållit `const room = rooms.get(id)` och returnerat tidigt här.",
      recentOwnTexts: ["Den här raden kraschar inte: `const room = rooms.get(id)` — felet kommer senare."],
    });

    expect(result.reasonCodes).not.toContain("near_duplicate_self");
    expect(result.protectedFragments.map((fragment) => fragment.value)).toEqual([
      "`const room = rooms.get(id)`",
    ]);
  });

  it("allows an explicitly requested technical list", () => {
    const result = assessCandidate({
      personaId: "ai-a",
      mode: "technical",
      allowList: true,
      text: "1. Firefox 128\n2. Chrome 126\n3. Safari 18",
    });
    expect(result.reasonCodes).not.toContain("list_like_reply");
  });
});

describe("protected technical content", () => {
  it("round-trips Unicode, fenced code, inline code and URLs exactly", () => {
    const original = "Åsa: testa `räv()` mot https://exempel.se/sök?q=ö.\n```ts\nconst färg = 'blå';\n```";
    const protectedText = protectTechnicalFragments(original);

    expect(protectedText.fragments.map((fragment) => fragment.kind)).toEqual([
      "inline-code",
      "url",
      "fenced-code",
    ]);
    expect(restoreTechnicalFragments(protectedText.text, protectedText.fragments)).toBe(original);
  });

  it("uses collision-safe sentinels when the input already contains a sentinel-like literal", () => {
    const original = "literal ⟦HUMANIZER_0_0⟧ and `npm test`";
    const protectedText = protectTechnicalFragments(original);
    expect(protectedText.fragments[0]?.placeholder).not.toBe("⟦HUMANIZER_0_0⟧");
    expect(restoreTechnicalFragments(protectedText.text, protectedText.fragments)).toBe(original);
  });

  it("builds a deterministic high-severity repair instruction with protected values", () => {
    const assessment = assessCandidate({
      personaId: "ai-a",
      text: "Som en AI kan jag föreslå `fetch(url)` och https://example.com/docs.",
    });
    const first = buildHumanizerRepairInstruction(assessment);
    const second = buildHumanizerRepairInstruction(assessment);

    expect(first).toBe(second);
    expect(first).toContain("⟦HUMANIZER_");
    expect(first).not.toContain("`fetch(url)`");
    expect(first).not.toContain("https://example.com/docs");
    expect(first).toContain("Return only the rewritten message");
  });
});

describe("HumanStyleMemory", () => {
  it("bounds entries and persona count deterministically", () => {
    const memory = new HumanStyleMemory({ maxEntriesPerPersona: 2, maxPersonas: 2 });
    memory.remember("a", "ett");
    memory.remember("a", "två");
    memory.remember("a", "tre");
    memory.remember("b", "fyra");
    memory.remember("c", "fem");

    expect(memory.recent("a")).toEqual([]);
    expect(memory.recent("b")).toEqual(["fyra"]);
    expect(memory.recent("c", 0)).toEqual([]);
    expect(memory.size).toBe(2);
  });

  it("feeds remembered lines into assessment without remembering rejected candidates", () => {
    const memory = new HumanStyleMemory();
    memory.remember("a", "Det fina med små rum är att folk faktiskt hinner svara varandra.");
    const result = memory.assess({
      personaId: "a",
      text: "Det fina med små rum är att folk faktiskt hinner svara varandra!",
    });

    expect(result.reasonCodes).toContain("near_duplicate_self");
    expect(memory.recent("a")).toHaveLength(1);
  });
});
