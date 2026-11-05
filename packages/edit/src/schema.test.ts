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

describe("the hook overlay", () => {
  const HOOK = {
    id: "hook",
    kind: "hook",
    text: "Gen Z won't work like you did",
    start: { word: "w0", edge: "end", offset: -0.155 },
    end: { word: "w9", edge: "end", offset: 0.169 },
  };
  const withOverlays = (...overlays: Record<string, unknown>[]) => {
    const edit = structuredClone(hand.edit) as unknown as {
      tracks: { overlays: Record<string, unknown>[]; captions: Record<string, unknown>[] };
    };
    edit.tracks.overlays.push(...overlays);
    return edit;
  };

  it("parses a hook with its own text; a stored version without one parses as before", () => {
    expect(parseEdit(withOverlays(HOOK), ISSEBYA_PRESET, hand.transcript)).toMatchObject({
      ok: true,
    });
    expect(hand.edit.tracks.overlays.every((item) => item.kind === "accent")).toBe(true);
  });

  it("refuses a hook with words or without text, and a second hook", () => {
    expect(reasons(withOverlays({ ...HOOK, words: ["w0"] })).join("\n")).toContain(
      "hook hook: a hook has its own text and no words",
    );
    const noText: Record<string, unknown> = { ...HOOK };
    delete noText.text;
    expect(reasons(withOverlays(noText)).join("\n")).toContain("overlay hook: needs words or text");
    expect(reasons(withOverlays(HOOK, { ...HOOK, id: "hook-2" })).join("\n")).toContain(
      "hook hook-2: only one hook per reel",
    );
  });

  it("never hides a caption: nobody says the hook", () => {
    const edit = withOverlays(HOOK);
    edit.tracks.captions[0]!.hidden_by = "hook";
    expect(reasons(edit).join("\n")).toContain("hidden by hook, which is no accent or big word");
  });
});

