import { build } from "../build.ts";
import type { Measurer } from "../measure.ts";
import { ISSEBYA_PRESET } from "../preset.ts";
import type { Fixture } from "./fixtures.ts";

// A fixture built with a fresh measurer: the page and the widths file, as the
// goldens hold them.
export function goldenOf(fixture: Fixture, measurer: Measurer): { html: string; widths: string } {
  const { html } = build(
    fixture.edit,
    fixture.transcript,
    fixture.headTrack,
    ISSEBYA_PRESET,
    measurer,
  );
  return { html, widths: `${JSON.stringify(measurer.widths(), null, 2)}\n` };
}
