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

  it("accepts an edit with a cut-out (stored) and one without (new)", () => {
    expect(hand.edit.inputs.cutout).toBeDefined();
    expect(parseEdit(hand.edit, ISSEBYA_PRESET, hand.transcript)).toMatchObject({ ok: true });
    const edit = structuredClone(hand.edit);
    delete edit.inputs.cutout;
    delete edit.tracks.cutout;
    const result = parseEdit(edit, ISSEBYA_PRESET, hand.transcript);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.edit.tracks).not.toHaveProperty("cutout");
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

  it("accepts a frame-wide position without limits, refuses it with the safe box", () => {
    const json = withCaption((caption) => (caption.position = { x: 900, y: 700, align: "left" }));
    expect(parseEdit(json, ISSEBYA_PRESET, hand.transcript)).toMatchObject({ ok: true });
    const bounded = parseEdit(json, ISSEBYA_PRESET, hand.transcript, {
      bounds: ISSEBYA_PRESET.safe,
    });
    expect(bounded.ok).toBe(false);
  });

  it("converts to JSON Schema, listing the reel's word ids", () => {
    const schema = z.toJSONSchema(editSchemaFor(ISSEBYA_PRESET, hand.transcript)) as object;
    expect(JSON.stringify(schema)).toContain('"w161"');
  });
});

describe("the behind track", () => {
  const behind = FIXTURES.find((fixture) => fixture.name === "rethink-work-behind")!;
  const PHOTO = "3f6c1a52-8e4d-4b7a-9c21-5d0e8f7b6a14";

  function withItems(items: unknown[]): unknown {
    const edit = structuredClone(behind.edit) as unknown as { tracks: { behind: unknown[] } };
    edit.tracks.behind = items;
    return edit;
  }

  function behindReasons(json: unknown): string[] {
    const result = parseEdit(json, ISSEBYA_PRESET, behind.transcript);
    if (result.ok) throw new Error("expected the edit to be refused");
    return result.reasons;
  }

  const photo = (start: number, end: number, id = "p") => ({
    id,
    kind: "photo",
    photo_id: PHOTO,
    spot: "left",
    start: { time: start },
    end: { time: end },
  });

  it("parses a stored version without the track or masks, and one with both kinds", () => {
    const old = structuredClone(hand.edit);
    expect(old.tracks).not.toHaveProperty("behind");
    expect(old.inputs).not.toHaveProperty("masks");
    expect(parseEdit(old, ISSEBYA_PRESET, hand.transcript)).toMatchObject({ ok: true });
    const parsed = parseEdit(behind.edit, ISSEBYA_PRESET, behind.transcript);
    expect(parsed.ok && parsed.edit.tracks.behind?.map((item) => item.kind)).toEqual([
      "photo",
      "word",
    ]);
    expect(parsed.ok && parsed.edit.inputs.photos).toEqual([PHOTO]);
  });

  it("refuses an item under 2 s or over 4 s", () => {
    expect(behindReasons(withItems([photo(10, 11.5)])).join("\n")).toMatch(
      /behind p: lasts 1\.500 s, must be 2 to 4 s/,
    );
    expect(behindReasons(withItems([photo(10, 14.5)])).join("\n")).toMatch(
      /behind p: lasts 4\.500 s, must be 2 to 4 s/,
    );
  });

  it("refuses two items at the same time", () => {
    expect(behindReasons(withItems([photo(10, 13, "a"), photo(12, 15, "b")])).join("\n")).toMatch(
      /behind b: overlaps behind a; only one at a time/,
    );
  });

  it("refuses an item over a hidden stretch of footage", () => {
    const edit = withItems([photo(10, 13)]) as {
      tracks: { footage: { hidden?: unknown[] }[] };
    };
    edit.tracks.footage[0]!.hidden = [{ start: { time: 12 }, end: { time: 12.5 } }];
    expect(behindReasons(edit).join("\n")).toMatch(/behind p: overlaps a hidden span of footage/);
  });

  it("refuses two words, markup, an unknown spot and a photo id that is not a UUID", () => {
    const word = (text: string) => ({
      id: "w",
      kind: "word",
      text,
      start: { time: 10 },
      end: { time: 13 },
    });
    expect(behindReasons(withItems([word("big word")])).length).toBeGreaterThan(0);
    expect(behindReasons(withItems([word("<b>")])).length).toBeGreaterThan(0);
    expect(behindReasons(withItems([word("a".repeat(25))])).length).toBeGreaterThan(0);
    expect(behindReasons(withItems([{ ...photo(10, 13), spot: "middle" }])).length).toBeGreaterThan(
      0,
    );
    expect(
      behindReasons(withItems([{ ...photo(10, 13), photo_id: "photo-1" }])).length,
    ).toBeGreaterThan(0);
  });

  describe("with the decide counts", () => {
    const counts = { behindCounts: { photos: 2, words: 1 } };
    const word = (start: number, end: number, id = "w") => ({
      id,
      kind: "word",
      text: "WORK",
      start: { time: start },
      end: { time: end },
    });
    const limited = (json: unknown) => parseEdit(json, ISSEBYA_PRESET, behind.transcript, counts);

    it("refuses a third photo, naming it", () => {
      const json = withItems([photo(1, 4, "a"), photo(10, 13, "b"), photo(20, 23, "c")]);
      const result = limited(json);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reasons.join("\n")).toMatch(
        /behind c: a third photo; at most 2 photos per reel/,
      );
      expect(!result.ok && result.reasons.join("\n")).not.toMatch(/behind b:/);
    });

    it("refuses a second big word", () => {
      const result = limited(withItems([word(1, 4, "a"), word(10, 13, "b")]));
      expect(!result.ok && result.reasons.join("\n")).toMatch(
        /behind b: a second big word; at most 1 per reel/,
      );
    });

    it("accepts two photos and one word", () => {
      const json = withItems([photo(1, 4, "a"), photo(10, 13, "b"), word(20, 23)]);
      expect(limited(json)).toMatchObject({ ok: true });
    });

    it("caps the array in the JSON Schema", () => {
      const schema = z.toJSONSchema(editSchemaFor(ISSEBYA_PRESET, behind.transcript, counts), {
        io: "output",
        reused: "inline",
      }) as unknown as {
        properties: { tracks: { properties: { behind: { maxItems?: number } } } };
      };
      expect(schema.properties.tracks.properties.behind.maxItems).toBe(3);
    });

    it("still refuses a 5-second photo", () => {
      const result = limited(withItems([photo(10, 15)]));
      expect(!result.ok && result.reasons.join("\n")).toMatch(
        /behind p: lasts 5\.000 s, must be 2 to 4 s/,
      );
    });
  });

  it("parses three photos without the counts (stored versions are not limited)", () => {
    const json = withItems([photo(1, 4, "a"), photo(10, 13, "b"), photo(20, 23, "c")]);
    expect(parseEdit(json, ISSEBYA_PRESET, behind.transcript)).toMatchObject({ ok: true });
  });

  it("limits photos to the given library", () => {
    const json = withItems([photo(10, 13)]);
    expect(parseEdit(json, ISSEBYA_PRESET, behind.transcript, { photoIds: [PHOTO] }).ok).toBe(true);
    expect(parseEdit(json, ISSEBYA_PRESET, behind.transcript, { photoIds: [] }).ok).toBe(false);
  });
});

