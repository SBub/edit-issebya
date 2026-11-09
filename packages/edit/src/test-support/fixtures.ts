// The stored fixture versions every build test runs, imported as JSON modules
// so the Node and the browser runs build exactly the same inputs.
import type { HeadTrack } from "../head-track.ts";
import { ISSEBYA_PRESET } from "../preset.ts";
import { type Edit, parseEdit } from "../schema.ts";
import type { Transcript } from "../transcript.ts";
import baselineShortSpeech from "../testdata/versions/baseline-short-speech.edit.json" with { type: "json" };
import baselineShortSpeechHook from "../testdata/versions/baseline-short-speech-hook.edit.json" with { type: "json" };
import rethinkBehind from "../testdata/versions/rethink-work-behind.edit.json" with { type: "json" };
import rethinkEngine from "../testdata/versions/rethink-work-engine.edit.json" with { type: "json" };
import rethinkHand from "../testdata/versions/rethink-work-hand.edit.json" with { type: "json" };
import rethinkHook from "../testdata/versions/rethink-work-hook.edit.json" with { type: "json" };
import rethinkRequest from "../testdata/versions/rethink-work-request.edit.json" with { type: "json" };
import rethinkTransitions from "../testdata/versions/rethink-work-transitions.edit.json" with { type: "json" };
import { RETHINK_WORK, SHORT_SPEECH } from "./inputs.ts";
import { REQUEST_CASE } from "./request.ts";

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
  // Version 1 with only the committed hook: what the studio's preview spec
  // shows as version 2 (every reel has a hook).
  fixture("baseline-short-speech-hook", baselineShortSpeechHook, SHORT_SPEECH),
  // The hand edit and the behind edit are the engine's inputs: their captions
  // and text have no positions yet, so the builder does not render them.
  fixture("rethink-work-hand", rethinkHand, RETHINK_WORK),
  fixture("rethink-work-behind", rethinkBehind, RETHINK_WORK),
  // The behind edit's choices placed by the layout engine.
  fixture("rethink-work-engine", rethinkEngine, RETHINK_WORK),
  // The 2026-11-03 request "add images behind me": the visual over the question
  // sentence, clear of the face.
  fixture("rethink-work-request", rethinkRequest, REQUEST_CASE),
  // The same choices with two numbered list items: the layers, their text
  // levels, the phrases' captions shown only there.
  fixture("rethink-work-transitions", rethinkTransitions, RETHINK_WORK),
  // The behind edit's choices with the written hook at the start: its own
  // class, from 0.2 s to 3 s, the accent in its window left out.
  fixture("rethink-work-hook", rethinkHook, RETHINK_WORK),
];

// The versions the builder renders (each has a golden page): every fixture
// but the two unplaced engine inputs.
const UNPLACED = new Set(["rethink-work-hand", "rethink-work-behind"]);
export const PLACED_FIXTURES: Fixture[] = FIXTURES.filter((fixture) => !UNPLACED.has(fixture.name));
