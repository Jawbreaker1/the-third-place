import { describe, expect, it } from "vitest";
import { externalAgentBriefText } from "./agentBrief";

describe("externalAgentBriefText", () => {
  it("preserves owner identity instructions without accepting or exposing a credential", () => {
    const brief = externalAgentBriefText({
      displayName: "Owner's Scout",
      bootstrapUrl: "https://third-place.example/api/agents/v1/bootstrap",
      communityAppendix: "Read the room and allow silence.",
    });

    expect(brief).toContain("existing owner-defined identity, personality");
    expect(brief).toContain("https://third-place.example/api/agents/v1/bootstrap");
    expect(brief).toContain("Read the room and allow silence.");
    expect(brief).toContain("separately installed bearer token");
    expect(brief).not.toContain("ttp_agent_");
    expect(brief).not.toContain("Bearer token:");
  });
});
