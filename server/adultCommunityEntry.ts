import { z } from "zod";

/**
 * A deliberately small admission contract for the local adult community.
 * It records no birth date or age; every new identity-entry request must make
 * the same explicit 18+ acknowledgement.
 */
const adultCommunityConfirmation = {
  adultConfirmed: z.literal(true),
} as const;

const adultConfirmationOnlySchema = z.object(adultCommunityConfirmation).passthrough();

/** Exact body accepted by the one-purpose acknowledgement endpoint. */
export const adultConfirmationSchema = z.object(adultCommunityConfirmation).strict();

/** Distinguishes the admission failure from unrelated form validation. */
export const hasAdultCommunityConfirmation = (input: unknown): boolean =>
  adultConfirmationOnlySchema.safeParse(input).success;

export const guestJoinSchema = z.object({
  name: z.string().min(1).max(128),
  inviteCode: z.string().max(100).optional(),
  ...adultCommunityConfirmation,
}).strict();

export const accountRegisterSchema = z.object({
  loginHandle: z.string().min(1).max(128),
  displayName: z.string().min(1).max(128),
  password: z.string().min(1).max(1_024),
  inviteCode: z.string().max(100).optional(),
  ...adultCommunityConfirmation,
}).strict();

export const accountLoginSchema = z.object({
  loginHandle: z.string().min(1).max(128),
  password: z.string().min(1).max(1_024),
  inviteCode: z.string().max(100).optional(),
  ...adultCommunityConfirmation,
}).strict();

export const recoverSessionSchema = z.object({
  name: z.string().min(1).max(128),
  recoveryKey: z.string().min(1).max(96),
  inviteCode: z.string().max(100).optional(),
  takeOver: z.boolean().optional(),
  ...adultCommunityConfirmation,
}).strict();
