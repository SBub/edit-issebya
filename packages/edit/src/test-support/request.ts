import type { EngineInput } from "../engine-input.ts";
import type { HeadTrack } from "../head-track.ts";
import { RETHINK_WORK } from "./inputs.ts";

// The 2026-11-03 request "add images behind me", on the reference reel's
// words: Claude's answer is a visual over the question sentence (w84 to w99).
// The case is set with a steady head on the left of the frame (the speaker
// off centre).
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

export const REQUEST_ANSWER: EngineInput = {
  accents: [],
  questions: [],
  big_words: [],
  visuals: [{ from: "w84", to: "w99", description: "a question mark on a wall" }],
  transitions: [],
  word_fixes: [],
};
