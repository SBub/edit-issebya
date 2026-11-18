import { cueSound } from "./clicks.ts";
import type { Preset, PresetSound } from "./preset.ts";
import { type RevealLetter, hookReveal } from "./reveal.ts";
import type { Edit } from "./schema.ts";
import type { Span } from "./timeline.ts";
import type { Voice } from "./transcript.ts";
import { VARIANTS } from "./variants.ts";

// EVERY SOUND A VERSION PLAYS over the voice, each as one cue: the items of
// its sound track (a click, or the pop of a visual's cue and a big word's,
// `cueSound`) and the key sounds of its typed hook. Every sound is one of the
// preset's (`preset.sounds`, the one sound table), named by a variant entry's
// `sound` knob or by the track's item. The builder writes one `<audio>`
// element per cue (the export mixes them, the full page and the `sound` page
// alike) and the studio's preview plays the same cues through Web Audio, so
// both always play the same sounds at the same moments.

// HOW LOUD A SOUND PLAYS. An item of the sound track plays at the preset's
// fixed gain for its sound (`gainDb`, or the item's own `gain_db`). The typing
// is set from the speaker's voice, never by a fixed gain: `soundLevel` (the
// variant entry's, -8) is the key sounds' loudness in dB against the voice's
// measured loudness where the hook is typed. Both are RMS levels in dBFS: the
// voice's from retime's measure (`Transcript.voice`, 0.1 s windows), the key
// files' from the preset's sound (`level`, measured once). RMS and not
// LUFS, because a key press lasts 70 ms and the shortest LUFS window is
// 400 ms: only a plain RMS measures a hit and the voice the same way. The
// pauses are left out of the voice's level the way BS.1770 gates them.

// One sound, played once.
export interface SoundCue {
  // The id of its `<audio>` element.
  id: string;
  // The file, relative to packages/edit.
  file: string;
  // When it starts, in reel seconds.
  at: number;
  // How long it plays: the file's length, cut at the reel's end.
  duration: number;
  // Linear gain, 0 to 1 and above, to four decimals: the element's
  // `data-volume` and the preview's gain, the same number.
  volume: number;
  // The page's track of the element (`data-track-index`).
  track: number;
}

// The sound track's items (the clicks and the pops) and the typed hook's key
// sounds, on tracks of their own.
const SOUND_TRACK = 60;
const TYPING_TRACK = 61;

// The voice a sound is set against: its level (RMS) and its highest peak, in
// dBFS, and where they were measured: over the `span` asked for, over the
// whole `reel` (the span is near silent), or `assumed` (no measure at all).
export interface VoiceLevel {
  level: number;
  peak: number;
  from: "span" | "reel" | "assumed";
}

// The voice of a version with no measure (its transcript was written before
// retime measured the voice) or of a silent reel: an everyday phone recording,
// speech at -20 dBFS with peaks at -3 dBFS.
export const ASSUMED_VOICE: VoiceLevel = { level: -20, peak: -3, from: "assumed" };

// A window quieter than this is silence or room tone, never voice.
const SILENCE_DB = -50;
// A window more than this under the mean of the others is a pause.
const PAUSE_BELOW_DB = 10;
// A span holding less voice than this is near silent: the whole reel's voice
// is taken.
const MIN_VOICE_SECONDS = 0.3;
// The mix's ceiling: full scale.
const FULL_SCALE = 1;

const linear = (db: number) => 10 ** (db / 20);
const decibels = (value: number) => 20 * Math.log10(value);
const power = (db: number) => 10 ** (db / 10);

// The level of the voice in `levels`, pauses left out: the mean power of the
// windows over the silence floor, then of those no more than 10 dB under that
// mean. `windows` is how many windows held voice.
function spokenLevel(levels: readonly number[]): { level: number; windows: number } | null {
  const mean = (list: readonly number[]) =>
    10 * Math.log10(list.reduce((sum, db) => sum + power(db), 0) / list.length);
  const heard = levels.filter((db) => db > SILENCE_DB);
  if (heard.length === 0) return null;
  const floor = mean(heard) - PAUSE_BELOW_DB;
  const spoken = heard.filter((db) => db >= floor);
  return { level: mean(spoken), windows: spoken.length };
}

// The windows of the voice that `span` touches.
function windowsOver(voice: Voice, span: Span): [number, number] {
  const first = Math.max(Math.floor(span.start / voice.windowSeconds + 1e-9), 0);
  const end = Math.min(Math.ceil(span.end / voice.windowSeconds - 1e-9), voice.levels.length);
  return [first, Math.max(end, first)];
}

// The voice over `span`: its level and peak there when the span holds at
// least 0.3 s of voice, else the whole reel's, else the assumed voice.
export function voiceLevel(voice: Voice | undefined, span: Span): VoiceLevel {
  if (!voice) return ASSUMED_VOICE;
  const [first, end] = windowsOver(voice, span);
  const inSpan = spokenLevel(voice.levels.slice(first, end));
  if (inSpan && inSpan.windows * voice.windowSeconds >= MIN_VOICE_SECONDS - 1e-9) {
    return { level: inSpan.level, peak: Math.max(...voice.peaks.slice(first, end)), from: "span" };
  }
  const whole = spokenLevel(voice.levels);
  if (!whole) return ASSUMED_VOICE;
  return { level: whole.level, peak: Math.max(...voice.peaks), from: "reel" };
}

