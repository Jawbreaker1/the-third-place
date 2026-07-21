import { describe, expect, it } from "vitest";
import { composerAutosizeLayout } from "./composerAutosize";

describe("composer autosize layout", () => {
  it("grows with multiline content until the configured cap", () => {
    expect(composerAutosizeLayout(31, 130)).toEqual({ height: 31, overflowY: "hidden" });
    expect(composerAutosizeLayout(96, 130)).toEqual({ height: 96, overflowY: "hidden" });
  });

  it("keeps the capped height and scrolls only after reaching it", () => {
    expect(composerAutosizeLayout(220, 130)).toEqual({ height: 130, overflowY: "auto" });
  });

  it("fails open when CSS does not provide a finite maximum", () => {
    expect(composerAutosizeLayout(220, Number.NaN)).toEqual({ height: 220, overflowY: "hidden" });
  });
});
