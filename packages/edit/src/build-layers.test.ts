import { describe, expect, it } from "vitest";
import { maskSpans } from "./behind.ts";
import { type Layer, build } from "./build.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";

// The placed version with big words behind the speaker, cards, transitions,
// captions and clicks: every kind of thing a layer page takes or leaves.
const engine = FIXTURES.find((fixture) => fixture.name === "rethink-work-engine")!;

async function page(layer?: Layer) {
  return build(
    engine.edit,
    engine.transcript,
    engine.headTrack,
    ISSEBYA_PRESET,
    await nodeMeasurer(),
    layer ? { layer } : {},
  );
}

const ids = (html: string) => [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]!);

describe("build layers", () => {
  it("builds the full page when no layer is named, byte for byte", async () => {
    expect(await page("full")).toEqual(await page());
  });

  it("has what the fixture needs: a cut-out big word, something in front, a sound", () => {
    expect(maskSpans(engine.edit, engine.transcript, ISSEBYA_PRESET).length).toBeGreaterThan(0);
    expect(engine.edit.tracks.captions.length).toBeGreaterThan(0);
    expect(engine.edit.tracks.sounds.length).toBeGreaterThan(0);
  });

  it("draws the cut-out big words alone on the behind page, transparent, where the full page has them", async () => {
    const full = await page();
    const behind = await page("behind");
    const spans = maskSpans(engine.edit, engine.transcript, ISSEBYA_PRESET);
    const words = spans.flatMap((span) => span.items);
    expect(behind.html).toContain("background: transparent;");
    expect(behind.html).not.toContain("<video");
    expect(behind.html).not.toContain("<audio");
    expect(ids(behind.html)).toEqual(["root", ...words, "text"]);
    for (const id of words) {
      // The same element as on the full page: same place, size and times.
      const element = full.html
        .split("\n")
        .find((line) => line.includes(`<div id="${id}"`))!
        .trim();
      expect(element.endsWith("</div>")).toBe(true);
      expect(behind.html).toContain(element);
      // A tween that changes nothing at its in and out, so still frames are reused.
      expect(
        behind.html.split("\n").filter((line) => line.includes(`tl.fromTo("#${id}"`)),
      ).toHaveLength(2);
    }
    expect(behind.html).not.toMatch(/opacity: 0 \}/);
    expect(behind.assets.map((asset) => asset.role)).toEqual(
      behind.assets.map(() => "font" as const),
    );
    expect(behind.assets.length).toBeGreaterThan(0);
  });

  it("draws everything over the speaker on the front page, transparent, with no footage, mask or sound", async () => {
    const full = await page();
    const front = await page("front");
    expect(front.html).toContain("background: transparent;");
    expect(front.html).not.toContain("<video");
    expect(front.html).not.toContain("<audio");
    expect(front.html).not.toContain('class="cutout"');
    const { tracks } = engine.edit;
    const cutoutWords = new Set(
      maskSpans(engine.edit, engine.transcript, ISSEBYA_PRESET).flatMap((span) => span.items),
    );
    const over = (tracks.behind ?? []).filter((item) => !cutoutWords.has(item.id));
    const frontIds = ids(front.html);
    for (const item of [...over, ...tracks.transitions]) expect(frontIds).toContain(item.id);
    for (const id of cutoutWords) expect(frontIds).not.toContain(id);
    // The text block is the full page's own, line for line.
    const textBlock = (html: string) => html.slice(html.indexOf('<div id="text"'));
    const lines = textBlock(front.html).split("\n");
    const fullLines = new Set(textBlock(full.html).split("\n"));
    for (const line of lines.filter((text) => text.includes("<span"))) {
      expect(fullLines.has(line)).toBe(true);
    }
    expect(lines.filter((text) => text.includes("<span")).length).toBeGreaterThan(0);
    const roles = new Set(front.assets.map((asset) => asset.role));
    expect(roles.has("footage")).toBe(false);
    expect(roles.has("mask")).toBe(false);
    expect(roles.has("sound")).toBe(false);
    expect(roles.has("font")).toBe(true);
    expect(front.assets.filter((asset) => asset.role === "visual")).toEqual(
      full.assets.filter((asset) => asset.role === "visual"),
    );
  });

  it("splits the full page's timeline between the front and behind pages, nothing twice", async () => {
    const tweens = (html: string) =>
      html
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("tl."));
    const full = tweens((await page()).html);
    const front = tweens((await page("front")).html);
    expect(front).toEqual(full);
    expect(tweens((await page("sound")).html)).toEqual([]);
  });

  it("keeps only the sound on the sound page: the footage as an audio element and the sound track", async () => {
    const full = await page();
    const sound = await page("sound");
    expect(sound.html).not.toContain("<video");
    expect(sound.html).not.toContain("<span");
    const footage =
      /<video id="[^"]+" class="clip full"[^>]*data-has-audio="true"[^>]*><\/video>/.exec(
        full.html,
      )![0];
    expect(sound.html).toContain(
      footage.replace("<video", "<audio").replace("</video>", "</audio>"),
    );
    const audio = (html: string) =>
      html.split("\n").filter((line) => line.includes("<audio") && line.includes("data-volume"));
    expect(audio(sound.html)).toEqual(audio(full.html));
    expect(audio(sound.html)).toHaveLength(engine.edit.tracks.sounds.length);
    expect(new Set(sound.assets.map((asset) => asset.role))).toEqual(
      new Set(["font", "footage", "sound"]),
    );
  });

  it("gives every layer the full page's checks", async () => {
    const full = await page();
    for (const layer of ["behind", "front", "sound"] as const) {
      expect((await page(layer)).checks).toEqual(full.checks);
    }
  });
});
