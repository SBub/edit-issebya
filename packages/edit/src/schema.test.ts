import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ISSEBYA } from "./preset.ts";
import { editJsonSchemaBase, parseEdit } from "./schema.ts";
import type { Transcript } from "./transcript.ts";
import { type Fixture, fixtures } from "./testdata/node.ts";

let all: Fixture[];
let short: Fixture;

beforeAll(async () => {
  all = await fixtures();
  short = all.find((fixture) => fixture.name === "short-speech-baseline")!;
});

type Tracks = Record<string, Record<string, unknown>[]>;

// The short-speech baseline with one change to its tracks.
function variant(change: (tracks: Tracks) => void): unknown {
  const edit = structuredClone(short.edit) as { tracks: Tracks };
  change(edit.tracks);
  return edit;
}

function rejects(edit: unknown, message: RegExp, transcript: Transcript = short.transcript) {
  expect(() => parseEdit(edit, { transcript, preset: ISSEBYA })).toThrow(message);
}

describe("parseEdit", () => {
  it("parses every fixture version", () => {
    for (const fixture of all) {
      const edit = parseEdit(fixture.edit, { transcript: fixture.transcript, preset: ISSEBYA });
      expect(edit.format).toBe(1);
    }
  });

  it("parses a JSON string", () => {
    const edit = parseEdit(JSON.stringify(short.edit), {
      transcript: short.transcript,
      preset: ISSEBYA,
    });
    expect(edit.tracks.captions.length).toBe(short.transcript.words.length);
  });

  it("rejects an unknown word id, naming the item", () => {
    rejects(
      variant((tracks) => {
        tracks.captions![0]!.start = { word: "w9999" };
      }),
      /c-w0001: unknown word w9999/,
    );
  });

  it("rejects an item whose end resolves before its start", () => {
    rejects(
      variant((tracks) => {
        tracks.captions![1]!.end = { word: "w0001", edge: "start" };
      }),
      /c-w0002: ends at 0\.038, not after its start 0\.267/,
    );
  });

  it("rejects a font outside the preset", () => {
    rejects(
      variant((tracks) => {
        tracks.captions![2]!.style = { font: "comic" };
      }),
      /c-w0003: font "comic" is not in the preset/,
    );
  });

  it("rejects a time anchor inside a spoken word, and allows a word boundary", () => {
    const word = short.transcript.words[3]!;
    rejects(
      variant((tracks) => {
        tracks.overlays!.push({
          id: "pause",
          start: { at: (word.start + word.end) / 2 },
          end: { at: 2.5 },
          text: "x",
        });
      }),
      /pause: time [\d.]+ falls inside the spoken word w0004/,
    );
    const atEnd = variant((tracks) => {
      tracks.overlays!.push({
        id: "pause",
        start: { at: word.end },
        end: { word: "w0006" },
        text: "x",
      });
    });
    expect(() => parseEdit(atEnd, { transcript: short.transcript, preset: ISSEBYA })).not.toThrow();
  });

  it("rejects a duplicate item id", () => {
    rejects(
      variant((tracks) => {
        tracks.captions![1]!.id = "c-w0001";
      }),
      /c-w0001: duplicate item id/,
    );
  });

  it("rejects a custom style that could leave the attribute or load anything", () => {
    for (const custom of [
      "color: red} body {color: blue",
      "background: url(https://x.test/a.png)",
      'a"b',
    ]) {
      rejects(
        variant((tracks) => {
          tracks.captions![0]!.custom = custom;
        }),
        /c-w0001: custom style may/,
      );
    }
  });

  it("rejects an unknown sound and transition, and a malformed fingerprint", () => {
    rejects(
      variant((tracks) => {
        tracks.sounds!.push({
          id: "s1",
          sound: "boom",
          start: { word: "w0002" },
          end: { word: "w0002" },
        });
      }),
      /s1: sound "boom" is not in the preset/,
    );
    rejects(
      variant((tracks) => {
        tracks.transitions!.push({
          id: "t1",
          type: "wipe",
          start: { word: "w0002" },
          end: { word: "w0003" },
        });
      }),
      /t1: transition "wipe" is not in the preset/,
    );
    const edit = structuredClone(short.edit) as { inputs: Record<string, string> };
    edit.inputs.footage = "abc";
    rejects(edit, /inputs\.footage: a fingerprint is 64 lower-case hex digits/);
  });

  it("lists every issue at once", () => {
    const edit = variant((tracks) => {
      tracks.captions![0]!.start = { word: "w9999" };
      tracks.captions![2]!.style = { font: "comic" };
    });
    expect(() => parseEdit(edit, { transcript: short.transcript, preset: ISSEBYA })).toThrow(
      /c-w0001: unknown word w9999\nc-w0003: font "comic" is not in the preset/,
    );
  });
});

describe("editJsonSchemaBase", () => {
  it("converts to a JSON Schema", () => {
    const schema = z.toJSONSchema(editJsonSchemaBase()) as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties).sort()).toEqual(["format", "inputs", "tracks"]);
  });
});
