import { type Edit, type Preset, type Transcript, resolveTimeline } from "@edit-issebya/edit";

// One hit of a sound on the edit's sound track, in reel seconds.
export interface SoundHit {
  id: string;
  file: string;
  at: number;
  // Linear gain.
  gain: number;
  duration: number;
}

// One AudioBufferSourceNode start: context time and offset into the sound.
export interface SoundStart {
  id: string;
  when: number;
  offset: number;
}

// Every sound item of the edit, its start resolved through the transcript the
// way the builder resolves it, its file and length from the preset (clamped to
// the reel's end, as the builder writes data-duration).
export function soundHits(edit: Edit, transcript: Transcript, preset: Preset): SoundHit[] {
  const resolved = resolveTimeline(edit, transcript);
  return edit.tracks.sounds.map((item) => {
    const sound = preset.sounds[item.sound];
    const span = resolved.get(item.id);
    if (!span) throw new Error(`sound ${item.id} not resolved`);
    return {
      id: item.id,
      file: sound.file,
      at: span.start,
      gain: 10 ** ((item.gain_db ?? sound.gainDb) / 20),
      duration: Math.min(sound.durationSeconds, Math.max(edit.duration - span.start, 0)),
    };
  });
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
      starts.push({ id: hit.id, when: ctxNow + (hit.at - playhead), offset: 0 });
    } else if (playhead < hit.at + hit.duration) {
      starts.push({ id: hit.id, when: ctxNow, offset: playhead - hit.at });
    }
  }
  return starts;
}
