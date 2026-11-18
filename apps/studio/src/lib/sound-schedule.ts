import {
  type Edit,
  type Preset,
  type Transcript,
  resolveTimeline,
  soundCues,
} from "@edit-issebya/edit";

// One hit of a sound on the edit's sound track, in reel seconds.
export interface SoundHit {
  id: string;
  file: string;
  at: number;
  // Linear gain.
  gain: number;
  duration: number;
}

// One AudioBufferSourceNode start: context time, offset into the sound and
// the gain it plays at (the hit's own).
export interface SoundStart {
  id: string;
  when: number;
  offset: number;
  gain: number;
}

// Every sound the version plays over the voice (`soundCues`, the builder's
// own list: the sound track's items, their starts resolved through the
// transcript, a visual's cue and a big word's playing the pop, and the typed
// hook's key sounds, their gain set against the transcript's measured voice),
// so the preview plays exactly the `<audio>` clips the export mixes, each at
// the clip's own gain.
export function soundHits(edit: Edit, transcript: Transcript, preset: Preset): SoundHit[] {
  return soundCues(edit, resolveTimeline(edit, transcript), preset, transcript.voice).map(
    (cue) => ({
      id: cue.id,
      file: cue.file,
      at: cue.at,
      gain: cue.volume,
      duration: cue.duration,
    }),
  );
}

// The starts for playback from `playhead` (reel seconds) with the audio
// context at `ctxNow`: hits ahead start at their offset from the playhead, a
// hit in progress starts now part way in, hits already over are skipped.
export function scheduleAt(
  hits: readonly SoundHit[],
  playhead: number,
  ctxNow: number,
): SoundStart[] {
  const starts: SoundStart[] = [];
  for (const hit of hits) {
    if (hit.at >= playhead) {
      starts.push({ id: hit.id, when: ctxNow + (hit.at - playhead), offset: 0, gain: hit.gain });
    } else if (playhead < hit.at + hit.duration) {
      starts.push({ id: hit.id, when: ctxNow, offset: playhead - hit.at, gain: hit.gain });
    }
  }
  return starts;
}