describe("parseEdit with phrase transitions", () => {
  const transitions = FIXTURES.find((fixture) => fixture.name === "rethink-work-transitions")!;

  function withTransition(change: Record<string, unknown>): unknown {
    const edit = structuredClone(transitions.edit) as unknown as {
      tracks: { transitions: Record<string, unknown>[] };
    };
    Object.assign(edit.tracks.transitions[2]!, change);
    return edit;
  }

  function refusedOf(json: unknown): string {
    const result = parseEdit(json, ISSEBYA_PRESET, transitions.transcript);
    if (result.ok) throw new Error("expected the edit to be refused");
    return result.reasons.join("\n");
  }

  it("accepts a phrase transition and keeps it without times", () => {
    const result = parseEdit(transitions.edit, ISSEBYA_PRESET, transitions.transcript);
    expect(result.ok).toBe(true);
    const item = result.ok ? result.edit.tracks.transitions[2]! : null;
    expect(item).toEqual({ id: "t-want", type: "dim", from: "w145", key_from: "w158", to: "w161" });
    expect(item).not.toHaveProperty("start");
  });

  it("still accepts a stored timed panel and a stored timed card", () => {
    const panel = hand.edit.tracks.transitions[0]!;
    expect(panel).toHaveProperty("start");
    expect(parseEdit(hand.edit, ISSEBYA_PRESET, hand.transcript)).toMatchObject({ ok: true });
    const edit = structuredClone(hand.edit);
    edit.tracks.transitions = [{ ...panel, type: "card" } as (typeof edit.tracks.transitions)[0]];
    expect(parseEdit(edit, ISSEBYA_PRESET, hand.transcript)).toMatchObject({ ok: true });
  });

  it("refuses a phrase card", () => {
    expect(refusedOf(withTransition({ type: "card" }))).toMatch(/transitions\[2\]/);
  });

  it("refuses a key phrase starting outside the phrase", () => {
    expect(refusedOf(withTransition({ key_from: "w12" }))).toContain(
      "transition t-want: key_from w12 is outside the phrase w145 to w161",
    );
  });

  it("refuses a last word before the first", () => {
    expect(refusedOf(withTransition({ from: "w161", to: "w145", key_from: undefined }))).toContain(
      "transition t-want: its last word w145 comes before its first word w161",
    );
  });

  it("refuses numbered without its number and dim with one", () => {
    expect(refusedOf(withTransition({ type: "numbered" }))).toContain(
      "transition t-want: numbered needs its number",
    );
    expect(refusedOf(withTransition({ number: 2 }))).toContain(
      "transition t-want: only numbered takes a number, not dim",
    );
  });

  it("refuses motion_seconds and hold_seconds outside their ranges", () => {
    expect(refusedOf(withTransition({ motion_seconds: 3 }))).toMatch(/motion_seconds/);
    expect(refusedOf(withTransition({ motion_seconds: 0.1 }))).toMatch(/motion_seconds/);
    expect(refusedOf(withTransition({ hold_seconds: 2.5 }))).toMatch(/hold_seconds/);
    expect(
      parseEdit(
        withTransition({ motion_seconds: 0.8, hold_seconds: 0 }),
        ISSEBYA_PRESET,
        transitions.transcript,
      ),
    ).toMatchObject({ ok: true });
  });
});
