import { describe, expect, it } from "vitest";
import { build } from "./build.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import { FIXTURES, PLACED_FIXTURES } from "./test-support/fixtures.ts";
import { goldenOf } from "./test-support/golden.ts";
import { GOLDENS } from "./test-support/goldens.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";
import { resolveTimeline } from "./timeline.ts";
import {
  editTransitionLevels,
  TRANSITION_LEVELS,
  transitionLayers,
} from "./test-support/transition-layers.ts";

// The placed version the build tests read (the hand edit has no positions yet,
// so the builder does not render it).
const engine = FIXTURES.find((fixture) => fixture.name === "rethink-work-engine")!;

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
  for (const fixture of PLACED_FIXTURES) {
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

  it("rethink-work-transitions holds one layer per numbered transition with its level texts", async () => {
    const fixture = FIXTURES.find((item) => item.name === "rethink-work-transitions")!;
    const transitions = fixture.edit.tracks.transitions;
    expect(transitions.map((transition) => transition.type)).toEqual(["numbered", "numbered"]);
    for (const transition of transitions) {
      expect(transition.levels?.number?.text).toBe(String(transition.number));
    }
    const built = goldenOf(fixture, await nodeMeasurer());
    for (const html of [built.html, GOLDENS["rethink-work-transitions"]!.html]) {
      expect(html.match(/class="clip layer"/g)).toHaveLength(2);
      const layers = transitionLayers(html);
      expect(layers).toEqual(TRANSITION_LEVELS);
      expect(layers).toEqual(transitions.map(editTransitionLevels));
    }
  });

  it("is a HyperFrames composition with a registered paused timeline", async () => {
    const { html } = build(
      engine.edit,
      engine.transcript,
      engine.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    expect(html).toContain('data-composition-id="main"');
    expect(html).toContain("gsap.timeline({ paused: true })");
    expect(html).toContain('window.__timelines["main"] = tl;');
    expect(html).toMatch(
      /<audio id="click-visual-1" class="clip" src="assets\/sounds\/mouse-click-trimmed.wav" data-start="[\d.]+" data-duration="0.230" data-track-index="60" data-volume="0.5012"><\/audio>/,
    );
    expect(html).toContain('<span id="accent-1" class="text f-primary"');
  });

  it("lists every referenced file with its role, sorted", async () => {
    const { assets } = build(
      engine.edit,
      engine.transcript,
      engine.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    // Both roles' font files (Golos Text for captions, Raleway for accents).
    expect(assets.map((asset) => [asset.path, asset.role])).toEqual([
      ["assets/fonts/GolosText-Bold.ttf", "font"],
      ["assets/fonts/Raleway-Light.ttf", "font"],
      ["assets/sounds/mouse-click-trimmed.wav", "sound"],
      ["assets/visuals/visual-1.jpg", "visual"],
      [`masks/${"3".repeat(64)}.mp4`, "mask"],
      ["source.mp4", "footage"],
    ]);
  });

  it("lists a font file once when both roles share it", async () => {
    const shared = {
      ...ISSEBYA_PRESET,
      fonts: { ...ISSEBYA_PRESET.fonts, secondary: { ...ISSEBYA_PRESET.fonts.primary, size: 50 } },
    };
    const { assets } = build(
      engine.edit,
      engine.transcript,
      engine.headTrack,
      shared,
      await nodeMeasurer(),
    );
    expect(assets.filter((asset) => asset.role === "font").map((asset) => asset.path)).toEqual([
      "assets/fonts/Raleway-Light.ttf",
    ]);
  });

  it("draws a VISUAL in front of the speaker over the footage, with no cut-out for it", async () => {
    const edit = structuredClone(engine.edit);
    edit.tracks.behind = edit.tracks.behind!.flatMap((item) =>
      item.kind === "visual"
        ? [{ ...item, image: undefined, box: { x: 600, y: 300, width: 400, height: 300 } }]
        : [],
    );
    delete edit.inputs.masks;
    const { html, assets } = build(
      edit,
      engine.transcript,
      engine.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    expect(html).not.toContain(".cutout");
    // A stored version without a picture: the empty white frame.
    expect(html).toContain(
      '<div id="visual-1" class="clip visual" alt="" data-start="5.206" data-duration="2.000" data-track-index="30" style="left: 600px; top: 300px; width: 400px; height: 300px"></div>',
    );
    expect(html).not.toContain("visual-picture");
    expect(assets.some((asset) => asset.role === "mask")).toBe(false);
    expect(assets.some((asset) => asset.role === "visual")).toBe(false);
  });

  it("fills a VISUAL's box with its stand-in picture, the stroke over it", async () => {
    const edit = structuredClone(engine.edit);
    edit.tracks.behind = edit.tracks.behind!.map((item) =>
      item.kind === "visual"
        ? {
            ...item,
            image: "assets/visuals/visual-2.jpg",
            box: { x: 600, y: 300, width: 400, height: 300 },
          }
        : item,
    );
    const { html, assets } = build(
      edit,
      engine.transcript,
      engine.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    expect(html).toContain(
      '<div id="visual-1" class="clip visual-picture" data-start="5.206" data-duration="2.000" data-track-index="30" style="left: 600px; top: 300px; width: 400px; height: 300px">\n  <img src="assets/visuals/visual-2.jpg" alt="">\n</div>',
    );
    expect(html).toContain(
      ".visual-picture img { position: absolute; left: 0; top: 0; width: 100%; height: 100%; display: block; }",
    );
    expect(assets).toContainEqual({
      path: "assets/visuals/visual-2.jpg",
      role: "visual",
      ref: null,
    });
  });

  it("draws a caption above a card that overlaps it: the card's track under the text track (decision 9)", async () => {
    // A card may sit under a caption (text is no obstacle to a card and a card
    // none to text); the caption stays visible because the text track (50)
    // renders above the visual track (30), later in the page.
    const edit = structuredClone(engine.edit);
    const measurer = await nodeMeasurer();
    const spans = resolveTimeline(edit, engine.transcript);
    const card = edit.tracks.behind!.find((item) => item.kind === "visual")!;
    const cardSpan = spans.get(card.id)!;
    const caption = edit.tracks.captions.find((item) => {
      const span = spans.get(item.id)!;
      return item.position && span.start < cardSpan.end && cardSpan.start < span.end;
    })!;
    card.box = {
      x: caption.position!.x - 20,
      y: caption.position!.y - 20,
      width: 360,
      height: 450,
    };
    const { html } = build(edit, engine.transcript, engine.headTrack, ISSEBYA_PRESET, measurer);
    const cardAt = html.indexOf(`<div id="${card.id}" class="clip visual`);
    const textAt = html.indexOf('<div id="text" class="clip" data-start="0.000"');
    const captionAt = html.indexOf(`<span id="${caption.id}" class="text`);
    expect(cardAt).toBeGreaterThan(-1);
    expect(textAt).toBeGreaterThan(cardAt);
    expect(captionAt).toBeGreaterThan(textAt);
    const trackOf = (at: number) => Number(/data-track-index="(\d+)"/.exec(html.slice(at))![1]);
    expect(trackOf(cardAt)).toBe(30);
    expect(trackOf(textAt)).toBe(50);
  });

  it("renders a text with two breaks in three lines", async () => {
    const edit = structuredClone(engine.edit);
    const accent = edit.tracks.overlays.find((item) => item.kind === "accent")!;
    accent.text = "one two three four";
    accent.breaks = [1, 2];
    const { html } = build(
      edit,
      engine.transcript,
      engine.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    expect(html).toContain("one<br />two<br />three four");
  });

  it("escapes text and style values", async () => {
    const edit = structuredClone(engine.edit);
    edit.tracks.captions[0]!.text = `<b>"Tom" & 'Jerry'</b>`;
    edit.tracks.captions[0]!.style = { "font-family": `"Raleway Light"` };
    const { html } = build(
      edit,
      engine.transcript,
      engine.headTrack,
      ISSEBYA_PRESET,
      await nodeMeasurer(),
    );
    expect(html).toContain("&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;</span>");
    expect(html).toContain("font-family: &quot;Raleway Light&quot;");
    expect(html).not.toContain("<b>");
  });

  it("builds the 50-second engine edit in under 200 ms with a ready measurer", async () => {
    expect(engine.transcript.words).toHaveLength(162);
    const measurer = await nodeMeasurer();
    const fastest = fastestMs(() =>
      build(engine.edit, engine.transcript, engine.headTrack, ISSEBYA_PRESET, measurer),
    );
    expect(fastest).toBeLessThan(200);
  });
});
