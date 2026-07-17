import { describe, expect, it } from "vitest";
import { CHANNEL_PROFILES } from "./channels.js";
import { expertisePromptNote } from "./roomExpertise.js";

const securityProfile = () => {
  const profile = CHANNEL_PROFILES.find((candidate) => candidate.public.id === "ai-hacking");
  if (!profile) throw new Error("Missing ai-hacking room profile");
  return profile;
};

describe("ai-hacking knowledge contract", () => {
  it("treats cybersecurity as a broad semantic domain rather than a prompt-injection special case", () => {
    const profile = securityProfile();

    expect(profile.topic.tags).toEqual(expect.arrayContaining([
      "AI security",
      "web and API security",
      "network security",
      "identity and access management",
      "cloud security",
      "container security",
      "endpoint security",
      "reverse engineering",
      "malware analysis",
      "digital forensics",
      "authentication and cryptography",
      "secure software development",
    ]));
    expect(profile.conversationGuidance).toContain("this is not a whitelist");
    expect(profile.conversationGuidance).not.toContain("A request for a prompt-injection example");
  });

  it("requires useful artifacts at semantic depth while retaining an authorization boundary", () => {
    const guidance = securityProfile().conversationGuidance ?? "";

    expect(guidance.length).toBeLessThanOrEqual(2_000);
    expect(guidance).toContain("Match semantic need");
    expect(guidance).toContain("must contain the useful artifact at trusted room-sized depth");
    expect(guidance).toContain("semantically across languages, never by keyword lists");
    expect(guidance).toContain("unauthorized access");
    expect(guidance).toContain("pivot at the same technical depth");
    expect(guidance).toContain("disposable targets");
  });

  it("distributes practical strengths beyond AI security across several residents", () => {
    const overrides = securityProfile().expertiseOverrides ?? {};
    const specialties = Object.values(overrides)
      .flatMap((override) => override?.specialties ?? [])
      .join(" | ");

    expect(overrides["ai-aya"]?.level).toBe("specialist");
    expect(overrides["ai-nox"]?.level).toBe("advanced");
    expect(overrides["ai-zed"]?.level).toBe("advanced");
    expect(specialties).toContain("web and API security");
    expect(specialties).toContain("cloud and container attack surfaces");
    expect(specialties).toContain("secure code review and fuzzing");
    expect(specialties).toContain("reverse-engineering evidence");
    expect(specialties).toContain("authentication and authorization controls");
    expect(specialties).toContain("incident containment");
  });

  it("does not let an expert persona's ordinary brevity erase a trusted worked request", () => {
    const note = expertisePromptNote(securityProfile(), {
      level: "specialist",
      specialties: ["application security"],
      blindSpots: [],
    });

    expect(note).toContain("does not make every turn long");
    expect(note).toContain("when a trusted request calls for a worked answer");
    expect(note).toContain("actual mechanism, example or comparison");
    expect(note).toContain("rather than a summary or generic warning");
  });
});
