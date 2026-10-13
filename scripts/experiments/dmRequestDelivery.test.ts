// REJECTED LIVE EXPERIMENT — NOT PRODUCTION. Structural tests do not establish
// semantic review quality; live evaluation rejected this experiment.
import { describe, expect, it } from "vitest";
import {
  dmRequestDeliveryJsonSchema,
  dmRequestDeliverySchema,
  normalizeDmRequestDelivery,
  type DmRequestDelivery,
} from "./dmRequestDelivery.js";
import { requestDeliverySchema } from "../../server/requestDeliveryReview.js";

type Part = DmRequestDelivery["parts"][number];
const content = "The public message mentioned a handmade toy. I couldn't obtain today's opening hours.";
const remembered: Part = {
  requestedOutcome: "Recall what was made.", status: "delivered",
  deliveredExcerpt: "a handmade toy",
};
const gap: Part = {
  requestedOutcome: "Supply today's opening hours.", status: "constrained",
  deliveredExcerpt: "I couldn't obtain today's opening hours.",
};
const absent: Part = {
  requestedOutcome: "Explain how the two choices differ.", status: "missing", deliveredExcerpt: null,
};
const assessment = (parts: Part[]): DmRequestDelivery => ({ parts });

describe("DM request-part delivery integrity", () => {
  // These tests prove structural aggregation, not whether a model's verdict
  // describes the question or facts correctly. That requires the live eval.
  it("normalizes one or several delivered outcomes to the legacy contract", () => {
    const second = { ...remembered, requestedOutcome: "Identify where it was mentioned.", deliveredExcerpt: "The public message" };
    expect(normalizeDmRequestDelivery(assessment([remembered, second]), content)).toEqual({
      status: "delivered", resolvedOutcome: "Recall what was made.; Identify where it was mentioned.",
      deliveredExcerpt: "a handmade toy",
    });
  });

  it("accepts independently delivered memory and a concretely constrained external part", () => {
    expect(normalizeDmRequestDelivery(assessment([remembered, gap]), content)).toEqual({
      status: "constrained", resolvedOutcome: "Recall what was made.; Supply today's opening hours.",
      deliveredExcerpt: "a handmade toy",
    });
  });

  it("does not let a delivered or constrained part conceal any missing requested outcome", () => {
    for (const parts of [[remembered, absent], [gap, absent], [remembered, gap, absent]]) {
      expect(normalizeDmRequestDelivery(assessment(parts), content)?.status).toBe("missing");
    }
  });

  it("keeps an all-missing assessment explicit without fabricating a supporting excerpt", () => {
    expect(normalizeDmRequestDelivery(assessment([absent]), content)).toEqual({
      status: "missing", resolvedOutcome: absent.requestedOutcome, deliveredExcerpt: null,
    });
  });

  it.each(["delivered", "constrained"] as const)("requires an exact nonempty candidate excerpt for every %s part", (status) => {
    for (const deliveredExcerpt of [null, "", "  ", "an invented quotation", "A handmade toy"]) {
      expect(normalizeDmRequestDelivery(assessment([{ ...remembered, status, deliveredExcerpt }]), content)).toBeUndefined();
    }
    expect(normalizeDmRequestDelivery(assessment([{ ...remembered, status }]), content)?.status).toBe(status);
  });

  it("rejects a nonmatching optional excerpt even on a missing part", () => {
    expect(normalizeDmRequestDelivery(assessment([{ ...absent, deliveredExcerpt: "someone else's draft" }]), content)).toBeUndefined();
    expect(normalizeDmRequestDelivery(assessment([{ ...absent, deliveredExcerpt: "public message" }]), content)?.status).toBe("missing");
  });

  it("does not accept the first correct excerpt as a substitute for validating all parts", () => {
    expect(normalizeDmRequestDelivery(assessment([remembered, { ...gap, deliveredExcerpt: "hours are confirmed" }]), content)).toBeUndefined();
  });

  it("rejects empty, oversized or repeated trimmed outcomes", () => {
    for (const requestedOutcome of ["", "  ", "x".repeat(221)]) {
      expect(normalizeDmRequestDelivery(assessment([{ ...remembered, requestedOutcome }]), content)).toBeUndefined();
    }
    expect(normalizeDmRequestDelivery(assessment([remembered, remembered]), content)).toBeUndefined();
    expect(normalizeDmRequestDelivery(assessment([remembered, { ...remembered, requestedOutcome: ` ${remembered.requestedOutcome} ` }]), content)).toBeUndefined();
    expect(dmRequestDeliverySchema.safeParse(assessment([remembered, remembered])).success).toBe(false);
  });

  it("normalizes the explicit empty non-owner shape without claiming role eligibility", () => {
    expect(normalizeDmRequestDelivery(assessment([]), content)).toEqual({
      status: "not_due", resolvedOutcome: null, deliveredExcerpt: null,
    });
  });

  it("does not accept an extra coverage label that could conflate uncertain facts with missing delivery", () => {
    for (const coverage of ["complete", "uncertain", "not_due"]) {
      expect(normalizeDmRequestDelivery({ ...assessment([remembered]), coverage }, content)).toBeUndefined();
    }
  });

  it("has strict bounded schema fields and no per-part not-due opt-out", () => {
    const valid = assessment([remembered]);
    for (const invalid of [
      null, {}, { ...valid, coverage: "unknown" }, { ...valid, additional: true },
      { ...valid, parts: Array.from({ length: 7 }, (_, index) => ({ ...remembered, requestedOutcome: `Part ${index}` })) },
      { ...valid, parts: [{ ...remembered, status: "not_due" }] },
      { ...valid, parts: [{ ...remembered, other: true }] },
      { ...valid, parts: [{ ...remembered, deliveredExcerpt: "x".repeat(301) }] },
    ]) expect(normalizeDmRequestDelivery(invalid, content)).toBeUndefined();
  });

  it("bounds the legacy summary without mutating the per-part assessment", () => {
    const parts = Array.from({ length: 6 }, (_, index) => ({ ...remembered, requestedOutcome: `Part ${index} ${"x".repeat(200)}` }));
    const value = assessment(parts);
    const original = structuredClone(value);
    const result = normalizeDmRequestDelivery(value, content);
    expect(result?.resolvedOutcome).toHaveLength(220);
    expect(requestDeliverySchema.safeParse(result).success).toBe(true);
    expect(value).toEqual(original);
  });

  it.each([
    ["Vi börjar med den lilla modellen.", "den lilla modellen"],
    ["Nous comparons les deux versions.", "les deux versions"],
    ["Die beiden Versionen sind unterschiedlich.", "beiden Versionen"],
    ["نتحدث عن الذكرى العامة فقط.", "الذكرى العامة"],
  ])("uses exact span membership without language-specific rules: %s", (candidate, deliveredExcerpt) => {
    expect(normalizeDmRequestDelivery(assessment([{ ...remembered, deliveredExcerpt }]), candidate)?.status).toBe("delivered");
  });

  it("publishes the same bounded shape in the model JSON schema", () => {
    expect(dmRequestDeliveryJsonSchema.additionalProperties).toBe(false);
    expect(dmRequestDeliveryJsonSchema.required).toEqual(["parts"]);
    expect(dmRequestDeliveryJsonSchema.properties.parts).toMatchObject({ minItems: 0, maxItems: 6 });
    expect(dmRequestDeliveryJsonSchema.properties.parts.items.properties.requestedOutcome.maxLength).toBe(220);
    expect(dmRequestDeliveryJsonSchema.properties.parts.items.properties.deliveredExcerpt.maxLength).toBe(300);
    expect(dmRequestDeliveryJsonSchema.properties.parts.items.required).toEqual(["requestedOutcome", "status", "deliveredExcerpt"]);
  });
});
