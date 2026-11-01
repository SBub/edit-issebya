import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ISSEBYA_PRESET } from "./preset.ts";
import { editSchemaFor, parseEdit } from "./schema.ts";
import { FIXTURES } from "./test-support/fixtures.ts";

const hand = FIXTURES.find((fixture) => fixture.name === "rethink-work-hand")!;

function withCaption(change: (caption: Record<string, unknown>) => void): unknown {
  const edit = structuredClone(hand.edit) as unknown as {
    tracks: { captions: Record<string, unknown>[] };
  };
  change(edit.tracks.captions[3]!);
  return edit;
}

function reasons(json: unknown): string[] {
  const result = parseEdit(json, ISSEBYA_PRESET, hand.transcript);
  if (result.ok) throw new Error("expected the edit to be refused");
  return result.reasons;
}

describe("parseEdit", () => {
  it("accepts every stored fixture version", () => {
    for (const fixture of FIXTURES) {
      expect(parseEdit(fixture.edit, ISSEBYA_PRESET, fixture.transcript)).toMatchObject({
        ok: true,
      });
    }
  });

  it("refuses an unknown word id, naming the item", () => {
    const [reason] = reasons(withCaption((caption) => (caption.start = { word: "w999" })));
    expect(reason).toMatch(/^item cw3 \(captions\[3\]\.start/);
  });

  it("refuses an item that ends before it starts", () => {
    const found = reasons(withCaption((caption) => (caption.end = { word: "w0" })));
    expect(found.join("\n")).toMatch(/caption cw3: ends \(0\.282 s\) before it starts/);
  });

  it("refuses a font outside the preset", () => {
    expect(reasons(withCaption((caption) => (caption.font = "comic-sans")))[0]).toMatch(
      /^item cw3 \(captions\[3\]\.font\)/,
    );
  });

  it("refuses a malformed colour", () => {
    expect(reasons(withCaption((caption) => (caption.color = "white")))[0]).toMatch(
      /^item cw3 \(captions\[3\]\.color\)/,
    );
  });

  it("refuses style values that could leave the attribute", () => {
    for (const value of ["red; top: 0", "<script>", "url(https://x.test/a.png)", "a\\b", "{x}"]) {
      const found = reasons(withCaption((caption) => (caption.style = { color: value })));
      expect(found[0]).toMatch(/^item cw3 \(captions\[3\]\.style\.color\)/);
    }
  });

  it("refuses an id used twice", () => {
    expect(reasons(withCaption((caption) => (caption.id = "cw0"))).join("\n")).toMatch(
      /caption cw0: id used twice/,
    );
  });

  it("converts to JSON Schema, listing the reel's word ids", () => {
    const schema = z.toJSONSchema(editSchemaFor(ISSEBYA_PRESET, hand.transcript)) as object;
    expect(JSON.stringify(schema)).toContain('"w161"');
  });
});
