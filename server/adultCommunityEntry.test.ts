import { describe, expect, it } from "vitest";
import {
  adultConfirmationSchema,
  accountLoginSchema,
  accountRegisterSchema,
  guestJoinSchema,
  hasAdultCommunityConfirmation,
  recoverSessionSchema,
} from "./adultCommunityEntry.js";

const entryCases = [
  ["guest entry", guestJoinSchema, { name: "Johan" }],
  ["account registration", accountRegisterSchema, {
    loginHandle: "johan",
    displayName: "Johan",
    password: "long-enough-password",
  }],
  ["account login", accountLoginSchema, {
    loginHandle: "johan",
    password: "long-enough-password",
  }],
  ["legacy return", recoverSessionSchema, {
    name: "Johan",
    recoveryKey: "old-private-return-key",
  }],
] as const;

describe("adult community entry", () => {
  it("recognises only a literal true acknowledgement without inspecting other form fields", () => {
    expect(hasAdultCommunityConfirmation({ adultConfirmed: true, anythingElse: "ignored here" })).toBe(true);
    expect(hasAdultCommunityConfirmation({ adultConfirmed: false })).toBe(false);
    expect(hasAdultCommunityConfirmation({ adultConfirmed: "true" })).toBe(false);
    expect(hasAdultCommunityConfirmation(null)).toBe(false);
  });

  it("keeps the acknowledgement endpoint one-purpose and exact", () => {
    expect(adultConfirmationSchema.safeParse({ adultConfirmed: true }).success).toBe(true);
    expect(adultConfirmationSchema.safeParse({ adultConfirmed: false }).success).toBe(false);
    expect(adultConfirmationSchema.safeParse({ adultConfirmed: true, accountId: "someone-else" }).success).toBe(false);
  });

  it.each(entryCases)("requires an exact 18+ acknowledgement for %s", (_label, schema, input) => {
    expect(schema.safeParse({ ...input, adultConfirmed: true }).success).toBe(true);
    expect(schema.safeParse(input).success).toBe(false);
    expect(schema.safeParse({ ...input, adultConfirmed: false }).success).toBe(false);
    expect(schema.safeParse({ ...input, adultConfirmed: "true" }).success).toBe(false);
  });

  it.each(entryCases)("keeps %s payloads bounded", (_label, schema, input) => {
    expect(schema.safeParse({ ...input, adultConfirmed: true, birthDate: "2000-01-01" }).success).toBe(false);
  });
});
