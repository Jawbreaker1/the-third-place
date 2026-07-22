import { describe, expect, it } from "vitest";
import { resolveExternalAgentConnectionTarget } from "./agentConnectionOrigin";

const enrollment = "http://127.0.0.1:4000/api/agents/v1/enroll";

describe("external-agent connection origins", () => {
  it("keeps an absent public origin locked instead of falling back to localhost", () => {
    const target = resolveExternalAgentConnectionTarget("", enrollment);
    expect(target.copyAllowed).toBe(false);
    expect(target.warning).toContain("No public HTTPS address was detected");
  });

  it("blocks loopback HTTP as a recipient default", () => {
    const target = resolveExternalAgentConnectionTarget("http://localhost:4000", enrollment);
    expect(target.copyAllowed).toBe(false);
    expect(target.warning).toContain("No public HTTPS address");
  });

  it("allows loopback HTTP only after explicit same-machine opt-in", () => {
    const target = resolveExternalAgentConnectionTarget("http://localhost:4000", enrollment, {
      allowLoopback: true,
    });
    expect(target).toMatchObject({
      enrollmentUrl: "http://localhost:4000/api/agents/v1/enroll",
      copyAllowed: true,
    });
    expect(target.warning).toContain("Local-only mode");
  });

  it("allows a public HTTPS/ngrok origin and rebuilds only the origin", () => {
    expect(resolveExternalAgentConnectionTarget(
      "https://friends.ngrok-free.app/an-ignored-path",
      `${enrollment}?contract=1`,
    )).toEqual({
      enrollmentUrl: "https://friends.ngrok-free.app/api/agents/v1/enroll?contract=1",
      copyAllowed: true,
      warning: null,
    });
  });

  it("blocks external plaintext before a credential-bearing command can be copied", () => {
    const target = resolveExternalAgentConnectionTarget("http://192.0.2.40:4000", enrollment);
    expect(target.copyAllowed).toBe(false);
    expect(target.enrollmentUrl).toBe(enrollment);
    expect(target.warning).toContain("requires HTTPS");
  });

  it.each(["not a URL", "file:///tmp/socket", "ftp://example.test"])(
    "blocks malformed or unsupported origin %s without silently authorizing the fallback",
    (origin) => {
      const target = resolveExternalAgentConnectionTarget(origin, enrollment);
      expect(target.copyAllowed).toBe(false);
      expect(target.enrollmentUrl).toBe(enrollment);
      expect(target.warning).toContain("valid HTTP(S)");
    },
  );
});
