export interface ExternalAgentConnectionTarget {
  enrollmentUrl: string;
  copyAllowed: boolean;
  warning: string | null;
}

const invalidTarget = (
  originalEnrollmentUrl: string,
  warning: string,
): ExternalAgentConnectionTarget => ({
  enrollmentUrl: originalEnrollmentUrl,
  copyAllowed: false,
  warning,
});

/**
 * Fails closed for every non-loopback plaintext or malformed handoff origin.
 * The original endpoint is retained only as inert display data; callers must
 * honor copyAllowed before copying any credential-bearing command or guide.
 */
export const resolveExternalAgentConnectionTarget = (
  connectionOrigin: string,
  originalEnrollmentUrl: string,
): ExternalAgentConnectionTarget => {
  try {
    const original = new URL(originalEnrollmentUrl);
    const origin = new URL(connectionOrigin);
    if (origin.protocol !== "http:" && origin.protocol !== "https:") {
      return invalidTarget(
        originalEnrollmentUrl,
        "Enter a valid HTTP(S) connection origin before copying commands.",
      );
    }
    const enrollmentUrl = new URL(`${original.pathname}${original.search}`, `${origin.origin}/`).href;
    const loopback = origin.hostname === "localhost" || origin.hostname === "127.0.0.1" ||
      origin.hostname === "::1" || origin.hostname === "[::1]";
    if (loopback) {
      return {
        enrollmentUrl,
        copyAllowed: true,
        warning: "This points to this computer only. Replace the connection origin with the active ngrok HTTPS URL before sending it to somebody else.",
      };
    }
    if (origin.protocol !== "https:") {
      return invalidTarget(
        originalEnrollmentUrl,
        "External agent enrollment requires HTTPS. Enter the public HTTPS/ngrok origin before copying or sharing this package.",
      );
    }
    return { enrollmentUrl, copyAllowed: true, warning: null };
  } catch {
    return invalidTarget(
      originalEnrollmentUrl,
      "Enter a valid HTTP(S) connection origin before copying commands.",
    );
  }
};
