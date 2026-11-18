import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NO_TURN, exifTurn, heifTurn, readHeifTurn, thenMirror, thenRotate } from "./heif-turn.ts";

function box(type: string, ...content: (Buffer | number[])[]): Buffer {
  const body = Buffer.concat(content.map((part) => Buffer.from(part)));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
}

const FULL = [0, 0, 0, 0];

// A HEIF file's boxes, as an iPhone writes them: the primary item (a grid,
// item 49) with a colour property, then the given transforms in order; item 1
// (a tile) has only the colour property.
function heif(transforms: Buffer[], { wide = false } = {}): Buffer {
  const index = (n: number) => (wide ? [0x80, n] : [0x80 | n]);
  const ipma = box(
    "ipma",
    [0, 0, 0, wide ? 1 : 0],
    [0, 0, 0, 2],
    [0, 1, 1, ...index(1)],
    [0, 49, 1 + transforms.length, ...index(1), ...transforms.flatMap((_, n) => index(n + 2))],
  );
  const ipco = box("ipco", box("colr", [1, 2, 3, 4]), ...transforms);
  const meta = box(
    "meta",
    FULL,
    box("hdlr", FULL, [0, 0, 0, 0], Buffer.from("pict")),
    box("pitm", FULL, [0, 49]),
    box("iprp", ipco, ipma),
  );
  return Buffer.concat([
    box("ftyp", Buffer.from("heic"), FULL, Buffer.from("mif1heic")),
    meta,
    // The picture's bytes: the box says more than the head read holds.
    Buffer.concat([Buffer.from([0, 16, 0, 0]), Buffer.from("mdat"), Buffer.alloc(64)]),
  ]);
}

const irot = (quarters: number) => box("irot", [quarters]);
const imir = (axis: number) => box("imir", [axis]);

describe("exifTurn", () => {
  it("maps the eight Orientation values to a mirror and a clockwise turn", () => {
    expect(exifTurn(1)).toEqual({ mirrored: false, rotation: 0 });
    expect(exifTurn(2)).toEqual({ mirrored: true, rotation: 0 });
    expect(exifTurn(3)).toEqual({ mirrored: false, rotation: 180 });
    expect(exifTurn(4)).toEqual({ mirrored: true, rotation: 180 });
    expect(exifTurn(5)).toEqual({ mirrored: true, rotation: 270 });
    expect(exifTurn(6)).toEqual({ mirrored: false, rotation: 90 });
    expect(exifTurn(7)).toEqual({ mirrored: true, rotation: 90 });
    expect(exifTurn(8)).toEqual({ mirrored: false, rotation: 270 });
    expect(exifTurn(0)).toEqual(NO_TURN);
    expect(exifTurn(9)).toEqual(NO_TURN);
  });
});

describe("turn steps", () => {
  it("adds a turn clockwise and mirrors what is already turned", () => {
    expect(thenRotate({ mirrored: false, rotation: 270 }, 180)).toEqual({
      mirrored: false,
      rotation: 90,
    });
    // A quarter turn clockwise, then a mirror left to right, is a mirror
    // first and a quarter turn the other way.
    expect(thenMirror({ mirrored: false, rotation: 90 })).toEqual({
      mirrored: true,
      rotation: 270,
    });
    expect(thenMirror(thenMirror({ mirrored: false, rotation: 90 }))).toEqual({
      mirrored: false,
      rotation: 90,
    });
  });
});

describe("heifTurn", () => {
  it("reads the primary item's irot as quarter turns anticlockwise", () => {
    expect(heifTurn(heif([]))).toEqual({ mirrored: false, rotation: 0 });
    expect(heifTurn(heif([irot(0)]))).toEqual({ mirrored: false, rotation: 0 });
    expect(heifTurn(heif([irot(1)]))).toEqual({ mirrored: false, rotation: 270 });
    expect(heifTurn(heif([irot(2)]))).toEqual({ mirrored: false, rotation: 180 });
    // What an iPhone held upright writes: the same as EXIF Orientation 6.
    expect(heifTurn(heif([irot(3)]))).toEqual(exifTurn(6));
    expect(heifTurn(heif([irot(3)], { wide: true }))).toEqual(exifTurn(6));
  });

  it("applies a mirror and a turn in the file's order", () => {
    expect(heifTurn(heif([imir(1)]))).toEqual(exifTurn(2));
    expect(heifTurn(heif([imir(0)]))).toEqual(exifTurn(4));
    expect(heifTurn(heif([imir(1), irot(1)]))).toEqual({ mirrored: true, rotation: 270 });
    expect(heifTurn(heif([irot(1), imir(1)]))).toEqual({ mirrored: true, rotation: 90 });
  });

  it("is null for bytes that are not a HEIF file", () => {
    expect(
      heifTurn(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 16, 0x45, 0x78, 0x69, 0x66])),
    ).toBeNull();
    expect(heifTurn(Buffer.alloc(0))).toBeNull();
    expect(heifTurn(Buffer.from("\x89PNG\r\n\x1a\n0000IHDR", "latin1"))).toBeNull();
    // Cut inside the meta box: unreadable, so no claim.
    expect(heifTurn(heif([irot(3)]).subarray(0, 60))).toBeNull();
  });

  it("reads the head of a file on disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "heif-turn-"));
    try {
      const path = join(dir, "photo.heic");
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      await writeFile(path, heif([irot(3)]));
      expect(await readHeifTurn(path)).toEqual({ mirrored: false, rotation: 90 });
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      await writeFile(path, "not a picture");
      expect(await readHeifTurn(path)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
