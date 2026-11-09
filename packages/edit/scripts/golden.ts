// Writes the engine-placed fixture versions (the baseline as the worker's
// first_version step saves it, over the fixture clip's background map; the
// behind hand edit's choices placed by the layout engine; and the same
// choices over a synthetic light background, readable; the 2026-11-03
// request placed over the hand edit; the same choices with two numbered list
// items; and the same choices with the written hook) and every fixture's
// golden page and widths from the Node build:
// `yarn workspace @edit-issebya/edit golden`.
// Commit what it writes; the Node and browser tests compare against it.
import { readFile, writeFile } from "node:fs/promises";
import { backgroundMapSchema, backgroundSampler } from "../src/background.ts";
import { maskSpans } from "../src/behind.ts";
import { baselineEdit } from "../src/baseline.ts";
import { editFromAnswer } from "../src/decide.ts";
import { placeEdit } from "../src/engine.ts";
import { choicesOf } from "../src/engine-input.ts";
import { ISSEBYA_PRESET } from "../src/preset.ts";
import { type Edit, parseEdit } from "../src/schema.ts";
import { backgroundMapOf } from "../src/test-support/backgrounds.ts";
import { goldenOf } from "../src/test-support/golden.ts";
import { RETHINK_WORK, SHORT_SPEECH, baselineInputs } from "../src/test-support/inputs.ts";
import { REQUEST_ANSWER, REQUEST_CASE } from "../src/test-support/request.ts";
import { nodeMeasurer } from "../src/test-support/measurer.node.ts";
import { resolveTimeline } from "../src/timeline.ts";
import { sentenceSpans } from "../src/transcript.ts";

const testdata = new URL("../src/testdata/", import.meta.url);
const NO_CHOICES = {
  accents: [],
  questions: [],
  big_words: [],
  visuals: [],
  transitions: [],
  word_fixes: [],
};

const write = (name: string, value: unknown) =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the package's testdata
  writeFile(new URL(`versions/${name}.edit.json`, testdata), `${JSON.stringify(value, null, 2)}\n`);

// The map the worker's `backgrounds` step makes from the fixture clip.
const shortSpeechMap = backgroundMapSchema.parse(
  JSON.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the package's testdata
    await readFile(new URL("backgrounds/short-speech.backgrounds.json", testdata), "utf8"),
  ),
);
const baseline = baselineEdit(SHORT_SPEECH.transcript, baselineInputs(), ISSEBYA_PRESET);
const placed = placeEdit(
  baseline,
  NO_CHOICES,
  SHORT_SPEECH.transcript,
  SHORT_SPEECH.headTrack,
  ISSEBYA_PRESET,
  await nodeMeasurer(),
  { backgrounds: backgroundSampler(shortSpeechMap, ISSEBYA_PRESET.frame) },
);
await write("baseline-short-speech", { ...baseline, tracks: placed.tracks });

// Version 2 of the studio's preview spec: version 1 with only the committed
// hook (the decide step's unchanged answer), placed the way the worker places
// it: every reel has one.
const hooked = editFromAnswer(
  baseline,
  { ...NO_CHOICES, hook: { text: "A short test for the real studio" } },
  ISSEBYA_PRESET,
  SHORT_SPEECH.transcript,
  SHORT_SPEECH.headTrack,
  await nodeMeasurer(),
  backgroundSampler(shortSpeechMap, ISSEBYA_PRESET.frame),
);
if (!hooked.ok) throw new Error(hooked.reasons.join("; "));
await write("baseline-short-speech-hook", hooked.edit);

// The behind hand edit's choices placed by the engine, with placeholder masks
// for its spans (the worker names real ones).
const behindJson: unknown = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the package's testdata
  await readFile(new URL("versions/rethink-work-behind.edit.json", testdata), "utf8"),
);
const behind = parseEdit(behindJson, ISSEBYA_PRESET, RETHINK_WORK.transcript);
if (!behind.ok) throw new Error(behind.reasons.join("; "));
const choices = choicesOf(behind.edit, RETHINK_WORK.transcript, ISSEBYA_PRESET);
const engine = editFromAnswer(
  behind.edit,
  choices,
  ISSEBYA_PRESET,
  RETHINK_WORK.transcript,
  RETHINK_WORK.headTrack,
  await nodeMeasurer(),
);
if (!engine.ok) throw new Error(engine.reasons.join("; "));

// The edit naming placeholder masks for its spans.
function withPlaceholders(edit: Edit): Edit {
  const masks = maskSpans(edit, RETHINK_WORK.transcript, ISSEBYA_PRESET).map((span, index) => ({
    step: "cutout" as const,
    fingerprint: String(index + 3).repeat(64),
    file: "mask.mp4",
    start: span.start,
    end: span.end,
  }));
  return { ...edit, inputs: { ...edit.inputs, masks } };
}
await write("rethink-work-engine", withPlaceholders(engine.edit));

