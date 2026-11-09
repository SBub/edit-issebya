import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SAFE_ZONE } from "./engine-zones.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import { editSchemaFor, parseEdit } from "./schema.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { timingOf, VARIANTS } from "./variants.ts";

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

describe("line breaks", () => {
  const parsed = (breaks: number[]) =>
    parseEdit(
      withCaption((caption) => (caption.breaks = breaks)),
      ISSEBYA_PRESET,
      hand.transcript,
    );

  it("parses breaks that ascend, and refuses breaks that do not or are below one", () => {
    expect(parsed([3, 7])).toMatchObject({ ok: true });
    expect(parsed([3])).toMatchObject({ ok: true });
    expect(reasons(withCaption((caption) => (caption.breaks = [7, 3]))).join("\n")).toContain(
      "breaks ascend",
    );
    expect(reasons(withCaption((caption) => (caption.breaks = [0]))).length).toBeGreaterThan(0);
  });
});

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
    expect(reasons(edit).join("\n")).toContain(
      "hidden by hook, which is no accent, big word or list",
    );
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

  it("parses an edit with no whole-clip cut-out input or track", () => {
    const result = parseEdit(hand.edit, ISSEBYA_PRESET, hand.transcript);
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.edit.inputs).not.toHaveProperty("cutout");
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
    const json = withCaption((caption) => (caption.position = { x: 1060, y: 700, align: "left" }));
    expect(parseEdit(json, ISSEBYA_PRESET, hand.transcript)).toMatchObject({ ok: true });
    const bounded = parseEdit(json, ISSEBYA_PRESET, hand.transcript, {
      bounds: SAFE_ZONE.box,
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

  it("parses the engine's phrase, key, number and levels", () => {
    expect(parse(() => {})).toMatchObject({ ok: true });
    expect(transitions.edit.tracks.transitions.map((item) => item.type)).toEqual([
      "numbered",
      "numbered",
    ]);
  });

  it("refuses a kind but numbered: no dim, panel or card", () => {
    for (const kind of ["dim", "panel", "card"]) {
      const refused = parse((item) => (item.type = kind));
      expect(refused.ok, kind).toBe(false);
      expect(refused.ok ? [] : refused.reasons.join("\n"), kind).toMatch(/transitions\[1\]\.type/);
    }
  });

  it("refuses a key outside its words and a transition without words", () => {
    const outside = parse((item) => (item.key = "w0"));
    expect(outside.ok ? [] : outside.reasons).toContain(
      "edit: transition transition-2: its key phrase starts on w0, outside its words",
    );
    const bare = parse((item) => delete item.words);
    expect(bare.ok ? [] : bare.reasons.join("\n")).toMatch(
      /^item transition-2 \(transitions\[1\]\.words\): /m,
    );
  });
});

describe("the behind track", () => {
  const behind = FIXTURES.find((fixture) => fixture.name === "rethink-work-behind")!;

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

  // A VISUAL with its box, over the footage.
  const visual = (start: number, end: number, id = "p") => ({
    id,
    kind: "visual",
    box: { x: 40, y: 560, width: 460, height: 620 },
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
      "visual",
      "word",
    ]);
  });

  it("parses a visual's box, and refuses bad ones", () => {
    const parse = (json: unknown) => parseEdit(json, ISSEBYA_PRESET, behind.transcript);
    const box = { x: 110, y: 220, width: 640, height: 480 };
    const placed = parse(withItems([{ ...visual(10, 13), box }]));
    expect(placed.ok && placed.edit.tracks.behind?.[0]).toMatchObject({ box });
    expect(placed.ok && placed.edit.tracks.behind?.[0]).not.toHaveProperty("layer");
    expect(
      behindReasons(withItems([{ ...visual(10, 13), box: { ...box, width: 0 } }])).length,
    ).toBeGreaterThan(0);
    expect(
      behindReasons(withItems([{ ...visual(10, 13), box: { ...box, x: 1.5 } }])).length,
    ).toBeGreaterThan(0);
  });

  it("refuses a visual without its box", () => {
    const boxless: Record<string, unknown> = { ...visual(10, 13) };
    delete boxless.box;
    expect(behindReasons(withItems([boxless])).length).toBeGreaterThan(0);
  });

  it("refuses an item over a hidden stretch of footage", () => {
    const edit = withItems([visual(10, 13)]) as {
      tracks: { footage: { hidden?: unknown[] }[] };
    };
    edit.tracks.footage[0]!.hidden = [{ start: { time: 12 }, end: { time: 12.5 } }];
    expect(behindReasons(edit).join("\n")).toMatch(/behind p: overlaps a hidden span of footage/);
  });

  it("refuses three words, markup and a long word", () => {
    const word = (text: string) => ({
      id: "w",
      kind: "word",
      text,
      start: { time: 10 },
      end: { time: 13 },
    });
    expect(behindReasons(withItems([word("big word three")])).length).toBeGreaterThan(0);
    expect(behindReasons(withItems([word("<b>")])).length).toBeGreaterThan(0);
    expect(behindReasons(withItems([word("a".repeat(25))])).length).toBeGreaterThan(0);
  });

  describe("with the decide limit on lengths", () => {
    const lengths = { behindLengths: true };
    // A big word on the spoken word at `index`, from the lead before it to
    // `after` seconds after it (by default as the engine times it: a second
    // after, at least the accent's minimum).
    const { lead: leadSeconds, minimum: accentMin } = timingOf(
      VARIANTS["bigword/behind"],
      "words-lead",
    );
    const { afterSeconds } = ISSEBYA_PRESET.accent;
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

    it("refuses a visual under 0.5 s or over 2 s", () => {
      const short = limited(withItems([visual(10, 10.3)]));
      expect(!short.ok && short.reasons.join("\n")).toMatch(
        /behind p: lasts 0\.300 s, must be 0\.5 to 2 s/,
      );
      const long = limited(withItems([visual(10, 12.5)]));
      expect(!long.ok && long.reasons.join("\n")).toMatch(
        /behind p: lasts 2\.500 s, must be 0\.5 to 2 s/,
      );
    });

    it("holds a big word to the shown floor at least, and to a second after its word at most", () => {
      // w110 "sense", 0.41 s long: at most 0.2 + 0.41 + 1 = 1.61 s.
      expect(limited(withItems([spoken(110)]))).toMatchObject({ ok: true });
      const short = limited(withItems([spoken(110, "w", -0.2)]));
      expect(!short.ok && short.reasons.join("\n")).toMatch(
        /behind w: lasts 0\.410 s, must be 0\.5 to 1\.61 s/,
      );
      const long = limited(withItems([spoken(110, "w", 1.5)]));
      expect(!long.ok && long.reasons.join("\n")).toMatch(
        /behind w: lasts 2\.110 s, must be 0\.5 to 1\.61 s/,
      );
    });

    it("takes any number of visuals and big words, the same word again too", () => {
      const json = withItems([
        visual(1, 3, "a"),
        spoken(20, "b"),
        visual(10, 12, "c"),
        spoken(64, "d"),
        visual(20, 21.5, "e"),
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
    const json = withItems([visual(1, 4, "a"), visual(10, 10.5, "b"), visual(20, 25, "c")]);
    expect(parseEdit(json, ISSEBYA_PRESET, behind.transcript)).toMatchObject({ ok: true });
  });
});
