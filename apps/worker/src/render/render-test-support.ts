// Test helper: the committed pipeline fixtures as a reel's stored inputs, and
// the baseline edit built from them.
import { readFile } from "node:fs/promises";
import {
  type Edit,
  type EditInputs,
  type HeadTrack,
  ISSEBYA_PRESET,
  type Transcript,
  baselineEdit,
  headTrackSchema,
  transcriptSchema,
} from "@edit-issebya/edit";

const FIXTURES = new URL("../../../../fixtures/pipeline/", import.meta.url);

interface Manifest {
  steps: { name: string; fingerprint: string; files: string[] }[];
}

export async function fixtureManifest(): Promise<Manifest> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
  return JSON.parse(await readFile(new URL("manifest.json", FIXTURES), "utf8")) as Manifest;
}

export function fixturePath(step: string, file: string): string {
  return new URL(`${step}/${file}`, FIXTURES).pathname;
}

async function json(step: string, file: string): Promise<unknown> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixtures
  return JSON.parse(await readFile(fixturePath(step, file), "utf8")) as unknown;
}

// The fixture reel's inputs, transcript, head track and baseline edit.
export async function fixtureEdit(): Promise<{
  inputs: EditInputs;
  transcript: Transcript;
  headTrack: HeadTrack;
  edit: Edit;
}> {
  const manifest = await fixtureManifest();
  const fp = (name: string) => manifest.steps.find((step) => step.name === name)!.fingerprint;
  const inputs: EditInputs = {
    footage: { step: "retime", fingerprint: fp("retime"), file: "source.mp4" },
    transcript: { step: "retime", fingerprint: fp("retime"), file: "transcript.json" },
    cutout: {
      step: "remove_background",
      fingerprint: fp("remove_background"),
      file: "subject.webm",
    },
    head_track: { step: "head_track", fingerprint: fp("head_track"), file: "head-track.json" },
  };
  const transcript = transcriptSchema.parse(await json("retime", "transcript.json"));
  const headTrack = headTrackSchema.parse(await json("head_track", "head-track.json"));
  const retime = (await json("retime", "retime.json")) as { durationSeconds: number };
  const edit = baselineEdit(
    transcript,
    { inputs, duration: retime.durationSeconds },
    ISSEBYA_PRESET,
  );
  return { inputs, transcript, headTrack, edit };
}
