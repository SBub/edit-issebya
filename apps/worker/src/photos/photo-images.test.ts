import { describe, expect, it } from "vitest";
import {
  LARGE_LONG_SIDE,
  THUMBNAIL_LONG_SIDE,
  fitWithin,
  parsePhotoProbe,
  photoFileKey,
  photoImageArgs,
  photoProbeArgs,
} from "./photo-images.ts";

const PHOTO = "7a2d0c1e-4b5f-4c3a-9e8d-1f2a3b4c5d6e";

describe("fitWithin", () => {
  it("fits the long side, keeps the ratio and never upscales", () => {
    expect(THUMBNAIL_LONG_SIDE).toBe(480);
    expect(LARGE_LONG_SIDE).toBe(1568);
    expect(fitWithin(4032, 3024, 480)).toEqual({ width: 480, height: 360 });
    expect(fitWithin(3024, 4032, 480)).toEqual({ width: 360, height: 480 });
    expect(fitWithin(300, 200, 480)).toEqual({ width: 300, height: 200 });
    expect(fitWithin(2000, 2000, 1568)).toEqual({ width: 1568, height: 1568 });
    expect(fitWithin(1200, 900, 1568)).toEqual({ width: 1200, height: 900 });
  });
});

describe("parsePhotoProbe", () => {
  it("reads the first video stream, turned when a display matrix says so", () => {
    const json = JSON.stringify({
      streams: [
        { index: 0, codec_type: "video", width: 4032, height: 3024 },
        { index: 1, codec_type: "video", width: 320, height: 240 },
      ],
    });
    expect(parsePhotoProbe(json)).toEqual({
      width: 4032,
      height: 3024,
      rotation: 0,
      source: { kind: "stream", index: 0 },
    });
    const turned = JSON.stringify({
      streams: [
        {
          index: 0,
          codec_type: "video",
          width: 4032,
          height: 3024,
          side_data_list: [{ rotation: -90 }],
        },
      ],
    });
    expect(parsePhotoProbe(turned)).toMatchObject({ width: 3024, height: 4032, rotation: 90 });
  });

  it("puts a HEIC tile grid together from its group", () => {
    const json = JSON.stringify({
      streams: [0, 1].map((index) => ({ index, codec_type: "video", width: 512, height: 512 })),
      stream_groups: [
        {
          type: "Tile Grid",
          components: [
            {
              width: 1000,
              height: 500,
              horizontal_offset: 0,
              vertical_offset: 0,
              subcomponents: [
                { stream_index: 0, tile_horizontal_offset: 0, tile_vertical_offset: 0 },
                { stream_index: 1, tile_horizontal_offset: 512, tile_vertical_offset: 0 },
              ],
            },
          ],
        },
      ],
    });
    expect(parsePhotoProbe(json)).toEqual({
      width: 1000,
      height: 500,
      rotation: 0,
      source: {
        kind: "grid",
        tiles: [
          { index: 0, x: 0, y: 0 },
          { index: 1, x: 512, y: 0 },
        ],
        crop: { x: 0, y: 0, width: 1000, height: 500 },
      },
    });
  });

  it("refuses a file without a picture", () => {
    expect(() => parsePhotoProbe(JSON.stringify({ streams: [{ codec_type: "audio" }] }))).toThrow(
      /no picture/,
    );
  });
});

describe("tool arguments", () => {
  it("probes streams and stream groups as JSON", () => {
    expect(photoProbeArgs("/s/original.jpg")).toEqual([
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      "-show_stream_groups",
      "/s/original.jpg",
    ]);
  });

  it("scales one stream to one JPEG frame", () => {
    const probe = parsePhotoProbe(
      JSON.stringify({ streams: [{ index: 0, codec_type: "video", width: 1200, height: 900 }] }),
    );
    expect(photoImageArgs("/s/in.jpg", probe, { width: 480, height: 360 }, "/s/t.jpg")).toEqual([
      "-hide_banner",
      "-v",
      "error",
      "-y",
      "-i",
      "/s/in.jpg",
      "-map",
      "0:0",
      "-vf",
      "scale=480:360",
      "-frames:v",
      "1",
      "-q:v",
      "3",
      "-update",
      "1",
      "/s/t.jpg",
    ]);
  });

  it("stacks, crops, turns and scales a tile grid", () => {
    const args = photoImageArgs(
      "/s/in.heic",
      {
        width: 500,
        height: 1000,
        rotation: 90,
        source: {
          kind: "grid",
          tiles: [
            { index: 0, x: 0, y: 0 },
            { index: 1, x: 512, y: 0 },
          ],
          crop: { x: 0, y: 0, width: 1000, height: 500 },
        },
      },
      { width: 240, height: 480 },
      "/s/t.jpg",
    );
    expect(args).toContain(
      "[0:0][0:1]xstack=inputs=2:layout=0_0|512_0,crop=1000:500:0:0,transpose=clock,scale=240:480[photo]",
    );
    expect(args.slice(args.indexOf("-map"), args.indexOf("-map") + 2)).toEqual(["-map", "[photo]"]);
  });

  it("keys a photo's files under the prefix's library", () => {
    expect(photoFileKey("dev/", PHOTO, "thumbnail.jpg")).toBe(`dev/library/${PHOTO}/thumbnail.jpg`);
  });
});
