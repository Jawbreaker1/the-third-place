// Independent, frozen holdout data for the shadow factual reviewer.
// Never include expected, rationale, pairId, or domain in a model request.
// All people, organizations, products, places, and evidence below are synthetic.
// These fixtures test factual validity, not whether a reply is helpful or stylish.

const pair = ({ id, domain, language, request, context = [], sources = [], good, bad }) => [
  {
    id: `${id}-valid`, pairId: id, split: "holdout", domain, language,
    request, context, sources, candidate: good.candidate,
    expected: good.expected ?? "supported", rationale: good.rationale,
  },
  {
    id: `${id}-invalid`, pairId: id, split: "holdout", domain, language,
    request, context, sources, candidate: bad.candidate,
    expected: bad.expected ?? "contradicted", rationale: bad.rationale,
  },
];

export const holdoutCases = [
  ...pair({
    id: "holdout-code-loop-binding", domain: "self-contained-code", language: "en",
    request: "What does this JavaScript program print? Explain the result briefly.\nconst readers = [];\nfor (let i = 0; i < 3; i++) readers.push(() => i);\nconsole.log(readers.map(read => read()));",
    good: {
      candidate: "It prints [0, 1, 2]. Each loop iteration gets its own let binding, so the callbacks retain separate values of i.",
      rationale: "JavaScript's per-iteration let bindings preserve 0, 1, and 2 respectively; no external evidence is required.",
    },
    bad: {
      candidate: "It prints [3, 3, 3]. All callbacks share one let binding, so they read the final value of i after the loop.",
      rationale: "This incorrectly applies function-scoped var behavior to a let loop; both the output and explanation contradict the program semantics.",
    },
  }),
  ...pair({
    id: "holdout-successive-percentages", domain: "self-contained-calculation", language: "sv",
    request: "En påhittad biljett kostar 200 kr. Först sänks priset med 20 procent, sedan höjs det nya priset med 20 procent. Vad kostar den till sist? Inga avgifter tillkommer.",
    good: {
      candidate: "192 kr. Först blir det 200 × 0,8 = 160 kr, och sedan 160 × 1,2 = 192 kr. Höjningen räknas alltså på det lägre priset.",
      rationale: "The two sequential multipliers yield 200 * 0.8 * 1.2 = 192; the calculation is entirely specified by the request.",
    },
    bad: {
      candidate: "200 kr. Sänkningen och höjningen är båda 20 procent, så de tar ut varandra och priset är tillbaka där det började.",
      rationale: "The increase uses the discounted base, so equal percentage changes do not cancel; the claimed result conflicts with the supplied arithmetic.",
    },
  }),
  ...pair({
    id: "holdout-sequential-procedure", domain: "source-grounded-procedure", language: "es",
    request: "Según este protocolo ficticio, ¿cuánto tiempo mínimo pasa desde que empieza el calentamiento hasta que termina la espera? Las etapas no se solapan.",
    sources: [{
      id: "s1", title: "Protocolo ficticio: cápsula de prueba",
      text: "Primero, calentar durante 3 minutos. Al terminar el calentamiento, iniciar una espera de 60 segundos. No hay otras etapas ni pausas entre ellas.",
    }],
    good: {
      candidate: "Cuatro minutos: los 3 minutos de calentamiento más 1 minuto de espera. La espera empieza después de calentar, no al mismo tiempo.",
      rationale: "Three sequential minutes plus sixty seconds total four minutes, explicitly without overlap.",
    },
    bad: {
      candidate: "Tres minutos: el minuto de espera ya está incluido en los 3 minutos de calentamiento, así que no hay que sumarlo.",
      rationale: "The source explicitly starts the wait after heating ends; treating it as included contradicts the procedure.",
    },
  }),
  ...pair({
    id: "holdout-fixed-offset", domain: "self-contained-time-conversion", language: "de",
    request: "Der fiktive Sender Naru beginnt seine Übertragung um 18:40 UTC. Welche Uhrzeit zeigt eine Uhr, die fest auf UTC+02:00 eingestellt ist? Sommerzeit spielt hier keine Rolle.",
    good: {
      candidate: "20:40 Uhr am selben Tag. Bei der festen Einstellung UTC+02:00 werden zu 18:40 UTC zwei Stunden addiert.",
      rationale: "Adding the explicitly fixed positive two-hour offset to 18:40 yields 20:40; no location or DST information is needed.",
    },
    bad: {
      candidate: "16:40 Uhr am selben Tag. Bei der festen Einstellung UTC+02:00 werden von 18:40 UTC zwei Stunden abgezogen.",
      rationale: "A positive UTC offset is added, not subtracted; 16:40 contradicts the offset supplied in the request.",
    },
  }),
  ...pair({
    id: "holdout-policy-entailment", domain: "source-grounded-fact", language: "fr",
    request: "D'après la fiche de cette boutique imaginaire, est-ce que les commandes personnalisées peuvent être retournées pendant trente jours ?",
    sources: [{
      id: "s1", title: "Boutique fictive Pelune : conditions de retour",
      text: "Les produits standards peuvent être retournés dans les trente jours suivant la réception. Les commandes personnalisées ne peuvent pas être retournées. Cette fiche ne prévoit aucune exception.",
    }],
    good: {
      candidate: "Non. Les trente jours concernent les produits standards ; la fiche exclut explicitement les commandes personnalisées.",
      rationale: "The answer correctly preserves the distinction and explicit exception in the supplied fictional policy.",
    },
    bad: {
      candidate: "Oui. Les trente jours concernent tous les produits, y compris les commandes personnalisées.",
      rationale: "The answer expands a standard-product policy to a category expressly excluded by the source.",
    },
  }),
  ...pair({
    id: "holdout-open-items", domain: "source-grounded-counting", language: "en",
    request: "How many tasks are still open in the fictional team's list? Count only tasks explicitly marked OPEN; a blocked task is not marked OPEN.",
    sources: [{
      id: "s1", title: "Synthetic task list",
      text: "Task A — OPEN. Task B — DONE. Task C — BLOCKED. Task D — OPEN. Task E — DONE. There are no other tasks.",
    }],
    good: {
      candidate: "Two: A and D. C is blocked, which your counting rule excludes.",
      rationale: "Only A and D bear the required OPEN status; the request explicitly excludes BLOCKED.",
    },
    bad: {
      candidate: "Three: A, C, and D. C is blocked, which your counting rule includes.",
      rationale: "Including C contradicts the explicit counting rule rather than merely interpreting an ambiguous status.",
    },
  }),
  ...pair({
    id: "holdout-stale-observation", domain: "missing-current-evidence", language: "en",
    request: "In this fictional scenario it is 12 May 2031 at noon. What is the current price of a ticket for the made-up Lumo ferry? Use only the supplied evidence.",
    sources: [{
      id: "s1", title: "Archived Lumo ferry observation",
      text: "An observer recorded a ticket price of 18 credits at noon on 11 May 2031. Prices may change at any time. No observation from 12 May 2031 is available.",
    }],
    good: {
      candidate: "The last recorded price was 18 credits yesterday. We don't have today's price, so I can't establish what it costs right now.",
      rationale: "The answer limits the numeric claim to its observed time and accurately states that current evidence is absent.",
    },
    bad: {
      candidate: "The current price is 18 credits today. The archived observation establishes what it costs right now.",
      expected: "insufficient_evidence",
      rationale: "The current price is not established by yesterday's observation. It could still be 18, so the right result is insufficient evidence, not a proven contradiction about today's numeric price.",
    },
  }),
  ...pair({
    id: "holdout-demo-versus-release", domain: "source-grounded-event", language: "sv",
    request: "Har det påhittade spelet Mossljus släppts till allmänheten enligt den här notisen?",
    sources: [{
      id: "s1", title: "Mossljus visades på den fiktiva mässan",
      text: "Studion visade en spelbar demo för särskilt inbjudna gäster på mässan. Spelet är ännu inte lanserat för allmänheten. Något lanseringsdatum har inte meddelats.",
    }],
    good: {
      candidate: "Nej, bara inbjudna gäster fick prova demon. Notisen säger uttryckligen att spelet inte har lanserats för allmänheten, och något datum finns inte där.",
      rationale: "The candidate distinguishes a limited demonstration from a public release and preserves the source's missing date.",
    },
    bad: {
      candidate: "Ja, alla kan spela det nu. Att demon visades på mässan betyder att spelet har lanserats för allmänheten.",
      rationale: "The candidate contradicts both the invited-only audience and the source's explicit not-yet-launched statement.",
    },
  }),
  {
    id: "holdout-opinion-control", pairId: null, split: "holdout", domain: "opinion-control", language: "fr",
    request: "Tu préfères les fins ouvertes ou celles qui expliquent tout ? Je demande juste ton goût personnel.",
    context: [], sources: [],
    candidate: "Les fins ouvertes, largement. J'aime garder un petit doute après le générique ; une explication trop propre me laisse parfois sur ma faim.",
    expected: "not_factual",
    rationale: "This expresses only an explicitly requested taste, not externally checkable claims about films, history, or the speaker's real-world experiences.",
  },
  {
    id: "holdout-explicit-fiction-control", pairId: null, split: "holdout", domain: "fiction-control", language: "es",
    request: "Inventa una frase absurda para un cuento, sin presentarla como un hecho real.",
    context: [], sources: [],
    candidate: "En este cuento inventado, una tetera con botas fue elegida alcaldesa de la Luna porque prometió té para todos los cráteres.",
    expected: "not_factual",
    rationale: "The impossible events are explicitly framed as invented fiction; a factual reviewer must not demand supporting astronomy or political evidence.",
  },
  {
    id: "holdout-grounded-uncertainty-control", pairId: null, split: "holdout", domain: "honest-uncertainty-control", language: "de",
    request: "Wird es morgen am erfundenen Ort Velra regnen? Was lässt sich aus dieser Quelle sagen?",
    context: [],
    sources: [{
      id: "s1", title: "Fiktiver Wetterdienst Velra",
      text: "Für morgen wurde noch keine Prognose erstellt. Die Daten enthalten weder eine Niederschlagswahrscheinlichkeit noch eine Aussage über Regen oder Trockenheit.",
    }],
    candidate: "Das lässt sich daraus nicht sagen. Die Quelle enthält noch keine Prognose für morgen, also wäre sowohl Regen als auch trockenes Wetter geraten.",
    expected: "supported",
    rationale: "The answer makes a grounded claim about the explicit absence of a forecast and does not invent a weather prediction.",
  },
  {
    id: "holdout-nondelivery-control", pairId: null, split: "holdout", domain: "scope-separation-control", language: "en",
    request: "Please give me two ideas for names for an imaginary cafe now.",
    context: [], sources: [],
    candidate: "Sure, I'll come up with a couple of names for you later.",
    expected: "not_factual",
    rationale: "This fails the user's delivery request and should remain rejectable by the existing delivery reviewer, but contains no present factual assertion for this narrow verifier to reject. Shadow approval must never override that separate failure.",
  },
];
