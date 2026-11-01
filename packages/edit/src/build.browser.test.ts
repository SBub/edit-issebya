// The same fixture versions built in Chromium must give exactly the goldens
// the Node run wrote: one builder, one measurement, byte for byte.
import { expect, it } from "vitest";
import { build } from "./build.ts";
import { createMeasurer } from "./measure.ts";
import { ISSEBYA } from "./preset.ts";
import type { HeadTrack, Transcript } from "./transcript.ts";
import golosUrl from "../assets/fonts/GolosText-Bold.ttf?url";
import ralewayUrl from "../assets/fonts/Raleway-Light.ttf?url";
import shortTranscript from "../../../fixtures/pipeline/retime/transcript.json?raw";
import shortHeadTrack from "../../../fixtures/pipeline/head_track/head-track.json?raw";
import rethinkTranscript from "./testdata/rethink-work/transcript.json?raw";
import rethinkHeadTrack from "./testdata/rethink-work/head-track.json?raw";
import shortBaseline from "./testdata/versions/short-speech-baseline.json?raw";
import rethinkBaseline from "./testdata/versions/rethink-work-baseline.json?raw";
import rethinkAccents from "./testdata/versions/rethink-work-accents.json?raw";
import shortBaselineHtml from "./testdata/built/short-speech-baseline.html?raw";
import shortBaselineLayout from "./testdata/built/short-speech-baseline.layout.json?raw";
import rethinkBaselineHtml from "./testdata/built/rethink-work-baseline.html?raw";
import rethinkBaselineLayout from "./testdata/built/rethink-work-baseline.layout.json?raw";
import rethinkAccentsHtml from "./testdata/built/rethink-work-accents.html?raw";
import rethinkAccentsLayout from "./testdata/built/rethink-work-accents.layout.json?raw";

async function bytes(url: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

const FIXTURES = [
  {
    name: "short-speech-baseline",
    edit: shortBaseline,
    transcript: shortTranscript,
    headTrack: shortHeadTrack,
    html: shortBaselineHtml,
    layout: shortBaselineLayout,
  },
  {
    name: "rethink-work-baseline",
    edit: rethinkBaseline,
    transcript: rethinkTranscript,
    headTrack: rethinkHeadTrack,
    html: rethinkBaselineHtml,
    layout: rethinkBaselineLayout,
  },
  {
    name: "rethink-work-accents",
    edit: rethinkAccents,
    transcript: rethinkTranscript,
    headTrack: rethinkHeadTrack,
    html: rethinkAccentsHtml,
    layout: rethinkAccentsLayout,
  },
];

it("builds every fixture version to the Node goldens", async () => {
  // Keyed like the preset's fonts: primary Raleway Light, secondary Golos Text.
  const measurer = createMeasurer({
    primary: await bytes(ralewayUrl),
    secondary: await bytes(golosUrl),
  });
  for (const fixture of FIXTURES) {
    const { html, layout } = build({
      edit: JSON.parse(fixture.edit),
      transcript: JSON.parse(fixture.transcript) as Transcript,
      headTrack: JSON.parse(fixture.headTrack) as HeadTrack,
      preset: ISSEBYA,
      measurer,
    });
    expect(`${JSON.stringify(layout, null, 2)}\n`, fixture.name).toBe(fixture.layout);
    expect(html, fixture.name).toBe(fixture.html);
  }
});
