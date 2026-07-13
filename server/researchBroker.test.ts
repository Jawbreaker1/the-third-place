import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ResearchBroker } from "./researchBroker.js";

describe("research broker", () => {
  const originalResearchEnabled = process.env.RESEARCH_ENABLED;
  beforeAll(() => {
    process.env.RESEARCH_ENABLED = "true";
  });
  afterAll(() => {
    if (originalResearchEnabled === undefined) delete process.env.RESEARCH_ENABLED;
    else process.env.RESEARCH_ENABLED = originalResearchEnabled;
  });
  const broker = new ResearchBroker();

  it("detects explicit current-information questions", () => {
    expect(broker.shouldResearch("Vilka är de senaste AI-nyheterna idag?")).toBe(true);
    expect(broker.shouldResearch("What is the latest news about local models?")).toBe(true);
  });

  it("does not search ordinary room banter", () => {
    expect(broker.shouldResearch("Jag byggde en modell idag och den blev ganska kul")).toBe(false);
    expect(broker.shouldResearch("Är ananas på pizza gott?")).toBe(false);
    expect(broker.shouldResearch("Vem är du?")).toBe(false);
    expect(broker.shouldResearch("Berätta vad du gjorde idag")).toBe(false);
  });

  it("honours explicit lookup requests", () => {
    expect(broker.shouldResearch("Kolla upp dokumentationen för Gemma 4")).toBe(true);
    expect(broker.shouldResearch("Search the web for LM Studio structured output docs")).toBe(true);
  });

  it("recognises naturally phrased live-data questions in freshness-sensitive rooms", () => {
    expect(broker.shouldResearch("Vad står Saab-aktien i?", "stock-market")).toBe(true);
    expect(broker.shouldResearch("What is NVDA trading at?", "stock-market")).toBe(true);
    expect(broker.shouldResearch("Vad är P/E?", "stock-market")).toBe(false);
    expect(broker.shouldResearch("Vilken patch kör WoW nu?", "world-of-warcraft")).toBe(true);
    expect(broker.shouldResearch("Vilken Blender-version stöder den renderern?", "3d-visualisation")).toBe(true);
    expect(broker.shouldResearch("Vad säger regeringen om det här?", "the-pub")).toBe(true);
    expect(broker.shouldResearch("Vilken ny film har premiär?", "the-pub")).toBe(true);
    expect(broker.shouldResearch("Politiska slogans är mest tomma ord", "the-pub")).toBe(false);
    expect(broker.shouldResearch("Con Air är bättre än National Treasure", "the-pub")).toBe(false);
  });

  it("stays fully local unless the operator explicitly enables research", () => {
    process.env.RESEARCH_ENABLED = "false";
    expect(broker.shouldResearch("Kolla upp dagens AI-nyheter")).toBe(false);
    process.env.RESEARCH_ENABLED = "true";
  });

  it("uses news search, cleans the query and unwraps source links", async () => {
    let requestedUrl = "";
    const rss = `<?xml version="1.0"?><rss><channel><item>
      <title>Relevant AI story</title>
      <link>http://www.bing.com/news/apiclick.aspx?url=https%3A%2F%2Fexample.com%2Fstory</link>
      <description>A concrete current update.</description>
      <pubDate>Sun, 12 Jul 2026 10:00:00 GMT</pubDate>
    </item></channel></rss>`;
    const mockedFetch = async (input: string | URL | Request): Promise<Response> => {
      requestedUrl = String(input);
      return new Response(rss, { status: 200, headers: { "content-type": "application/rss+xml" } });
    };
    const testBroker = new ResearchBroker(mockedFetch as typeof fetch);
    const packet = await testBroker.research("Vilka är de senaste AI-nyheterna idag?", "guest-1");
    const parsedRequest = new URL(requestedUrl);
    expect(parsedRequest.pathname).toBe("/news/search");
    expect(parsedRequest.searchParams.get("q")).toBe("AI-nyheterna");
    expect(packet?.results[0]?.url).toBe("https://example.com/story");
    expect(packet?.results[0]?.publishedAt).toContain("2026");
  });
});
