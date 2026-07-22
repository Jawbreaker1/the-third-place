import { z } from "zod";
import { normalizeDisplayName, validDisplayName } from "./displayName.js";
import { stripDangerousTextControls } from "./unicodeSafety.js";

export const EXTERNAL_AGENT_SCOPES = [
  "rooms:read",
  "messages:write",
  "reactions:write",
] as const;

export const externalAgentScopeSchema = z.enum(EXTERNAL_AGENT_SCOPES);
export type ExternalAgentScope = z.infer<typeof externalAgentScopeSchema>;

export const EXTERNAL_AGENT_MAX_CHANNELS = 64;
export const EXTERNAL_AGENT_MAX_PUBLIC_BIO_CODE_POINTS = 240;
export const EXTERNAL_AGENT_MAX_INVITATION_LABEL_CODE_POINTS = 120;
export const EXTERNAL_AGENT_INVITATION_MIN_EXPIRY_MINUTES = 5;
export const EXTERNAL_AGENT_INVITATION_DEFAULT_EXPIRY_MINUTES = 24 * 60;
export const EXTERNAL_AGENT_INVITATION_MAX_EXPIRY_MINUTES = 24 * 60;

const codePointLength = (value: string): number => [...value].length;

const canonicalDisplayNameSchema = z.string().superRefine((value, context) => {
  if (normalizeDisplayName(value) !== value || !validDisplayName(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Agent display name is not canonical or contains unsupported characters",
    });
  }
});

/** Accepts owner input and emits the same canonical display-name shape used by humans. */
export const externalAgentDisplayNameInputSchema = z.string()
  .transform(normalizeDisplayName)
  .pipe(canonicalDisplayNameSchema);

export const externalAgentDisplayNameSchema = canonicalDisplayNameSchema;

const normalizeMultilineText = (value: string): string =>
  stripDangerousTextControls(value.normalize("NFC").replace(/\r\n?/gu, "\n")).trim();

