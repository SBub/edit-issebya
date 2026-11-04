import type { EngineInput } from "../engine-input.ts";
import type { HeadTrack } from "../head-track.ts";
import { RETHINK_WORK } from "./inputs.ts";

// The 2026-11-03 request "add images behind me", on the reference reel's
// words: Claude added a dim on its own over the question sentence (w84 to
// w99) and the photo over the same sentence; only the photo is linked from
// the checklist. The case is set with a steady head on the left of the frame
// (the speaker off centre). The plain pass drops the photo: nothing else
// shows while a transition runs.
export const LEFT_HEAD: HeadTrack = Array.from({ length: 200 }, (_, index) => ({
  t: index * 0.25,
  head_top: 300 + (index % 3) * 4,
  cx: 250 + (index % 2) * 6,
  head_w: 292,
}));

export const REQUEST_CASE = {
  transcript: RETHINK_WORK.transcript,
  headTrack: LEFT_HEAD,
};

export const REQUEST_PHOTO = "3f6c1a52-8e4d-4b7a-9c21-5d0e8f7b6a14";

export const REQUEST_ANSWER: EngineInput & {
  checklist: { ask: string; wants: string; fulfilled_by: string[] }[];
} = {
  accents: [],
  big_word: null,
  photos: [{ photo_id: REQUEST_PHOTO, from: "w84", to: "w99" }],
  transitions: [{ kind: "dim", from: "w84", to: "w99", key_from: "w91" }],
  word_fixes: [],
  checklist: [
    { ask: "add images behind me", wants: "1 photo, free choice", fulfilled_by: ["photos[0]"] },
  ],
};
