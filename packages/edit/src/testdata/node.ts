// Test data for the Node project: the fixture clip's transcript and head track
// (read straight from fixtures/pipeline/, one copy), the reference reel's, the
// stored fixture versions, and the preset's font bytes.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type Measurer, createMeasurer } from "../measure.ts";
import { ISSEBYA } from "../preset.ts";
import type { HeadTrack, Transcript } from "../transcript.ts";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

async function json<T>(path: string): Promise<T> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed test data paths
  return JSON.parse(await readFile(here(path), "utf8")) as T;
}

export interface Fixture {
  name: string;
  edit: unknown;
  transcript: Transcript;
  headTrack: HeadTrack;
}

export const BUILT = here("./built/");

async function shortSpeech() {
  return {
    transcript: await json<Transcript>("../../../../fixtures/pipeline/retime/transcript.json"),
    headTrack: await json<HeadTrack>("../../../../fixtures/pipeline/head_track/head-track.json"),
  };
}

// The reference reel's ids were `w0`, `w1`...; stored here as `w0001`,
// `w0002`... (index plus one, four digits) inside `{ "words": [...] }`.
export async function rethinkWork() {
  return {
    transcript: await json<Transcript>("./rethink-work/transcript.json"),
    headTrack: await json<HeadTrack>("./rethink-work/head-track.json"),
  };
}

export async function fixtures(): Promise<Fixture[]> {
  const short = await shortSpeech();
  const rethink = await rethinkWork();
  return [
    {
      name: "short-speech-baseline",
      edit: await json("./versions/short-speech-baseline.json"),
      ...short,
    },
    {
      name: "rethink-work-baseline",
      edit: await json("./versions/rethink-work-baseline.json"),
      ...rethink,
    },
    {
      name: "rethink-work-accents",
      edit: await json("./versions/rethink-work-accents.json"),
      ...rethink,
    },
  ];
}

async function fontBytes(): Promise<Record<string, Uint8Array>> {
  const fonts: Record<string, Uint8Array> = {};
  for (const [key, font] of Object.entries(ISSEBYA.fonts)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the preset's own font files
    fonts[key] = new Uint8Array(await readFile(here(`../../assets/${font.file}`)));
  }
  return fonts;
}

export async function nodeMeasurer(): Promise<Measurer> {
  return createMeasurer(await fontBytes());
}
