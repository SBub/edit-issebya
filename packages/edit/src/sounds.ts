import type { ResolvedItem } from "./layout.ts";
import type { Preset } from "./preset.ts";
import { resolveAll } from "./resolve.ts";
import { editSchema } from "./schema.ts";
import type { Transcript } from "./transcript.ts";

// One item of the sounds track, resolved: when it plays (seconds, to the
// millisecond), which preset file, at what linear gain and for how long. The
// builder writes its `<audio>` lines from these and the studio's preview
// schedules its clicks from them: one source for when a click plays.
export interface SoundHit {
  id: string;
  at: number;
  // Relative to the package's `assets/` folder.
  file: string;
  // Relative to the built page: `assets/<file>`.
  path: string;
  gain: number;
  duration: number;
}

// The hits among already resolved items, in their order (start, then id).
export function hitsOf(resolved: ResolvedItem[], preset: Preset): SoundHit[] {
  const hits: SoundHit[] = [];
  for (const entry of resolved) {
    if (entry.track !== "sounds" || !("sound" in entry.item)) continue;
    const sound = preset.sounds[entry.item.sound]!;
    hits.push({
      id: entry.id,
      at: entry.start,
      file: sound.file,
      path: `assets/${sound.file}`,
      gain: 10 ** ((entry.item.gainDb ?? sound.gainDb) / 20),
      duration: sound.duration,
    });
  }
  return hits;
}

// Every hit of an edit's sounds track. The edit is checked like `build`
// checks it (an invalid edit throws).
export function soundHits(input: unknown, transcript: Transcript, preset: Preset): SoundHit[] {
  const edit = editSchema({ transcript, preset }).parse(input);
  return hitsOf(resolveAll(edit, transcript), preset);
}
