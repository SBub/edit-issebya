import type { Box } from "./head-track.ts";
import type { Transcript } from "./transcript.ts";

// The transition kinds: the LIST (`numbered`), the one kind a transition takes.
export const TRANSITION_KINDS = ["numbered"] as const;
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

// One transition kind. No colour, no background and no font: the layer only
// places the phrase's text levels (the caption and accent roles).
export interface PresetTransition {
  // The frame the text levels are placed in, in frame pixels.
  layer: Box;
  // How the layer comes in and goes out: a fade, or a slide up from below.
  motion: "fade" | "slide";
  seconds: number;
  ease: string;
}

// The brief sounds a version can play, by name: the files and levels are the
// preset's (`sounds`), the one sound table. A variant names one as its `sound`
// knob (`variants.ts`), so a name that is not here fails typecheck. `pop` is
// cued (a visual and a big word); `typing` is the typed hook's key sound;
// `click` is what the track stores and what any other item plays; `shutter`
// and `whoosh` are data for later.
export type SoundKey = "click" | "shutter" | "whoosh" | "pop" | "typing";
export const SOUND_KEYS = [
  "click",
  "shutter",
  "whoosh",
  "pop",
  "typing",
] as const satisfies readonly SoundKey[];

// One sound (`assets/sounds/LICENSE-sounds.md`). `files` are its recordings:
// one, or a few takes of it (one key press each) played in turn, so two hits
// in a row never sound the same; an item of the sound track plays the first.
// `durationSeconds` is the length of each file. `gainDb` is the fixed gain it
// plays at as an item of the sound track (a click, a cue's pop). `level` and
// `peak` are the files' own loudness, in dBFS, measured once (the files never
// change; `sounds.test.ts` reads them and holds both numbers): `level` the RMS
// over a whole file, as a mean of the files' power, `peak` the highest sample
// of any of them. A sound played against the speaker's voice (a variant
// entry's `soundLevel`: the typed hook's) takes its gain from these two and
// never reads `gainDb`.
export interface PresetSound {
  files: readonly [string, ...string[]];
  durationSeconds: number;
  gainDb: number;
  // Two hits of the sound are never closer than this.
  minGapSeconds: number;
  level: number;
  peak: number;
}

// The behind layer's cut-out and its frames. A VISUAL's card, a big word's style
// and their timing are the variant entries' and the style table's
// (`variants.ts`); the zones are the zone table's (`engine-zones.ts`).
export interface PresetBehind {
  // The cut-out covers each item plus this many frames on each side.
  padFrames: number;
  frameRate: number;
}

// How busy an edit is: the levels a preset may edit at. The preset names its
// level (`intensity`), and its pace block is that level's; a later level (Calm,
// Medium) is one more name here with its own pace block.
export type Intensity = "calm" | "medium" | "intense";

// One intensity level's pacing, in seconds of reel.
export interface PresetPace {
  // The written hook: one line Claude writes (never spoken) shown from
  // `fromSeconds` to `untilSeconds` of reel, the one extra of that window;
  // at most `maxWords` words and `maxCharacters` characters.
  hook: PresetHook;
}

interface PresetHook {
  fromSeconds: number;
  untilSeconds: number;
  maxWords: number;
  maxCharacters: number;
}

export interface Preset {
  id: "issebya";
  frame: { width: number; height: number };
  caption: {
    // Appear: opacity 0 to 1 while rising `rise` pixels; disappear: a fade.
    rise: number;
    inSeconds: number;
    inEase: string;
    outSeconds: number;
    // A caption stays at least this long.
    minSeconds: number;
    // A group (one set of words on screen) breaks at a pause this long, or
    // after this many units.
    groupPauseSeconds: number;
    groupMaxUnits: number;
    lineGap: number;
  };
  // The decide limit's slack after a big word's last word (`schema.ts`); a big
  // word's lead and minimum are its entry's timing (`variants.ts`).
  accent: {
    afterSeconds: number;
  };
  // The layout engine: text keeps `gap` pixels from the face and from other
  // text (its sizes are the styles' and the placer's, `engine-place.ts`).
  layout: { gap: number };
  transitions: Record<TransitionKind, PresetTransition>;
  // A LIST's layer shows exactly while its phrase is spoken (no hold).
  // `gap` pixels between stacked text levels.
  transition: {
    gap: number;
  };
  // How busy the reel is: the level the preset edits at, and that level's pace.
  intensity: Intensity;
  pace: PresetPace;
  // The components' target: the speech's duration divided by this many seconds
  // per pick, at each level (the decide step asks for that many picks).
  picksEverySeconds: Record<Intensity, number>;
  sounds: Record<SoundKey, PresetSound>;
  behind: PresetBehind;
  // Words a caption keeps capitalised (lower-case key, shown value).
  keepCaps: Record<string, string>;
  // Joined with the number before them into one caption unit.
  units: string[];
  // Joined with a day number into one caption unit.
  months: string[];
}

const FRAME = { left: 0, right: 1080, top: 0, bottom: 1920 };

// The part of both boxes: the larger left and top, the smaller right and bottom.
export function intersectBox(a: Box, b: Box): Box {
  return {
    left: Math.max(a.left, b.left),
    right: Math.min(a.right, b.right),
    top: Math.max(a.top, b.top),
    bottom: Math.min(a.bottom, b.bottom),
  };
}

// Where TikTok and Instagram Reels leave text visible at 1080x1920 (owner
// decision 2026-11-03, from a TikTok and Instagram safe-zone reference,
// replacing issue #114's 120, 840, 252, 1164): 220 px covered at the top,
// 35 px at each side and 450 px at the bottom. A guard, not a taste value: no
// preset and no change request moves it.
export const PLATFORM_SAFE: Box = { left: 35, right: 1045, top: 220, bottom: 1470 };

