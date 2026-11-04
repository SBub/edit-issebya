import { describe, expect, it } from "vitest";
import { FIXTURES } from "./test-support/fixtures.ts";
import { goldenOf } from "./test-support/golden.ts";
import { GOLDENS } from "./test-support/goldens.ts";
import { browserMeasurer } from "./test-support/measurer.browser.ts";
import {
  editTransitionLevels,
  TRANSITION_LEVELS,
  transitionLayers,
} from "./test-support/transition-layers.ts";

// The studio's environment: the same builder in Chromium must give the very
// page and widths the Node build committed.
describe("build in the browser", () => {
  for (const fixture of FIXTURES) {
    it(`${fixture.name} equals its golden byte for byte`, async () => {
      const built = goldenOf(fixture, await browserMeasurer());
      expect(built.widths).toBe(GOLDENS[fixture.name]!.widths);
      expect(built.html).toBe(GOLDENS[fixture.name]!.html);
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
    const built = goldenOf(fixture, await browserMeasurer());
    for (const html of [built.html, GOLDENS["rethink-work-transitions"]!.html]) {
      expect(html.match(/class="clip layer"/g)).toHaveLength(4);
      const layers = transitionLayers(html);
      expect(layers).toEqual(TRANSITION_LEVELS);
      expect(layers).toEqual(transitions.map(editTransitionLevels));
    }
  });
});
