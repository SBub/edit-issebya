import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical-json.ts";
import {
  FOOTAGE_FILE,
  type FootageFacts,
  checkFootage,
  footageFacts,
  footageRefusal,
  storedFacts,
} from "./check-footage.ts";
import { formatClipLength } from "./footage-limits.ts";

function probe(name: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
  return readFileSync(new URL(`testdata/footage/${name}`, import.meta.url), "utf8");
}

function verdict(name: string): string | null {
  return footageRefusal(footageFacts(probe(name)));
}

// The portrait fixture with one thing changed.
function portrait(change: (facts: FootageFacts) => FootageFacts): string | null {
  return footageRefusal(change(footageFacts(probe("portrait.json"))));
}

describe("footageFacts", () => {
  it("normalises a portrait probe", () => {
    expect(footageFacts(probe("portrait.json"))).toEqual({
      readable: true,
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      video: { width: 1080, height: 1920, rotation: 0 },
      audio: true,
      durationSeconds: 42,
    });
  });

  it("reads the rotation from the display matrix, else the legacy tag", () => {
    expect(footageFacts(probe("rotated-portrait.json")).video?.rotation).toBe(270);
    const tagged = JSON.parse(probe("landscape.json"));
    tagged.streams[0].tags = { rotate: "90" };
    expect(footageFacts(JSON.stringify(tagged)).video?.rotation).toBe(90);
    tagged.streams[0].tags = { rotate: "180" };
    expect(footageFacts(JSON.stringify(tagged)).video?.rotation).toBe(180);
  });

  it("skips a cover image as the video", () => {
    const cover = JSON.parse(probe("no-audio.json"));
    cover.streams[0].disposition = { attached_pic: 1 };
    cover.streams.push({ codec_type: "audio", codec_name: "mp3" });
    expect(footageFacts(JSON.stringify(cover)).video).toBeNull();
  });

  it("is unreadable without ffprobe's answer or with text that is not one", () => {
    for (const json of [null, "not json", "[]", "{}"]) {
      expect(footageFacts(json).readable).toBe(false);
    }
  });
});

describe("footageRefusal", () => {
  it("accepts a portrait clip with sound", () => {
    expect(verdict("portrait.json")).toBeNull();
  });

  it("refuses a landscape clip", () => {
    expect(verdict("landscape.json")).toBe(
      "This clip is landscape (1920 x 1080); the studio takes vertical footage only.",
    );
  });

  it("accepts a portrait clip stored landscape with rotation -90", () => {
    expect(verdict("rotated-portrait.json")).toBeNull();
  });

  it("turns the dimensions for 90 and 270, never for 180", () => {
    for (const rotation of [90, 270] as const) {
      expect(
        footageRefusal({
          ...footageFacts(probe("landscape.json")),
          video: { width: 1920, height: 1080, rotation },
        }),
      ).toBeNull();
    }
    expect(
      footageRefusal({
        ...footageFacts(probe("landscape.json")),
        video: { width: 1920, height: 1080, rotation: 180 },
      }),
    ).toMatch(/landscape/);
  });

  it("refuses a square clip as square", () => {
    expect(portrait((f) => ({ ...f, video: { width: 1080, height: 1080, rotation: 0 } }))).toBe(
      "This clip is square (1080 x 1080); the studio takes vertical footage only.",
    );
  });

  it("refuses a clip without sound", () => {
    expect(verdict("no-audio.json")).toBe("This clip has no sound; the studio needs the voice.");
  });

  it("refuses a 130-second clip with the exact message", () => {
    expect(verdict("long-130s.json")).toBe(
      "This clip is 2 minutes 10 seconds; the studio takes up to 1 minute 30 seconds.",
    );
  });

  it("accepts exactly 90 seconds and refuses 90.4 as 1 minute 31 seconds", () => {
    expect(portrait((f) => ({ ...f, durationSeconds: 90 }))).toBeNull();
    expect(portrait((f) => ({ ...f, durationSeconds: 90.4 }))).toBe(
      "This clip is 1 minute 31 seconds; the studio takes up to 1 minute 30 seconds.",
    );
  });

  it("refuses a still image, an audio-only file and unreadable files as not a video", () => {
    const notVideo = "This file is not a video the studio can read.";
    expect(verdict("still-image.json")).toBe(notVideo);
    expect(verdict("text-file.json")).toBe(notVideo);
    expect(footageRefusal(footageFacts(null))).toBe(notVideo);
    expect(portrait((f) => ({ ...f, video: null }))).toBe(notVideo);
    expect(portrait((f) => ({ ...f, durationSeconds: null }))).toBe(notVideo);
  });

  it("gives every sentence a landscape 130-second clip earns, in order", () => {
    expect(
      footageRefusal({
        ...footageFacts(probe("long-130s.json")),
        video: { width: 1920, height: 1080, rotation: 0 },
      }),
    ).toBe(
      "This clip is landscape (1920 x 1080); the studio takes vertical footage only. " +
        "This clip is 2 minutes 10 seconds; the studio takes up to 1 minute 30 seconds.",
    );
  });
});

describe("formatClipLength", () => {
  it.each([
    [45, "45 seconds"],
    [1, "1 second"],
    [0.2, "1 second"],
    [60, "1 minute"],
    [61, "1 minute 1 second"],
    [90, "1 minute 30 seconds"],
    [130, "2 minutes 10 seconds"],
  ])("%s is %s", (seconds, text) => {
    expect(formatClipLength(seconds)).toBe(text);
  });
});

describe("the check_footage gate", () => {
  const encode = (facts: FootageFacts) => new TextEncoder().encode(canonicalJson(facts));

  it("judges the stored facts", () => {
    expect(
      checkFootage.gate!({ [FOOTAGE_FILE]: encode(footageFacts(probe("portrait.json"))) }),
    ).toBe(null);
    expect(
      checkFootage.gate!({ [FOOTAGE_FILE]: encode(footageFacts(probe("landscape.json"))) }),
    ).toMatch(/landscape/);
  });

  it("refuses to judge something that is not the facts", () => {
    expect(() => storedFacts(new TextEncoder().encode("{}"))).toThrow(/not footage facts/);
  });
});
