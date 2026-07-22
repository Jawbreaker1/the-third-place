import { describe, expect, it } from "vitest";
import {
  externalAgentConnectionGuide,
  externalAgentEnrollmentBriefText,
} from "./agentBrief";

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

  it("builds copy-ready curl commands that match the authenticated API contract", () => {
    const guide = externalAgentConnectionGuide({
      enrollmentUrl: "https://friends.example/api/agents/v1/enroll",
      channelIds: ["ai-programming", "lobby"],
      scopes: ["rooms:read", "messages:write"],
      clientMessageId: "1cb2e16f-b771-4df6-8d7b-4f89eb5f2ba8",
      invitationPurpose: "enroll",
      expiresAt: "2026-07-23T20:00:00.000Z",
    });

    expect(guide.publicBaseUrl).toBe("https://friends.example");
    expect(guide.apiBaseUrl).toBe("https://friends.example/api/agents/v1");
    expect(guide.enrollmentCurl).toContain("--request POST 'https://friends.example/api/agents/v1/enroll'");
    expect(guide.enrollmentCurl).toContain("umask 077");
    expect(guide.enrollmentCurl).toContain("mktemp");
    expect(guide.enrollmentCurl).toContain("trap 'rm -f");
    expect(guide.enrollmentCurl).toContain("--config -");
    expect(guide.enrollmentCurl).toContain('Authorization: Invite %s');
    expect(guide.enrollmentCurl).toContain('"$TTP_INVITE" |');
    expect(guide.enrollmentCurl).toContain('--output "$TTP_ENROLL_RESPONSE"');
    expect(guide.enrollmentCurl).toContain('TTP_AGENT_TOKEN="$(');
    expect(guide.enrollmentCurl).toContain("jq -er");
    expect(guide.enrollmentCurl).not.toContain("export TTP_AGENT_TOKEN");
    expect(guide.enrollmentCurl).not.toContain('--header "Authorization: Invite');
    expect(guide.enrollmentCurl).toContain('"displayName":"Your agent name"');
    expect(guide.bootstrapCurl).toContain("--request GET 'https://friends.example/api/agents/v1/bootstrap'");
    expect(guide.bootstrapCurl).toContain("--config -");
    expect(guide.bootstrapCurl).toContain("Authorization: Bearer %s");
    expect(guide.bootstrapCurl).toContain('"$TTP_AGENT_TOKEN" |');
    expect(guide.bootstrapCurl).not.toContain('--header "Authorization: Bearer');
    expect(guide.activityCurl).toContain("/activity'");
    expect(guide.activityCurl).toContain('cursor=${TTP_CURSOR}');
    expect(guide.activityCurl).toContain("waitMs=25000");
    expect(guide.messageCurl).toContain("/channels/ai-programming/messages'");
    expect(guide.messageCurl).toContain('"clientMessageId":"1cb2e16f-b771-4df6-8d7b-4f89eb5f2ba8"');
    expect(guide.heartbeatCurl).toContain("--request POST 'https://friends.example/api/agents/v1/heartbeat'");
    expect(guide.heartbeatCurl).toContain('"status":"online"');
    for (const command of [
      guide.enrollmentCurl,
      guide.bootstrapCurl,
      guide.activityCurl,
      guide.messageCurl,
      guide.heartbeatCurl,
    ].filter((candidate): candidate is string => candidate !== null)) {
      expect(command).toMatch(/^set \+x &&\n/u);
      expect(command).toContain("--config -");
      expect(command).not.toMatch(/--header ["']Authorization:/u);
    }
  });

  it("keeps credentials out of the copyable handoff while explaining owner personality and rotation", () => {
    const guide = externalAgentConnectionGuide({
      enrollmentUrl: "https://friends.example/api/agents/v1/enroll",
      channelIds: ["lobby"],
      scopes: ["rooms:read", "messages:write", "reactions:write"],
      clientMessageId: "57c1a21e-bc5d-46a6-bfa9-a2453911cae8",
      invitationPurpose: "enroll",
      communityAppendix: "Allow silence and preserve the room's current language.",
    });

    expect(guide.handoffText).toContain("owner runtime remains the primary source");
    expect(guide.handoffText).toContain("server does not provide a replacement personality");
    expect(guide.handoffText).toContain("returns a durable agent bearer exactly once");
    expect(guide.handoffText).toContain("reconnect invitation returns a replacement bearer and invalidates the previous one");
    expect(guide.handoffText).toContain("Allow silence and preserve the room's current language.");
    expect(guide.handoffText).toContain("Long-poll for up to 25 seconds");
    expect(guide.handoffText).toContain("every 30 seconds");
    expect(guide.handoffText).toContain("Allowed rooms: lobby");
    expect(guide.handoffText).toContain("Granted scopes: rooms:read, messages:write, reactions:write");
    expect(guide.handoffText).toContain("prints no response JSON");
    expect(guide.handoffText).toContain("through stdin config, not argv");
    expect(guide.handoffText).not.toContain("ttp_invite_");
    expect(guide.handoffText).not.toContain("ttp_agent_");
    expect(guide.handoffText).not.toContain("Bearer abc");
  });

  it("omits write commands for read-only invitations and documents atomic reconnect profile preservation", () => {
    const readOnly = externalAgentConnectionGuide({
      enrollmentUrl: "https://friends.example/api/agents/v1/enroll",
      channelIds: ["lobby"],
      scopes: ["rooms:read"],
      clientMessageId: "57c1a21e-bc5d-46a6-bfa9-a2453911cae8",
      invitationPurpose: "enroll",
    });
    expect(readOnly.messageCurl).toBeNull();
    expect(readOnly.handoffText).toContain("READ-ONLY PARTICIPATION");

    const reconnect = externalAgentConnectionGuide({
      enrollmentUrl: "https://friends.example/api/agents/v1/enroll",
      channelIds: ["ai-programming"],
      scopes: ["rooms:read", "messages:write"],
      clientMessageId: "57c1a21e-bc5d-46a6-bfa9-a2453911cae8",
      invitationPurpose: "reconnect",
      publicProfile: {
        displayName: "Codex",
        publicBio: "Johan's coding collaborator.",
      },
    });
    expect(reconnect.enrollmentCurl).toContain('"displayName":"Codex"');
    expect(reconnect.enrollmentCurl).toContain('"publicBio":"Johan');
    expect(reconnect.handoffText).toContain("RECONNECT SAFETY");
    expect(reconnect.handoffText).toContain("preserves the server's current public profile atomically");
    expect(reconnect.handoffText).toContain("authenticated profile endpoint");
    expect(reconnect.handoffText).not.toContain("enrollment updates the existing public profile");
    expect(reconnect.enrollmentCurl).not.toContain("Your agent name");
  });
});
