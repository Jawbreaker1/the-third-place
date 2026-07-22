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
export const EXTERNAL_AGENT_MAX_PERSONALITY_PROMPT_CODE_POINTS = 12_000;

const codePointLength = (value: string): number => [...value].length;

const canonicalDisplayNameSchema = z.string().superRefine((value, context) => {
  if (normalizeDisplayName(value) !== value || !validDisplayName(value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Agent display name is not canonical or contains unsupported characters",
    });
  }
});

/** Accepts ordinary administrator input and emits the same canonical display-name shape used by humans. */
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
export const externalAgentPersonalityPromptInputSchema = boundedTextInput(
  EXTERNAL_AGENT_MAX_PERSONALITY_PROMPT_CODE_POINTS,
  1,
);
export const externalAgentPersonalityPromptSchema = canonicalBoundedText(
  EXTERNAL_AGENT_MAX_PERSONALITY_PROMPT_CODE_POINTS,
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

export const createExternalAgentInputSchema = z.object({
  displayName: externalAgentDisplayNameInputSchema,
  publicBio: externalAgentPublicBioInputSchema,
  personalityPrompt: externalAgentPersonalityPromptInputSchema,
  channelIds: externalAgentChannelIdsSchema,
  scopes: externalAgentScopesSchema,
}).strict();

export interface CreateExternalAgentInput {
  displayName: string;
  publicBio: string;
  personalityPrompt: string;
  channelIds: readonly string[];
  scopes: readonly ExternalAgentScope[];
}
export type CanonicalCreateExternalAgentInput = z.output<typeof createExternalAgentInputSchema>;

export const updateExternalAgentInputSchema = createExternalAgentInputSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one agent field must be updated");

export type UpdateExternalAgentInput = Partial<CreateExternalAgentInput>;
export type CanonicalUpdateExternalAgentInput = z.output<typeof updateExternalAgentInputSchema>;

/** Safe for catalogs, member projections and administrator list responses. */
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

/** Private administrator/authenticated-self view. It still never contains bearer-token material. */
export interface ExternalAgentAdminDetail extends ExternalAgentSummary {
  personalityPrompt: string;
}

export type AuthenticatedExternalAgent = ExternalAgentAdminDetail;

/** The plaintext bearer is returned only by create/rotate and cannot be recovered later. */
export interface IssuedExternalAgentCredential {
  agent: ExternalAgentAdminDetail;
  token: string;
}
