import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Member } from "../shared/types";
import {
  canDirectMessageMember,
  externalAgentMembers,
  MemberGroup,
  MemberKindBadge,
  reactionParticipantsLabel,
} from "./App";

const member = (id: string, kind: Member["kind"], status: Member["status"] = "online"): Member => ({
  id,
  name: id,
  kind,
  status,
  avatar: { color: "#173f3a", accent: "#56d5ad", glyph: id.slice(0, 1).toUpperCase() },
  role: kind === "agent" ? "Owner-defined traveller" : undefined,
});

describe("external agent presentation", () => {
  it("uses a distinct visible label without presenting an external agent as a resident", () => {
    const markup = renderToStaticMarkup(<MemberKindBadge kind={"agent"} verbose />);

    expect(markup).toContain("EXTERNAL AGENT");
    expect(markup).toContain("external-agent-badge");
    expect(markup).not.toContain("AI RESIDENT");
    expect(markup).not.toContain("ai-badge");
  });

  it("keeps the existing resident label distinct", () => {
    const markup = renderToStaticMarkup(<MemberKindBadge kind="ai" verbose />);

    expect(markup).toContain("AI RESIDENT");
    expect(markup).toContain("ai-badge");
    expect(markup).not.toContain("EXTERNAL AGENT");
  });

  it("renders truthful presence in an external-agent member group", () => {
    const markup = renderToStaticMarkup(
      <MemberGroup title="External agents" members={[member("Atlas", "agent", "offline")]} onSelect={vi.fn()} />,
    );

    expect(markup).toContain("External agents");
    expect(markup).toContain("EXTERNAL AGENT");
    expect(markup).toContain("Atlas avatar, offline");
    expect(markup).toContain("presence-offline");
  });

  it("orders an agent-only section by actual presence without mixing in people or residents", () => {
    const members = [
      member("resident", "ai"),
      member("offline-agent", "agent", "offline"),
      member("person", "human"),
      member("online-agent", "agent", "online"),
      member("idle-agent", "agent", "idle"),
    ];

    expect(externalAgentMembers(members).map(({ id }) => id)).toEqual([
      "online-agent",
      "idle-agent",
      "offline-agent",
    ]);
  });

  it("does not offer external agents the human/resident DM path", () => {
    const me = member("me", "human");

    expect(canDirectMessageMember(me, member("person", "human"))).toBe(true);
    expect(canDirectMessageMember(me, member("resident", "ai"))).toBe(true);
    expect(canDirectMessageMember(me, member("visitor", "agent"))).toBe(false);
    expect(canDirectMessageMember(me, me)).toBe(false);
  });

  it("names reaction participants and marks externally operated agents", () => {
    const members = new Map([
      ["person", member("Johan", "human")],
      ["visitor", member("Patchwork", "agent")],
    ]);

    expect(reactionParticipantsLabel("👍", ["person", "visitor"], members)).toBe(
      "👍 reaction by Johan, Patchwork (External Agent)",
    );
  });
});
