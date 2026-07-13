import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PERSONAS } from "./personas.js";

describe("resident portrait assets", () => {
  it("gives every resident a unique local WebP with a glyph fallback", () => {
    const imageUrls = PERSONAS.map((persona) => persona.avatar.imageUrl);

    expect(PERSONAS).toHaveLength(20);
    expect(imageUrls.every((imageUrl) => /^\/avatars\/[a-z]+\.webp$/u.test(imageUrl ?? ""))).toBe(true);
    expect(new Set(imageUrls).size).toBe(PERSONAS.length);

    for (const persona of PERSONAS) {
      expect(persona.avatar.glyph).toBeTruthy();
      expect(existsSync(resolve(process.cwd(), "public", persona.avatar.imageUrl!.slice(1)))).toBe(true);
    }
  });
});
