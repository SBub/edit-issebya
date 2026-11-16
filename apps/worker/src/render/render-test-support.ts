// Test helper: the committed pipeline fixtures as a reel's stored inputs, and
// the baseline edit built from them, placed as a saved first version is.
import { readFile } from "node:fs/promises";
import {
  type Edit,
  type EditInputs,
  type HeadTrack,
  ISSEBYA_PRESET,
  type Transcript,
  baselineEdit,
  headTrackSchema,
  pickVariants,
  placeEdit,
  transcriptSchema,
  DEFAULT_FONT_PAIR_ID,
} from "@edit-issebya/edit";
import { editMeasurer } from "../edit-measurer.ts";

const NO_CHOICES = {
  accents: [],
  questions: [],
  big_words: [],
  visuals: [],
  lists: [],
  word_fixes: [],
};

const FIXTURES = new URL("../../../../fixtures/pipeline/", import.meta.url);

// The committed pipeline outputs of a fixture clip: the short speech (2.69 s, a
// flat picture) at the root, the ten-second speech (9.4 s, a person talking)
// in its own folder.
export type FixtureReel = "short-speech" | "speech-ten";
const FOLDERS: Record<FixtureReel, string> = { "short-speech": "", "speech-ten": "speech-ten/" };

interface Manifest {
  steps: { name: string; fingerprint: string; files: string[] }[];
}

export async function fixtureManifest(reel: FixtureReel = "short-speech"): Promise<Manifest> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
  const text = await readFile(new URL(`${FOLDERS[reel]}manifest.json`, FIXTURES), "utf8");
  return JSON.parse(text) as Manifest;
}

export function fixturePath(
  step: string,
  file: string,
  reel: FixtureReel = "short-speech",
): string {
  return new URL(`${FOLDERS[reel]}${step}/${file}`, FIXTURES).pathname;
}

async function json(step: string, file: string, reel: FixtureReel): Promise<unknown> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
  return JSON.parse(await readFile(fixturePath(step, file, reel), "utf8")) as unknown;
}

// A fixture reel's inputs, transcript, head track and baseline edit.
export async function fixtureEdit(reel: FixtureReel = "short-speech"): Promise<{
  inputs: EditInputs;
  transcript: Transcript;
  headTrack: HeadTrack;
  edit: Edit;
}> {
  const manifest = await fixtureManifest(reel);
  const fp = (name: string) => manifest.steps.find((step) => step.name === name)!.fingerprint;
  const inputs: EditInputs = {
    footage: { step: "retime", fingerprint: fp("retime"), file: "source.mp4" },
    transcript: { step: "retime", fingerprint: fp("retime"), file: "transcript.json" },
    head_track: { step: "head_track", fingerprint: fp("head_track"), file: "head-track.json" },
  };
  const transcript = transcriptSchema.parse(await json("retime", "transcript.json", reel));
  const headTrack = headTrackSchema.parse(await json("head_track", "head-track.json", reel));
  const retime = (await json("retime", "retime.json", reel)) as { durationSeconds: number };
  const baseline = baselineEdit(
    transcript,
    { inputs, duration: retime.durationSeconds, fontPair: DEFAULT_FONT_PAIR_ID },
    ISSEBYA_PRESET,
  );
  const { tracks } = placeEdit(
    baseline,
    NO_CHOICES,
    pickVariants(NO_CHOICES),
    transcript,
    headTrack,
    ISSEBYA_PRESET,
    await editMeasurer(baseline.font_pair),
  );
  return { inputs, transcript, headTrack, edit: { ...baseline, tracks } };
}