// The platforms' button column (like, comment, share) on the right: from its
// top (1164) down to the bottom zone it covers a further 100 px inside
// `PLATFORM_SAFE`, so text below that line stays left of x 945. The reference
// drawing does not label the column's top: 1164 is measured from it (TikTok's
// older reference agrees). Both are starting values the owner tunes by eye
// with the studio's Zones button.
const PLATFORM_BUTTONS_TOP = 1164;
const PLATFORM_BUTTONS_WIDTH = 100;

// The notch the button column cuts out of `PLATFORM_SAFE`'s lower-right
// corner; text inside `PLATFORM_SAFE` never overlaps it.
export const PLATFORM_BUTTONS: Box = {
  left: PLATFORM_SAFE.right - PLATFORM_BUTTONS_WIDTH,
  right: PLATFORM_SAFE.right,
  top: PLATFORM_BUTTONS_TOP,
  bottom: PLATFORM_SAFE.bottom,
};

// The issebya style: the values of the approved `rethink-work` reel.
export const ISSEBYA_PRESET: Preset = {
  id: "issebya",
  intensity: "intense",
  frame: { width: 1080, height: 1920 },
  caption: {
    rise: 12,
    inSeconds: 0.18,
    inEase: "power2.out",
    outSeconds: 0.15,
    minSeconds: 0.25,
    groupPauseSeconds: 0.35,
    groupMaxUnits: 4,
    lineGap: 14,
  },
  accent: {
    afterSeconds: 1,
  },
  layout: { gap: 12 },
  // Starting values; the owner tunes them by eye on a real reel.
  transitions: {
    numbered: {
      layer: FRAME,
      motion: "fade",
      seconds: 0.3,
      ease: "power2.out",
    },
  },
  transition: {
    gap: 24,
  },
  // Intense (the pros' level): a written hook from 0.2 s to 3 s, the first
  // seconds that decide whether people keep watching.
  pace: {
    hook: { fromSeconds: 0.2, untilSeconds: 3, maxWords: 7, maxCharacters: 45 },
  },
  // One pick (a component) per this many seconds of speech, at each level.
  picksEverySeconds: { intense: 2.5, medium: 4.5, calm: 10 },
  sounds: {
    click: {
      files: ["assets/sounds/mouse-click-trimmed.wav"],
      durationSeconds: 0.23,
      gainDb: -6,
      minGapSeconds: 0.25,
      level: -26.4,
      peak: -0.2,
    },
    // The other sounds (assets/sounds/LICENSE-sounds.md): each
    // file is levelled so that its loudest 100 ms has the click's energy, so
    // one gain gives all four the click's loudness under the voice.
    shutter: {
      files: ["assets/sounds/camera-shutter.wav"],
      durationSeconds: 0.448,
      gainDb: -6,
      minGapSeconds: 0.25,
      level: -26.2,
      peak: -4.5,
    },
    whoosh: {
      files: ["assets/sounds/whoosh.wav"],
      durationSeconds: 0.47,
      gainDb: -6,
      minGapSeconds: 0.25,
      level: -29.4,
      // Rounded up, never under the real one (-14.898).
      peak: -14.89,
    },
    pop: {
      files: ["assets/sounds/pop.wav"],
      durationSeconds: 0.152,
      gainDb: -6,
      minGapSeconds: 0.25,
      level: -24.6,
      peak: -5.2,
    },
    // A laptop keyboard, one key press a file: the typed hook's key sound,
    // played in turn. Not levelled to the click: the hook sets its level from
    // the speaker's voice (`soundLevel`). Two hits keep a file's length apart,
    // so a hit never plays over the one before it.
    typing: {
      files: [
        "assets/sounds/typing-key-1.wav",
        "assets/sounds/typing-key-2.wav",
        "assets/sounds/typing-key-3.wav",
        "assets/sounds/typing-key-4.wav",
      ],
      durationSeconds: 0.07,
      gainDb: -6,
      minGapSeconds: 0.07,
      level: -26.3,
      peak: -6,
    },
  },
  // Starting values; the owner tunes them by eye on a real reel.
  behind: {
    padFrames: 3,
    frameRate: 30,
  },
  keepCaps: { i: "I", "i'm": "I'm", "i've": "I've", "i'll": "I'll", "i'd": "I'd", ai: "AI" },
  units: [
    "%",
    "percent",
    "hours",
    "minutes",
    "seconds",
    "days",
    "weeks",
    "months",
    "years",
    "k",
    "km",
    "kg",
  ],
  months: [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ],
};

// The shortest a pick shows, in seconds. A reel's end or a cut can leave a
// pick under its kind's minimum; it then shows this long (earlier where the
// reel ends), never dropped. The engine, the schema and the checks use it.
export const SHOWN_FLOOR_SECONDS = 0.5;

// A spoken word as a caption shows it (build.py's `clean`): surrounding
// spaces and punctuation stripped, lower-case except the preset's kept words.
export function cleanWord(text: string, preset: Preset): string {
  const lower = text
    .trim()
    .replace(/^[\s,.?!:;"]+|[\s,.?!:;"]+$/g, "")
    .toLowerCase();
  return preset.keepCaps[lower] ?? lower;
}

// The text of some spoken words: each word cleaned, joined by spaces.
export function wordsText(ids: readonly string[], transcript: Transcript, preset: Preset): string {
  const byId = new Map(transcript.words.map((word) => [word.id, word]));
  return ids.map((id) => cleanWord(byId.get(id)?.text ?? "", preset)).join(" ");
}
