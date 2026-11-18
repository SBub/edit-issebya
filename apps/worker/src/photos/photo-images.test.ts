import { describe, expect, it } from "vitest";
import {
  LARGE_LONG_SIDE,
  PROBE_STDOUT_BYTES,
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
      mirrored: false,
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

  // What ffprobe prints for a JPEG: nothing on the stream, the EXIF
  // Orientation tag (padded) and a display matrix on the frame.
  function jpeg(frame: object) {
    return JSON.stringify({
      frames: [{ stream_index: 0, ...frame }],
      streams: [{ index: 0, codec_type: "video", width: 4032, height: 3024 }],
    });
  }

  it("turns a JPEG by its frame's Orientation tag, the stored size upright", () => {
    const upright = (orientation: number, rotation?: number) =>
      parsePhotoProbe(
        jpeg({
          tags: { Orientation: `    ${orientation}` },
          ...(rotation === undefined ? {} : { side_data_list: [{ rotation }] }),
        }),
      );
    expect(upright(6, -90)).toMatchObject({
      width: 3024,
      height: 4032,
      mirrored: false,
      rotation: 90,
    });
    expect(upright(8, 90)).toMatchObject({
      width: 3024,
      height: 4032,
      mirrored: false,
      rotation: 270,
    });
    expect(upright(3, -180)).toMatchObject({
      width: 4032,
      height: 3024,
      mirrored: false,
      rotation: 180,
    });
    expect(upright(1)).toMatchObject({ width: 4032, height: 3024, mirrored: false, rotation: 0 });
    // The mirrored ones: the matrix's angle alone would be wrong for them.
    expect(upright(2, -180)).toMatchObject({ width: 4032, mirrored: true, rotation: 0 });
    expect(upright(4, 0)).toMatchObject({ width: 4032, mirrored: true, rotation: 180 });
    expect(upright(5, -90)).toMatchObject({ width: 3024, mirrored: true, rotation: 270 });
    expect(upright(7, 90)).toMatchObject({ width: 3024, mirrored: true, rotation: 90 });
  });

  it("falls back to the frame's display matrix, then to no turn", () => {
    expect(parsePhotoProbe(jpeg({ side_data_list: [{ rotation: -90 }] }))).toMatchObject({
      width: 3024,
      height: 4032,
      rotation: 90,
    });
    expect(parsePhotoProbe(jpeg({ tags: { Orientation: "    9" } }))).toMatchObject({
      width: 4032,
      mirrored: false,
      rotation: 0,
    });
    // A frame of another stream says nothing about the picture.
    const other = JSON.stringify({
      frames: [{ stream_index: 1, tags: { Orientation: "6" } }],
      streams: [{ index: 0, codec_type: "video", width: 4032, height: 3024 }],
    });
    expect(parsePhotoProbe(other)).toMatchObject({ width: 4032, rotation: 0 });
  });

  it("turns a HEIC by its own boxes, never by the probe", () => {
    const single = jpeg({ tags: { Orientation: "6" }, side_data_list: [{ rotation: -90 }] });
    expect(parsePhotoProbe(single, { mirrored: true, rotation: 270 })).toMatchObject({
      width: 3024,
      height: 4032,
      mirrored: true,
      rotation: 270,
    });
    expect(parsePhotoProbe(single, { mirrored: false, rotation: 0 })).toMatchObject({
      width: 4032,
      height: 3024,
      rotation: 0,
    });
  });

  // An iPhone HEIC: a grid of 35 tiles, a smaller grid of 12 and one more
  // stream, as the trimmed probe prints them.
  function tiledHeic() {
    const tile = (index: number) => ({ index, codec_type: "video", width: 512, height: 512 });
    const group = (first: number, columns: number, rows: number, width: number, height: number) => {
      const indexes = Array.from({ length: columns * rows }, (_, n) => first + n);
      return {
        type: "Tile Grid",
        components: [
          {
            horizontal_offset: 0,
            vertical_offset: 0,
            width,
            height,
            subcomponents: indexes.map((index, n) => ({
              stream_index: index,
              tile_horizontal_offset: (n % columns) * 512,
              tile_vertical_offset: Math.floor(n / columns) * 512,
            })),
          },
        ],
        streams: indexes.map(tile),
      };
    };
    return JSON.stringify(
      {
        frames: [{ stream_index: 0 }],
        programs: [],
        stream_groups: [group(0, 7, 5, 3088, 2316), group(35, 4, 3, 1544, 1158)],
        streams: Array.from({ length: 48 }, (_, index) => tile(index)),
      },
      null,
      4,
    );
  }

  it("reads a large probe of many tile streams, turned by the file's boxes", () => {
    const json = tiledHeic();
    // Larger than a real one, and far under the call's cap.
    expect(json.length).toBeGreaterThan(20_000);
    expect(json.length).toBeLessThan(PROBE_STDOUT_BYTES / 10);
    const probe = parsePhotoProbe(json, { mirrored: true, rotation: 270 });
    expect(probe).toMatchObject({ width: 2316, height: 3088, mirrored: true, rotation: 270 });
    if (probe.source.kind !== "grid") throw new Error("not a grid");
    expect(probe.source.crop).toEqual({ x: 0, y: 0, width: 3088, height: 2316 });
    expect(probe.source.tiles).toHaveLength(35);
    expect(probe.source.tiles[34]).toEqual({ index: 34, x: 3072, y: 2048 });
    // Without the boxes (ffprobe prints no turn for a grid) it stays as stored.
    expect(parsePhotoProbe(json)).toMatchObject({ width: 3088, height: 2316, rotation: 0 });
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
      mirrored: false,
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
  it("probes only the fields it reads, and one frame", () => {
    const args = photoProbeArgs("/s/original.jpg");
    const entries = args[7]!;
    expect(args).toEqual([
      "-v",
      "error",
      "-print_format",
      "json=compact=1",
      "-read_intervals",
      "%+#1",
      "-show_entries",
      entries,
      "/s/original.jpg",
    ]);
    // `section=field,field:section=field`, with ffprobe 7.1's section names.
    const fields = Object.fromEntries(
      entries.split(":").map((part) => {
        const [section, list] = part.split("=");
        return [section, list?.split(",")];
      }),
    );
    expect(fields).toEqual({
      stream: ["index", "codec_type", "width", "height"],
      stream_tags: ["rotate"],
      stream_side_data: ["rotation"],
      stream_group: ["type"],
      stream_group_component: ["width", "height", "horizontal_offset", "vertical_offset"],
      subcomponent: ["stream_index", "tile_horizontal_offset", "tile_vertical_offset"],
      frame: ["stream_index"],
      frame_tags: ["Orientation"],
      frame_side_data: ["rotation"],
    });
    // Never every field of every stream: that is what overran the cap.
    expect(args).not.toContain("-show_streams");
    expect(args).not.toContain("-show_stream_groups");
    expect(PROBE_STDOUT_BYTES).toBe(4 * 1024 * 1024);
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
      "-noautorotate",
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

  it("turns one stream itself, upright before the scale, and never lets ffmpeg turn it", () => {
    const filter = (mirrored: boolean, rotation: number) => {
      const args = photoImageArgs(
        "/s/in.jpg",
        { width: 3024, height: 4032, mirrored, rotation, source: { kind: "stream", index: 0 } },
        { width: 360, height: 480 },
        "/s/t.jpg",
      );
      expect(args.indexOf("-noautorotate")).toBeLessThan(args.indexOf("-i"));
      return args[args.indexOf("-vf") + 1];
    };
    expect(filter(false, 0)).toBe("scale=360:480");
    expect(filter(false, 90)).toBe("transpose=clock,scale=360:480");
    expect(filter(false, 180)).toBe("hflip,vflip,scale=360:480");
    expect(filter(false, 270)).toBe("transpose=cclock,scale=360:480");
    expect(filter(true, 0)).toBe("hflip,scale=360:480");
    expect(filter(true, 90)).toBe("hflip,transpose=clock,scale=360:480");
    expect(filter(true, 180)).toBe("vflip,scale=360:480");
    expect(filter(true, 270)).toBe("hflip,transpose=cclock,scale=360:480");
  });

  it("stacks, crops, turns and scales a tile grid", () => {
    const args = photoImageArgs(
      "/s/in.heic",
      {
        width: 500,
        height: 1000,
        mirrored: false,
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