const canonicalBoundedText = (maximumCodePoints: number, minimumCodePoints: number) =>
  z.string().superRefine((value, context) => {
    const length = codePointLength(value);
    if (normalizeMultilineText(value) !== value || length < minimumCodePoints || length > maximumCodePoints) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Text must be canonical and contain ${minimumCodePoints}-${maximumCodePoints} code points`,
      });
    }
  });

const boundedTextInput = (maximumCodePoints: number, minimumCodePoints: number) =>
  z.string()
    // This cheap UTF-16 bound prevents a huge request from reaching normalization.
    .max(maximumCodePoints * 2 + 2_048)
    .transform(normalizeMultilineText)
    .pipe(canonicalBoundedText(maximumCodePoints, minimumCodePoints));

export const externalAgentPublicBioInputSchema = boundedTextInput(
  EXTERNAL_AGENT_MAX_PUBLIC_BIO_CODE_POINTS,
  0,
);
export const externalAgentPublicBioSchema = canonicalBoundedText(
  EXTERNAL_AGENT_MAX_PUBLIC_BIO_CODE_POINTS,
  0,
);

export const externalAgentInvitationLabelInputSchema = boundedTextInput(
  EXTERNAL_AGENT_MAX_INVITATION_LABEL_CODE_POINTS,
  1,
);
export const externalAgentInvitationLabelSchema = canonicalBoundedText(
  EXTERNAL_AGENT_MAX_INVITATION_LABEL_CODE_POINTS,
  1,
);

/** Room IDs are catalog identifiers, never user-authored natural-language routing rules. */
export const externalAgentChannelIdSchema = z.string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/u);

export const externalAgentChannelIdsSchema = z.array(externalAgentChannelIdSchema)
  .min(1)
  .max(EXTERNAL_AGENT_MAX_CHANNELS)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Agent room access must be unique" });
    }
  });

export const externalAgentScopesSchema = z.array(externalAgentScopeSchema)
  .min(1)
  .max(EXTERNAL_AGENT_SCOPES.length)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Agent scopes must be unique" });
    }
  });

/** Public, owner-controlled identity. Private personality and memory stay in the owner's runtime. */
export const externalAgentPublicProfileInputSchema = z.object({
  displayName: externalAgentDisplayNameInputSchema,
  publicBio: externalAgentPublicBioInputSchema,
}).strict();

export interface ExternalAgentPublicProfileInput {
  displayName: string;
  publicBio: string;
}
export type CanonicalExternalAgentPublicProfileInput = z.output<typeof externalAgentPublicProfileInputSchema>;

export const updateExternalAgentPublicProfileInputSchema = externalAgentPublicProfileInputSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one public profile field must be updated");

export type UpdateExternalAgentPublicProfileInput = Partial<ExternalAgentPublicProfileInput>;
export type CanonicalUpdateExternalAgentPublicProfileInput = z.output<
  typeof updateExternalAgentPublicProfileInputSchema
>;

/** Host-controlled authorization policy. It can never be widened by the agent profile manifest. */
export const externalAgentAccessPolicyInputSchema = z.object({
  channelIds: externalAgentChannelIdsSchema,
  scopes: externalAgentScopesSchema,
}).strict();

export interface ExternalAgentAccessPolicyInput {
  channelIds: readonly string[];
  scopes: readonly ExternalAgentScope[];
}
export type CanonicalExternalAgentAccessPolicyInput = z.output<typeof externalAgentAccessPolicyInputSchema>;

export const updateExternalAgentAccessPolicyInputSchema = externalAgentAccessPolicyInputSchema;
export type UpdateExternalAgentAccessPolicyInput = ExternalAgentAccessPolicyInput;
export type CanonicalUpdateExternalAgentAccessPolicyInput = CanonicalExternalAgentAccessPolicyInput;

export const externalAgentInvitationPurposeSchema = z.enum(["enroll", "reconnect"]);
export type ExternalAgentInvitationPurpose = z.infer<typeof externalAgentInvitationPurposeSchema>;

const invitationCommonInputShape = {
  adminLabel: externalAgentInvitationLabelInputSchema,
  channelIds: externalAgentChannelIdsSchema,
  scopes: externalAgentScopesSchema,
  expiresInMinutes: z.number()
    .int()
    .min(EXTERNAL_AGENT_INVITATION_MIN_EXPIRY_MINUTES)
    .max(EXTERNAL_AGENT_INVITATION_MAX_EXPIRY_MINUTES)
    .optional(),
};

export const createExternalAgentInvitationInputSchema = z.discriminatedUnion("purpose", [
  z.object({
    ...invitationCommonInputShape,
    purpose: z.literal("enroll"),
  }).strict(),
  z.object({
    ...invitationCommonInputShape,
    purpose: z.literal("reconnect"),
    agentId: z.string().min(7).max(100).regex(/^agent-[a-z0-9][a-z0-9-]*$/u),
  }).strict(),
]);

export type CreateExternalAgentInvitationInput = z.input<
  typeof createExternalAgentInvitationInputSchema
>;
export type CanonicalCreateExternalAgentInvitationInput = z.output<
  typeof createExternalAgentInvitationInputSchema
>;

/** Safe for catalogs, member projections, authenticated self and administrator responses. */
export interface ExternalAgentSummary {
  id: string;
  displayName: string;
  publicBio: string;
  channelIds: string[];
  scopes: ExternalAgentScope[];
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

/** There is no longer a server-stored private detail; this alias eases API migration. */
export type ExternalAgentAdminDetail = ExternalAgentSummary;
export type AuthenticatedExternalAgent = ExternalAgentSummary;

/** The plaintext bearer is returned only by invitation redemption and cannot be recovered later. */
export interface IssuedExternalAgentCredential {
  agent: ExternalAgentSummary;
  token: string;
}

export type ExternalAgentInvitationStatus = "pending" | "expired" | "redeemed" | "revoked";

/** Token-free invitation projection safe for the authenticated administrator. */
export interface ExternalAgentInvitationSummary {
  id: string;
  agentId: string;
  adminLabel: string;
  purpose: ExternalAgentInvitationPurpose;
  channelIds: string[];
  scopes: ExternalAgentScope[];
  status: ExternalAgentInvitationStatus;
  createdAt: string;
  expiresAt: string;
  redeemedAt?: string;
  revokedAt?: string;
  expiredAt?: string;
}

/** The invitation bearer is disclosed exactly once when the host creates it. */
export interface IssuedExternalAgentInvitation {
  invitation: ExternalAgentInvitationSummary;
  token: string;
}

/** Successful one-time exchange. The invitation secret itself is never returned. */
export interface RedeemedExternalAgentInvitation extends IssuedExternalAgentCredential {
  invitation: ExternalAgentInvitationSummary;
}
