import { describe, expect, it } from "vitest";
import { fontPairOfEdit } from "./version-font-pair";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("fontPairOfEdit", () => {
  it("reads the pair the edit was set in", () => {
    expect(fontPairOfEdit(bytes(JSON.stringify({ font_pair: "retro", duration: 9 })))).toBe(
      "retro",
    );
  });

  it("is null without bytes, for a pair outside the six, or for an edit with no pair", () => {
    expect(fontPairOfEdit(null)).toBeNull();
    expect(fontPairOfEdit(bytes(JSON.stringify({ font_pair: "primary" })))).toBeNull();
    expect(fontPairOfEdit(bytes(JSON.stringify({ duration: 9 })))).toBeNull();
  });

  it("is null for bytes that are not JSON or not an object", () => {
    expect(fontPairOfEdit(bytes("not json"))).toBeNull();
    expect(fontPairOfEdit(bytes("null"))).toBeNull();
    expect(fontPairOfEdit(bytes('"classic"'))).toBeNull();
  });
});
