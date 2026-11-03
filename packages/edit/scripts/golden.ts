// Writes the engine-placed fixture versions (the baseline as the worker's
// first_version step saves it, and the behind hand edit's choices placed by
// the layout engine) and every fixture's golden page and widths from the
// Node build: `yarn workspace @edit-issebya/edit golden`. Commit what it
// writes; the Node and browser tests compare against it.
import { readFile, writeFile } from "node:fs/promises";
import { maskSpans } from "../src/behind.ts";
import { baselineEdit } from "../src/baseline.ts";
import { editFromAnswer } from "../src/decide.ts";
import { placeEdit } from "../src/engine.ts";
import { choicesOf } from "../src/engine-input.ts";
import { ISSEBYA_PRESET } from "../src/preset.ts";
import { parseEdit } from "../src/schema.ts";
import { goldenOf } from "../src/test-support/golden.ts";
import { RETHINK_WORK, SHORT_SPEECH, baselineInputs } from "../src/test-support/inputs.ts";
import { nodeMeasurer } from "../src/test-support/measurer.node.ts";

const testdata = new URL("../src/testdata/", import.meta.url);
const NO_CHOICES = { accents: [], big_word: null, photos: [], transitions: [], word_fixes: [] };

const write = (name: string, value: unknown) =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the package's testdata
  writeFile(new URL(`versions/${name}.edit.json`, testdata), `${JSON.stringify(value, null, 2)}\n`);

const baseline = baselineEdit(SHORT_SPEECH.transcript, baselineInputs(), ISSEBYA_PRESET);
const placed = placeEdit(
  baseline,
  NO_CHOICES,
  SHORT_SPEECH.transcript,
  SHORT_SPEECH.headTrack,
  ISSEBYA_PRESET,
  await nodeMeasurer(),
);
await write("baseline-short-speech", { ...baseline, tracks: placed.tracks });

// The behind hand edit's choices placed by the engine, with placeholder masks
// for its spans (the worker names real ones).
const behindJson: unknown = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the package's testdata
  await readFile(new URL("versions/rethink-work-behind.edit.json", testdata), "utf8"),
);
const behind = parseEdit(behindJson, ISSEBYA_PRESET, RETHINK_WORK.transcript);
if (!behind.ok) throw new Error(behind.reasons.join("; "));
const engine = editFromAnswer(
  behind.edit,
  choicesOf(behind.edit, RETHINK_WORK.transcript, ISSEBYA_PRESET),
  ISSEBYA_PRESET,
  RETHINK_WORK.transcript,
  RETHINK_WORK.headTrack,
  await nodeMeasurer(),
);
if (!engine.ok) throw new Error(engine.reasons.join("; "));
const masks = maskSpans(engine.edit, RETHINK_WORK.transcript, ISSEBYA_PRESET).map(
  (span, index) => ({
    step: "cutout" as const,
    fingerprint: String(index + 3).repeat(64),
    file: "mask.mp4",
    start: span.start,
    end: span.end,
  }),
);
const photos = [
  ...new Set(
    (engine.edit.tracks.behind ?? []).flatMap((item) =>
      item.kind === "photo" ? [item.photo_id] : [],
    ),
  ),
].sort();
await write("rethink-work-engine", {
  ...engine.edit,
  inputs: { ...engine.edit.inputs, masks, photos },
});

// Re-imported after the baseline is written, so the goldens build the new one.
const { FIXTURES } = await import("../src/test-support/fixtures.ts");
for (const fixture of FIXTURES) {
  const { html, widths } = goldenOf(fixture, await nodeMeasurer());
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the package's testdata
  await writeFile(new URL(`golden/${fixture.name}.html`, testdata), html);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the package's testdata
  await writeFile(new URL(`golden/${fixture.name}.widths.json`, testdata), widths);
  console.log(`${fixture.name}: ${html.length} bytes`);
}
