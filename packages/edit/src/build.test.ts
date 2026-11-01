import { describe, expect, it } from "vitest";
import { build } from "./build.ts";
import { ISSEBYA_PRESET } from "./preset.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { goldenOf } from "./test-support/golden.ts";
import { GOLDENS } from "./test-support/goldens.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";

const hand = FIXTURES.find((fixture) => fixture.name === "rethink-work-hand")!;

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
  }

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
      /<audio id="s-fund-life" class="clip" src="assets\/sounds\/mouse-click-trimmed.wav" data-start="[\d.]+" data-duration="0.230" data-track-index="60" data-volume="0.2239"><\/audio>/,
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
    expect(assets.map((asset) => [asset.path, asset.role])).toEqual([
      ["assets/fonts/GolosText-Bold.ttf", "font"],
      ["assets/fonts/Raleway-Light.ttf", "font"],
      ["assets/sounds/mouse-click-trimmed.wav", "sound"],
      ["source.mp4", "footage"],
      ["subject.webm", "cutout"],
    ]);
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
    build(hand.edit, hand.transcript, hand.headTrack, ISSEBYA_PRESET, measurer);
    const started = performance.now();
    build(hand.edit, hand.transcript, hand.headTrack, ISSEBYA_PRESET, measurer);
    expect(performance.now() - started).toBeLessThan(200);
  });
});
