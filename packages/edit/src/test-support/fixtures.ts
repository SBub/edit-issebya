// The stored fixture versions every build test runs, imported as JSON modules
// so the Node and the browser runs build exactly the same inputs.
import type { HeadTrack } from "../head-track.ts";
import { ISSEBYA_PRESET } from "../preset.ts";
import { type Edit, parseEdit } from "../schema.ts";
import type { Transcript } from "../transcript.ts";
import baselineShortSpeech from "../testdata/versions/baseline-short-speech.edit.json" with { type: "json" };
import rethinkHand from "../testdata/versions/rethink-work-hand.edit.json" with { type: "json" };
import { RETHINK_WORK, SHORT_SPEECH } from "./inputs.ts";

export interface Fixture {
  name: string;
  edit: Edit;
  transcript: Transcript;
  headTrack: HeadTrack;
}

function fixture(
  name: string,
  edit: unknown,
  { transcript, headTrack }: { transcript: Transcript; headTrack: HeadTrack },
): Fixture {
  const parsed = parseEdit(edit, ISSEBYA_PRESET, transcript);
  if (!parsed.ok) throw new Error(`${name}: ${parsed.reasons.join("; ")}`);
  return { name, edit: parsed.edit, transcript, headTrack };
}

export const FIXTURES: Fixture[] = [
  fixture("baseline-short-speech", baselineShortSpeech, SHORT_SPEECH),
  fixture("rethink-work-hand", rethinkHand, RETHINK_WORK),
];