describe("parseEdit", () => {
  it("accepts every stored fixture version", () => {
    for (const fixture of FIXTURES) {
      expect(parseEdit(fixture.edit, ISSEBYA_PRESET, fixture.transcript)).toMatchObject({
        ok: true,
      });
    }
  });

  it("accepts a text shadow of level 1 or 2 and nothing else", () => {
    expect(
      parseEdit(
        withCaption((caption) => {
          caption.shadow = 2;
        }),
        ISSEBYA_PRESET,
        hand.transcript,
      ),
    ).toMatchObject({ ok: true });
    expect(
      reasons(
        withCaption((caption) => {
          caption.shadow = 3;
        }),
      ).join("; "),
    ).toMatch(/captions\[3\]\.shadow/);
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

describe("a transition item", () => {
  const transitions = FIXTURES.find((fixture) => fixture.name === "rethink-work-transitions")!;
  const parse = (change: (item: Record<string, unknown>) => void) => {
    const edit = structuredClone(transitions.edit) as unknown as {
      tracks: { transitions: Record<string, unknown>[] };
    };
    change(edit.tracks.transitions[1]!);
    return parseEdit(edit, ISSEBYA_PRESET, transitions.transcript);
  };

  it("parses a stored card and an item without the engine's fields", () => {
    const edit = structuredClone(hand.edit);
    edit.tracks.transitions = [
      { id: "card-a", type: "card", start: { word: "w84" }, end: { word: "w99", edge: "end" } },
    ];
    expect(parseEdit(edit, ISSEBYA_PRESET, hand.transcript)).toMatchObject({ ok: true });
  });

  it("parses the engine's phrase, key, pace, hold, number and levels", () => {
    expect(parse(() => {})).toMatchObject({ ok: true });
    expect(
      parse((item) => {
        item.pace = "slow";
        item.hold = "long";
      }),
    ).toMatchObject({ ok: true });
  });

  it("refuses a key outside its words, levels without words and a number on another kind", () => {
    const outside = parse((item) => (item.key = "w0"));
    expect(outside.ok ? [] : outside.reasons).toContain(
      "edit: transition transition-2: its key phrase starts on w0, outside its words",
    );
    const bare = parse((item) => delete item.words);
    expect(bare.ok ? [] : bare.reasons).toContain(
      "edit: transition transition-2: levels without words",
    );
    const dim = parse((item) => (item.type = "dim"));
    expect(dim.ok ? [] : dim.reasons).toContain(
      "edit: transition transition-2: a number level on a dim transition",
    );
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

  it("parses a photo with its reason, an older one without it, and refuses another reason", () => {
    const parse = (json: unknown) => parseEdit(json, ISSEBYA_PRESET, behind.transcript);
    expect(parse(withItems([photo(10, 13)]))).toMatchObject({ ok: true });
    const mood = parse(withItems([{ ...photo(10, 13), reason: "mood" }]));
    expect(mood.ok && mood.edit.tracks.behind?.[0]).toMatchObject({ reason: "mood" });
    expect(
      behindReasons(withItems([{ ...photo(10, 13), reason: "loose" }])).length,
    ).toBeGreaterThan(0);
  });

  it("parses a photo's layer and box, an older one without them, and refuses bad ones", () => {
    const parse = (json: unknown) => parseEdit(json, ISSEBYA_PRESET, behind.transcript);
    const box = { x: 110, y: 220, width: 640, height: 480 };
    const front = parse(withItems([{ ...photo(10, 13), layer: "front", box }]));
    expect(front.ok && front.edit.tracks.behind?.[0]).toMatchObject({ layer: "front", box });
    expect(parse(withItems([{ ...photo(10, 13), layer: "behind", box }]))).toMatchObject({
      ok: true,
    });
    // Without them (every version saved before): behind, over its spot.
    const old = parse(withItems([photo(10, 13)]));
    expect(old.ok && old.edit.tracks.behind?.[0]).not.toHaveProperty("layer");
    expect(behindReasons(withItems([{ ...photo(10, 13), layer: "over" }])).length).toBeGreaterThan(
      0,
    );
    expect(
      behindReasons(withItems([{ ...photo(10, 13), box: { ...box, width: 0 } }])).length,
    ).toBeGreaterThan(0);
    expect(
      behindReasons(withItems([{ ...photo(10, 13), box: { ...box, x: 1.5 } }])).length,
    ).toBeGreaterThan(0);
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

  describe("with the decide limit on lengths", () => {
    const lengths = { behindLengths: true };
    // A big word on the spoken word at `index`, from the lead before it to
    // `after` seconds after it (by default as the engine times it: a second
    // after, at least the accent's minimum).
    const { leadSeconds, minSeconds: accentMin, afterSeconds } = ISSEBYA_PRESET.accent;
    const spoken = (index: number, id = "w", after?: number) => {
      const said = behind.transcript.words[index]!;
      const length = said.end - said.start;
      return {
        id,
        kind: "word",
        text: "WORK",
        start: { word: said.id, offset: -leadSeconds },
        end: {
          word: said.id,
          edge: "end",
          offset: after ?? Math.max(afterSeconds, accentMin - leadSeconds - length),
        },
      };
    };
    const limited = (json: unknown) => parseEdit(json, ISSEBYA_PRESET, behind.transcript, lengths);

    it("refuses a photo under 1 s or over 2 s", () => {
      const short = limited(withItems([photo(10, 10.5)]));
      expect(!short.ok && short.reasons.join("\n")).toMatch(
        /behind p: lasts 0\.500 s, must be 1 to 2 s/,
      );
      const long = limited(withItems([photo(10, 12.5)]));
      expect(!long.ok && long.reasons.join("\n")).toMatch(
        /behind p: lasts 2\.500 s, must be 1 to 2 s/,
      );
    });

    it("holds a big word to the accent's timing: at least 1.5 s, at most a second after its word", () => {
      // w110 "sense", 0.41 s long: at most 0.2 + 0.41 + 1 = 1.61 s.
      expect(limited(withItems([spoken(110)]))).toMatchObject({ ok: true });
      const short = limited(withItems([spoken(110, "w", 0.5)]));
      expect(!short.ok && short.reasons.join("\n")).toMatch(
        /behind w: lasts 1\.110 s, must be 1\.5 to 1\.61 s/,
      );
      const long = limited(withItems([spoken(110, "w", 1.5)]));
      expect(!long.ok && long.reasons.join("\n")).toMatch(
        /behind w: lasts 2\.110 s, must be 1\.5 to 1\.61 s/,
      );
    });

    it("takes any number of photos and big words, the same word again too", () => {
      const json = withItems([
        photo(1, 3, "a"),
        spoken(20, "b"),
        photo(10, 12, "c"),
        spoken(64, "d"),
        photo(20, 21.5, "e"),
        spoken(110, "f"),
      ]);
      expect(limited(json)).toMatchObject({ ok: true });
    });

    it("leaves the array uncapped in the JSON Schema", () => {
      const schema = z.toJSONSchema(editSchemaFor(ISSEBYA_PRESET, behind.transcript, lengths), {
        io: "output",
        reused: "inline",
      }) as unknown as {
        properties: { tracks: { properties: { behind: { maxItems?: number } } } };
      };
      expect(schema.properties.tracks.properties.behind.maxItems).toBeUndefined();
    });
  });

  it("parses any length without the limit (stored versions keep older lengths)", () => {
    const json = withItems([photo(1, 4, "a"), photo(10, 10.5, "b"), photo(20, 25, "c")]);
    expect(parseEdit(json, ISSEBYA_PRESET, behind.transcript)).toMatchObject({ ok: true });
  });

  it("limits photos to the given library", () => {
    const json = withItems([photo(10, 13)]);
    expect(parseEdit(json, ISSEBYA_PRESET, behind.transcript, { photoIds: [PHOTO] }).ok).toBe(true);
    expect(parseEdit(json, ISSEBYA_PRESET, behind.transcript, { photoIds: [] }).ok).toBe(false);
  });
});
