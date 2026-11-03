import { describe, expect, it } from "vitest";
import {
  UNKNOWN_SIZE,
  createReelSizeHolder,
  readReelSize,
  reelSizeAttributes,
} from "./reel-size.ts";

const FULL = {
  sourceSeconds: 52.4,
  sourceBytes: 104_857_600,
  width: 1080,
  height: 1920,
  footageSeconds: 41.2,
  wordCount: 130,
};

describe("reelSizeAttributes", () => {
  it("names every known value", () => {
    expect(reelSizeAttributes(FULL)).toEqual({
      "reel.source_seconds": 52.4,
      "reel.source_bytes": 104_857_600,
      "reel.width": 1080,
      "reel.height": 1920,
      "reel.footage_seconds": 41.2,
      "reel.word_count": 130,
    });
  });

  it("skips nulls, keeping a zero", () => {
    expect(reelSizeAttributes({ ...UNKNOWN_SIZE, sourceBytes: 10, wordCount: 0 })).toEqual({
      "reel.source_bytes": 10,
      "reel.word_count": 0,
    });
    expect(reelSizeAttributes(UNKNOWN_SIZE)).toEqual({});
  });
});

describe("createReelSizeHolder", () => {
  it("keeps what it learns during the job", () => {
    const holder = createReelSizeHolder({ ...UNKNOWN_SIZE, sourceBytes: 10 });
    holder.update({ footageSeconds: 12 });
    holder.update({ wordCount: 4 });
    expect(holder.current()).toEqual({
      ...UNKNOWN_SIZE,
      sourceBytes: 10,
      footageSeconds: 12,
      wordCount: 4,
    });
  });
});

// A client answering one select with this row (or this error).
function client(answer: { data: unknown; error: unknown }) {
  const seen: string[] = [];
  const builder = {
    select(columns: string) {
      seen.push(columns);
      return builder;
    },
    eq() {
      return builder;
    },
    maybeSingle: async () => answer,
  };
  return { db: { from: () => builder } as never, seen };
}

describe("readReelSize", () => {
  it("reads the named columns once, numerics as numbers", async () => {
    const { db, seen } = client({
      data: {
        source_bytes: 104_857_600,
        source_seconds: "52.4",
        source_width: 1080,
        source_height: 1920,
        footage_seconds: "41.2",
        word_count: 130,
      },
      error: null,
    });
    expect(await readReelSize(db, "r1")).toEqual(FULL);
    expect(seen).toEqual([
      "source_bytes, source_seconds, source_width, source_height, footage_seconds, word_count",
    ]);
  });

  it("gives an unknown size when the read fails", async () => {
    const { db } = client({ data: null, error: { message: "down" } });
    expect(await readReelSize(db, "r1")).toEqual(UNKNOWN_SIZE);
  });
});