// The same choices over a synthetic background: dark, with a beige band
// across the frame where the first sentence's captions sit (while it is said)
// and one where the first accent sits (while it shows), so the captions move
// to a darker free place and the accent, with no room above the head, stays
// where it is, plain (never a shadow).
const spans = resolveTimeline(engine.edit, RETHINK_WORK.transcript);
const firstCaption = engine.edit.tracks.captions[0]!;
const firstAccent = engine.edit.tracks.overlays.find((item) => item.id.startsWith("accent-"))!;
const accentSpan = spans.get(firstAccent.id)!;
const firstSentence = sentenceSpans(RETHINK_WORK.transcript)[0]!;
const band = (item: { position?: { y: number }; size?: number }) => ({
  top: item.position!.y - 10,
  bottom: item.position!.y + item.size! + 10,
});
const captionBand = band(firstCaption);
const accentBand = band(firstAccent);
const readableMap = backgroundMapOf(ISSEBYA_PRESET.frame, engine.edit.duration, (_x, y, t) => {
  const inCaption = t < firstSentence.end && y >= captionBand.top && y < captionBand.bottom;
  const inAccent =
    t >= accentSpan.start - 0.5 &&
    t < accentSpan.end + 0.5 &&
    y >= accentBand.top &&
    y < accentBand.bottom;
  return inCaption || inAccent ? "#D8C3A5" : "#101010";
});
const readable = editFromAnswer(
  behind.edit,
  choices,
  ISSEBYA_PRESET,
  RETHINK_WORK.transcript,
  RETHINK_WORK.headTrack,
  await nodeMeasurer(),
  backgroundSampler(readableMap, ISSEBYA_PRESET.frame),
);
if (!readable.ok) throw new Error(readable.reasons.join("; "));
for (const note of readable.record.filter((entry) => entry.rule.startsWith("contrast-"))) {
  console.log(`readable: ${note.item} ${note.action} (${note.rule}): ${note.reason}`);
}
await write("rethink-work-readable", withPlaceholders(readable.edit));

// The 2026-11-03 request "add images behind me" over the hand edit.
const handJson: unknown = JSON.parse(
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the package's testdata
  await readFile(new URL("versions/rethink-work-hand.edit.json", testdata), "utf8"),
);
const hand = parseEdit(handJson, ISSEBYA_PRESET, REQUEST_CASE.transcript);
if (!hand.ok) throw new Error(hand.reasons.join("; "));
const request = editFromAnswer(
  hand.edit,
  REQUEST_ANSWER,
  ISSEBYA_PRESET,
  REQUEST_CASE.transcript,
  REQUEST_CASE.headTrack,
  await nodeMeasurer(),
);
if (!request.ok) throw new Error(request.reasons.join("; "));
await write("rethink-work-request", withPlaceholders(request.edit));

// The engine's choices with two numbered transitions: the first two items of
// the list "fair pay, ..., protected mental health" (w104 is too close to the
// first item for both to show, so the second is w106 to w108).
const withTransitions = editFromAnswer(
  behind.edit,
  {
    ...choices,
    transitions: [
      { kind: "numbered", from: "w100", to: "w103", key_from: "w102" },
      { kind: "numbered", from: "w106", to: "w108", key_from: "w107" },
    ],
  },
  ISSEBYA_PRESET,
  RETHINK_WORK.transcript,
  RETHINK_WORK.headTrack,
  await nodeMeasurer(),
);
if (!withTransitions.ok) throw new Error(withTransitions.reasons.join("; "));
for (const note of withTransitions.record.filter((entry) => entry.item.startsWith("transition-"))) {
  console.log(`transitions: ${note.item} ${note.action} (${note.rule}): ${note.reason}`);
}
await write("rethink-work-transitions", withPlaceholders(withTransitions.edit));

// The engine's choices with the written hook the owner liked on her reel:
// from 0.2 s to 3 s, the one extra of that window (the accent there waits for
// nothing and is dropped), wrapped and shrunk in the upper part of the frame.
const withHook = editFromAnswer(
  behind.edit,
  { ...choices, hook: { text: "Gen Z won't work like you did" } },
  ISSEBYA_PRESET,
  RETHINK_WORK.transcript,
  RETHINK_WORK.headTrack,
  await nodeMeasurer(),
);
if (!withHook.ok) throw new Error(withHook.reasons.join("; "));
for (const note of withHook.record.filter((entry) => entry.item === "hook")) {
  console.log(`hook: ${note.item} ${note.action} (${note.rule}): ${note.reason}`);
}
await write("rethink-work-hook", withPlaceholders(withHook.edit));

// Re-imported after the baseline is written, so the goldens build the new one.
const { PLACED_FIXTURES } = await import("../src/test-support/fixtures.ts");
for (const fixture of PLACED_FIXTURES) {
  const { html, widths } = goldenOf(fixture, await nodeMeasurer());
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the package's testdata
  await writeFile(new URL(`golden/${fixture.name}.html`, testdata), html);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the package's testdata
  await writeFile(new URL(`golden/${fixture.name}.widths.json`, testdata), widths);
  console.log(`${fixture.name}: ${html.length} bytes`);
}
