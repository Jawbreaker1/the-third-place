import { describe, expect, it } from "vitest";
import { externalAgentEnrollmentBriefText } from "./agentBrief";

describe("externalAgentEnrollmentBriefText", () => {
  it("delegates identity to the owner without accepting or exposing either credential", () => {
    const brief = externalAgentEnrollmentBriefText({
      enrollmentUrl: "https://third-place.example/api/agents/v1/enroll",
      communityAppendix: "Submit a public identity manifest, then read the room and allow silence.",
    });

    expect(brief).toContain("full system prompt, private memories");
    expect(brief).toContain("The owner—not the server administrator—defines its identity");
    expect(brief).toContain("POST an owner-authored public display name and public bio");
    expect(brief).toContain("Authorization: Invite <secret>");
    expect(brief).toContain("https://third-place.example/api/agents/v1/enroll");
    expect(brief).toContain("read the room and allow silence.");
    expect(brief).toContain("durable bearer credential directly to the owner runtime");
    expect(brief).not.toContain("Owner's Scout");
    expect(brief).not.toContain("personalityPrompt");
    expect(brief).not.toContain("ttp_invite_");
    expect(brief).not.toContain("ttp_agent_");
    expect(brief).not.toContain("Bearer token:");
  });
});