// The gain of a key sound typed over `span` (from its first hit to the end of
// its last), as a function of one hit's own time: `soundLevel` dB against the
// voice's level there, under two hard ceilings.
// 1. A hit's peak is never over the voice's peak.
// 2. A hit's peak and the voice's peak in the windows the hit plays over never
//    add up to more than full scale, so the mix cannot clip whatever the two
//    waves do. This one is per hit: a hit under a loud syllable is turned
//    down, the others are not. A hit over a voice already at full scale is
//    silent.
// Linear, to four decimals. Without a measure both ceilings take the assumed
// voice's peak.
export function typingGain(
  sound: Pick<PresetSound, "level" | "peak">,
  soundLevel: number,
  voice: Voice | undefined,
  span: Span,
): (at: number, duration: number) => number {
  const against = voiceLevel(voice, span);
  const wanted = Math.min(against.level + soundLevel - sound.level, against.peak - sound.peak);
  return (at, duration) => {
    let under = against.peak;
    if (voice) {
      const [first, end] = windowsOver(voice, { start: at, end: at + duration });
      under = Math.max(-Infinity, ...voice.peaks.slice(first, end));
    }
    const room = FULL_SCALE - linear(under);
    if (room <= 0) return 0;
    const gain = Math.min(wanted, decibels(room) - sound.peak);
    return Math.floor(linear(gain) * 10000) / 10000;
  };
}

// The key sounds of a typed text, in step with its letters: a hit at the very
// moment a letter appears, on every letter while the letters are at least the
// sound's `minGapSeconds` apart, else on every second, third, ... letter (the smallest
// step that keeps two hits that far apart), so a long line typed fast still
// sounds like typing and never like a buzz. The sound's files are played in turn. A
// hit ends where the next one starts and at the reel's end; one with no time
// left is left out. Each hit plays `soundLevel` dB against the `voice`
// (`typingGain`). Ids are `<item>_k<n>` (an underscore, which no item id may
// hold).
export function typingCues(
  itemId: string,
  reveal: readonly RevealLetter[],
  sound: PresetSound,
  soundLevel: number,
  voice: Voice | undefined,
  reelEnd: number,
): SoundCue[] {
  if (reveal.length === 0) return [];
  const first = reveal[0]!.at;
  const last = reveal.at(-1)!.at;
  const between = reveal.length > 1 ? (last - first) / (reveal.length - 1) : 0;
  // Every letter at one moment (a span of no length): one hit.
  const step =
    between <= 0 ? reveal.length : Math.max(1, Math.ceil(sound.minGapSeconds / between - 1e-9));
  const hits = reveal.filter((_, index) => index % step === 0);
  const gain = typingGain(sound, soundLevel, voice, {
    start: first,
    end: Math.min(hits.at(-1)!.at + sound.durationSeconds, reelEnd),
  });
  return hits.flatMap((hit, index) => {
    const next = hits[index + 1]?.at ?? Infinity;
    const duration = Math.round(
      Math.min(sound.durationSeconds, next - hit.at, reelEnd - hit.at) * 1000,
    );
    if (duration <= 0) return [];
    return [
      {
        id: `${itemId}_k${index + 1}`,
        file: sound.files[index % sound.files.length]!,
        at: hit.at,
        duration: duration / 1000,
        volume: gain(hit.at, duration / 1000),
        track: TYPING_TRACK,
      },
    ];
  });
}

// The cues of a version: its sound track's items in the track's order, each
// playing the sound the builder plays (`cueSound`: a visual's cue and a big
// word's are the pop, whatever version stored them) at the preset's gain (or
// the item's own `gain_db`), then its hook's key sounds (the hook entry's
// `sound`), set against `voice` (the transcript's) at the entry's
// `soundLevel`. `resolved` is the edit's resolved timeline
// (`resolveTimeline`).
export function soundCues(
  edit: Edit,
  resolved: ReadonlyMap<string, Span>,
  preset: Preset,
  voice: Voice | undefined,
): SoundCue[] {
  const span = (id: string) => {
    const found = resolved.get(id);
    if (!found) throw new Error(`sound cues: ${id} is not resolved`);
    return found;
  };
  const cues: SoundCue[] = edit.tracks.sounds.map((item) => {
    const sound = preset.sounds[cueSound(item, edit.tracks.behind)];
    const { start } = span(item.id);
    return {
      id: item.id,
      file: sound.files[0],
      at: start,
      duration: Math.min(sound.durationSeconds, Math.max(edit.duration - start, 0)),
      volume: 10 ** ((item.gain_db ?? sound.gainDb) / 20),
      track: SOUND_TRACK,
    };
  });
  const entry = VARIANTS["hook/typed"];
  for (const item of edit.tracks.overlays) {
    if (item.kind !== "hook") continue;
    cues.push(
      ...typingCues(
        item.id,
        hookReveal(item.text ?? "", span(item.id)),
        preset.sounds[entry.sound],
        entry.soundLevel,
        voice,
        edit.duration,
      ),
    );
  }
  return cues;
}

// Every file of the preset's sounds (each sound's takes), for whoever serves
// or copies the package's assets.
export function soundFiles(preset: Preset): string[] {
  return Object.values(preset.sounds).flatMap((sound) => [...sound.files]);
}
