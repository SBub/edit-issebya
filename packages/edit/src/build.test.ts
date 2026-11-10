import { describe, expect, it } from "vitest";
import { build } from "./build.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { goldenOf } from "./test-support/golden.ts";
import { GOLDENS } from "./test-support/goldens.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";
import {
  editTransitionLevels,
  TRANSITION_LEVELS,
  transitionLayers,
} from "./test-support/transition-layers.ts";

const hand = FIXTURES.find((fixture) => fixture.name === "rethink-work-hand")!;

// The fastest of several runs after one warm-up run. A single wall-clock sample
// also measures whatever the machine did meanwhile: CPU contention from other
// test workers, a GC pause, a JIT still warming up. Those only ever add time, so
// the minimum over several runs is the cost of the run itself. A budget on the
// minimum still fails when the build really gets slower.
function fastestMs(run: () => unknown, runs = 7): number {
  run();
  let fastest = Infinity;
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    run();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
}

describe("build", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name} equals its golden byte for byte`, async () => {
      const built = goldenOf(fixture, await nodeMeasurer());
      expect(built.widths).toBe(GOLDENS[fixture.name]!.widths);
      expect(built.html).toBe(GOLDENS[fixture.name]!.html);
    });

    it(`${fixture.name} builds the same twice`, async () => {
      const run = async () =>
        build(
          fixture.edit,
          fixture.transcript,
          fixture.headTrack,
          ISSEBYA_PRESET,
          await nodeMeasurer(),
        );
      expect(await run()).toEqual(await run());
    });

    // Owner decision 2026-11-04: no text in a version reads as stroked.
    it(`${fixture.name} draws no shadow or outline on any text`, () => {
      expect(GOLDENS[fixture.name]!.html).not.toMatch(/text-shadow|text-stroke|paint-order/);
    });
  }

  it("rethink-work-transitions holds one layer per kind with its level texts", async () => {
    const fixture = FIXTURES.find((item) => item.name === "rethink-work-transitions")!;
    const transitions = fixture.edit.tracks.transitions;
    expect(transitions.map((transition) => transition.type)).toEqual([
      "dim",
      "numbered",
      "numbered",
      "panel",
    ]);
    for (const transition of transitions) {
      if (transition.type === "numbered") {
        expect(transition.levels?.number?.text).toBe(String(transition.number));
      }
    }
    const built = goldenOf(fixture, await nodeMeasurer());
    for (const html of [built.html, GOLDENS["rethink-work-transitions"]!.html]) {
      expect(html.match(/class="clip layer"/g)).toHaveLength(4);
      const layers = transitionLayers(html);
      expect(layers).toEqual(TRANSITION_LEVELS);
      expect(layers).toEqual(transitions.map(editTransitionLevels));
    }
  });

  it("is a HyperFrames composition with a registered paused timeline", async () => {
    const { html } = build(
      hand.edit,
      hand.transcript,
      hand.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    expect(html).toContain('data-composition-id="main"');
    expect(html).toContain("gsap.timeline({ paused: true })");
    expect(html).toContain('window.__timelines["main"] = tl;');
    expect(html).toMatch(
      /<audio id="s-fund-life" class="clip" src="assets\/sounds\/mouse-click-trimmed.wav" data-start="[\d.]+" data-duration="0.230" data-track-index="60" data-volume="0.5012"><\/audio>/,
    );
    expect(html).toContain('<span id="aw29" class="text f-primary"');
  });

  it("lists every referenced file with its role, sorted", async () => {
    const { assets } = build(
      hand.edit,
      hand.transcript,
      hand.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    // Both roles' font files (Golos Text for captions, Raleway for accents).
    expect(assets.map((asset) => [asset.path, asset.role])).toEqual([
      ["assets/fonts/GolosText-Bold.ttf", "font"],
      ["assets/fonts/Raleway-Light.ttf", "font"],
      ["assets/sounds/mouse-click-trimmed.wav", "sound"],
      ["source.mp4", "footage"],
    ]);
  });

  it("lists a font file once when both roles share it", async () => {
    const shared = {
      ...ISSEBYA_PRESET,
      fonts: { ...ISSEBYA_PRESET.fonts, secondary: { ...ISSEBYA_PRESET.fonts.primary, size: 50 } },
    };
    const { assets } = build(
      hand.edit,
      hand.transcript,
      hand.headTrack,
      shared,
      await nodeMeasurer(),
    );
    expect(assets.filter((asset) => asset.role === "font").map((asset) => asset.path)).toEqual([
      "assets/fonts/Raleway-Light.ttf",
    ]);
  });

  it("builds a stored version naming a cut-out without it", async () => {
    expect(hand.edit.inputs.cutout).toBeDefined();
    expect(hand.edit.tracks.cutout?.length).toBeGreaterThan(0);
    const { html, assets } = build(
      hand.edit,
      hand.transcript,
      hand.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    expect(html).not.toContain('<video id="cutout"');
    expect(html).not.toContain("subject.webm");
    expect(html).not.toContain('data-track-index="30"');
    expect(html.match(/<video /g)).toHaveLength(1);
    expect(assets.map((asset) => asset.role)).not.toContain("cutout");
  });

  it("renders an older version's stored shadow as the preset's legacy text-shadow, and none without it", async () => {
    const edit = structuredClone(hand.edit);
    const caption = edit.tracks.captions[0]!;
    const accent = edit.tracks.overlays[0]!;
    const plain = build(
      edit,
      hand.transcript,
      hand.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    expect(plain.html).not.toContain("text-shadow");
    caption.shadow = 1;
    accent.shadow = 2;
    const { html } = build(
      edit,
      hand.transcript,
      hand.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    // The span's tag, from its id to the end of the tag.
    const styleOf = (id: string) => {
      const from = html.indexOf(`<span id="${id}" `);
      return html.slice(from, html.indexOf(">", from));
    };
    expect(styleOf(caption.id)).toContain("; text-shadow: 0 2px 8px rgba(0, 0, 0, 0.55)");
    expect(styleOf(accent.id)).toContain(
      "; text-shadow: 0 2px 6px rgba(0, 0, 0, 0.8), 0 0 18px rgba(0, 0, 0, 0.6)",
    );
    expect(html.match(/text-shadow/g)).toHaveLength(2);
    // A dark text gets the light halo.
    caption.color = "#000000";
    const dark = build(edit, hand.transcript, hand.headTrack, ISSEBYA_PRESET, await nodeMeasurer());
    expect(dark.html).toContain("text-shadow: 0 2px 8px rgba(255, 255, 255, 0.55)");
  });

  it("draws a photo in front of the speaker over the footage, with no cut-out for it", async () => {
    const behind = FIXTURES.find((fixture) => fixture.name === "rethink-work-behind")!;
    const edit = structuredClone(behind.edit);
    edit.tracks.behind = edit.tracks.behind!.flatMap((item) =>
      item.kind === "photo"
        ? [{ ...item, layer: "front" as const, box: { x: 600, y: 300, width: 400, height: 300 } }]
        : [],
    );
    delete edit.inputs.masks;
    const { html, assets } = build(
      edit,
      behind.transcript,
      behind.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    expect(html).toContain("      .photo { position: absolute; object-fit: cover; }");
    expect(html).not.toContain(".cutout");
    expect(html).toMatch(
      /<img id="behind-photo" class="clip photo" src="photos\/[0-9a-f-]+\.jpg" alt="" data-start="[\d.]+" data-duration="[\d.]+" data-track-index="30" style="left: 600px; top: 300px; width: 400px; height: 300px" \/>/,
    );
    expect(assets.some((asset) => asset.role === "mask")).toBe(false);
    expect(assets.filter((asset) => asset.role === "photo")).toHaveLength(1);
  });

  it("escapes text and style values", async () => {
    const edit = structuredClone(hand.edit);
    edit.tracks.captions[0]!.text = `<b>"Tom" & 'Jerry'</b>`;
    edit.tracks.captions[0]!.style = { "font-family": `"Raleway Light"` };
    const { html } = build(
      edit,
      hand.transcript,
      hand.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    expect(html).toContain("&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;</span>");
    expect(html).toContain("font-family: &quot;Raleway Light&quot;");
    expect(html).not.toContain("<b>");
  });

  it("builds the 50-second hand edit in under 200 ms with a ready measurer", async () => {
    expect(hand.transcript.words).toHaveLength(162);
    const measurer = await nodeMeasurer();
    const fastest = fastestMs(() =>
      build(hand.edit, hand.transcript, hand.headTrack, ISSEBYA_PRESET, measurer),
    );
    expect(fastest).toBeLessThan(200);
  });
});
