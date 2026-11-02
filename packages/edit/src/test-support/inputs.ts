import manifest from "../../../../fixtures/pipeline/manifest.json" with { type: "json" };
import retime from "../../../../fixtures/pipeline/retime/retime.json" with { type: "json" };
import shortSpeechHeadTrack from "../../../../fixtures/pipeline/head_track/head-track.json" with { type: "json" };
import shortSpeechTranscript from "../../../../fixtures/pipeline/retime/transcript.json" with { type: "json" };
import { headTrackSchema } from "../head-track.ts";
import type { EditInputs } from "../schema.ts";
import { transcriptSchema } from "../transcript.ts";
import rethinkHeadTrack from "../testdata/rethink-work/head-track.json" with { type: "json" };
import rethinkTranscript from "../testdata/rethink-work/transcript.json" with { type: "json" };

// The fixture clip (fixtures/pipeline/, no person in it) and the reference
// reel (a real head track).
export const SHORT_SPEECH = {
  transcript: transcriptSchema.parse(shortSpeechTranscript),
  headTrack: headTrackSchema.parse(shortSpeechHeadTrack),
};

export const RETHINK_WORK = {
  transcript: transcriptSchema.parse(rethinkTranscript),
  headTrack: headTrackSchema.parse(rethinkHeadTrack),
};

// The fixture clip's inputs, by the fingerprints in fixtures/pipeline/: what
// the worker's first_version step gives baselineEdit for that clip.
export function baselineInputs(): { inputs: EditInputs; duration: number } {
  const fp = (name: string) => {
    const step = manifest.steps.find((entry) => entry.name === name);
    if (!step) throw new Error(`fixtures/pipeline/manifest.json has no ${name}`);
    return step.fingerprint;
  };
  return {
    inputs: {
      footage: { step: "retime", fingerprint: fp("retime"), file: "source.mp4" },
      transcript: { step: "retime", fingerprint: fp("retime"), file: "transcript.json" },
      cutout: {
        step: "remove_background",
        fingerprint: fp("remove_background"),
        file: "subject.webm",
      },
      head_track: { step: "head_track", fingerprint: fp("head_track"), file: "head-track.json" },
    },
    duration: retime.durationSeconds,
  };
}
