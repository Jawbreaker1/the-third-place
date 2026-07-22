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

const loopbackOrigin = (origin: URL): boolean => origin.hostname === "localhost" ||
  origin.hostname === "127.0.0.1" || origin.hostname === "::1" || origin.hostname === "[::1]";

export const isLoopbackConnectionOrigin = (value: string): boolean => {
  try {
    return loopbackOrigin(new URL(value));
  } catch {
    return false;
  }
};

/**
 * Fails closed for plaintext, loopback-by-default or malformed handoff origins.
 * The original endpoint is retained only as inert display data; callers must
 * honor copyAllowed before copying any credential-bearing command or guide.
 */
export const resolveExternalAgentConnectionTarget = (
  connectionOrigin: string,
  originalEnrollmentUrl: string,
  options: { allowLoopback?: boolean } = {},
): ExternalAgentConnectionTarget => {
  if (!connectionOrigin.trim()) {
    return invalidTarget(
      originalEnrollmentUrl,
      "No public HTTPS address was detected. Start a tunnel, configure PUBLIC_ORIGIN, or paste the public address before sharing this package.",
    );
  }
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
    const loopback = loopbackOrigin(origin);
    if (loopback) {
      if (!options.allowLoopback) {
        return invalidTarget(
          originalEnrollmentUrl,
          "No public HTTPS address is selected. Start a tunnel, configure PUBLIC_ORIGIN, or paste the public address before sharing this package.",
        );
      }
      return {
        enrollmentUrl,
        copyAllowed: true,
        warning: "Local-only mode is active. These commands work only on this computer and must not be sent to somebody else.",
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
