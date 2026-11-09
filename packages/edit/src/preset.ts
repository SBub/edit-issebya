import type { Box } from "./head-track.ts";

export type FontKey = "primary" | "secondary";
export const FONT_KEYS = ["primary", "secondary"] as const satisfies readonly FontKey[];

export interface PresetFont {
  family: string;
  // Relative to packages/edit (and to the built page): `assets/fonts/...`.
  file: string;
  weight: number;
  size: number;
}

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
  // The line Claude reads about the kind.
  description?: string;
}

export type SoundKey = "click";
export const SOUND_KEYS = ["click"] as const satisfies readonly SoundKey[];

export interface PresetSound {
  file: string;
  durationSeconds: number;
  gainDb: number;
  // Two hits of the sound are never closer than this.
  minGapSeconds: number;
}

// A VISUAL is a small corner card (picture in picture): an empty white frame
// over the footage, in front of the speaker. The placer (`engine-place.ts`)
// places it as a box from the `visual/card` entry of `variants.ts`, whose
// `width` (1/3) and `aspect` (4/5) read back to the values here; its zones (a
// corner of the safe zone inset `inset`, then beside the face) are the zone
// table's (`engine-zones.ts`).
interface PresetCard {
  // Its width as a share of the frame's width (a third) and its ratio, width
  // over height (4:5): 360 by 450 px, the card's full size; the placer shrinks
  // from it in 10% steps where the spot is smaller.
  widthShare: number;
  aspect: number;
  // The gap a corner card keeps from the edges of the platform safe zone.
  inset: number;
  // The frame's white stroke, in pixels (the builder's `.visual` rule).
  stroke: number;
}

export interface PresetBehind {
  // A big word: the placer's largest fit (`engine-place.ts`, the `bigWord`
  // style of `variants.ts`), centred, its vertical centre wanted
  // `belowHeadTop` below the head's top (or at `noHeadY` with no head in the
  // frame; the zone table of `engine-zones.ts` holds the same offsets), moved
  // up (never above the safe zone's top), then smaller, until the face covers
  // at most `1 - minVisible` of its height: only its lower part behind the
  // head. It takes the accent's timing.
  word: {
    font: FontKey;
    color: string;
    belowHeadTop: number;
    noHeadY: number;
    minVisible: number;
  };
  // The cut-out covers each item plus this many frames on each side.
  padFrames: number;
  frameRate: number;
  // A VISUAL lasts between these, in seconds.
  minSeconds: number;
  maxSeconds: number;
  // A VISUAL's card (see `PresetCard`).
  card: PresetCard;
}

// How busy an edit is: the levels a preset may edit at. The preset names its
// level (`intensity`), and its pace block is that level's; a later level (Calm,
// Medium) is one more name here with its own pace block.
export type Intensity = "calm" | "medium" | "intense";

// One intensity level's pacing, in seconds of reel.
export interface PresetPace {
  // Something new on screen besides the captions (an accent, a big word, a
  // visual or a transition) at least this often: what the editor aims for.
  extraEverySeconds: number;
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

export interface GlossaryTerm {
  term: string;
  // The word sequences the transcriber writes for it, lower-case, cleaned.
  heard: string[][];
}

export interface Preset {
  id: "issebya";
  frame: { width: number; height: number };
  fonts: Record<FontKey, PresetFont>;
  caption: {
    font: FontKey;
    color: string;
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
    // The line captions use when no head is in the frame.
    fallbackY: number;
    lineGap: number;
  };
  // An accent or a question shows exactly while its words are spoken, like a
  // caption (no lead, no minimum). A big word behind the speaker shows from
  // `leadSeconds` before its one word (so its entrance has finished as the word
  // is heard) to `afterSeconds` after it, at least `minSeconds`.
  accent: {
    font: FontKey;
    color: string;
    aboveHead: number;
    noHeadY: number;
    minSeconds: number;
    afterSeconds: number;
    leadSeconds: number;
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
  glossary: GlossaryTerm[];
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
  fonts: {
    primary: {
      family: "Raleway Light",
      file: "assets/fonts/Raleway-Light.ttf",
      weight: 300,
      size: 110,
    },
    secondary: {
      family: "Golos Text",
      file: "assets/fonts/GolosText-Bold.ttf",
      weight: 700,
      size: 50,
    },
  },
  caption: {
    font: "secondary",
    color: "#FFFFFF",
    rise: 12,
    inSeconds: 0.18,
    inEase: "power2.out",
    outSeconds: 0.15,
    minSeconds: 0.25,
    groupPauseSeconds: 0.35,
    groupMaxUnits: 4,
    fallbackY: 1290,
    lineGap: 14,
  },
  accent: {
    font: "primary",
    color: "#FFFFFF",
    aboveHead: 190,
    noHeadY: 1130,
    minSeconds: 1.5,
    afterSeconds: 1,
    leadSeconds: 0.2,
  },
  layout: { gap: 12 },
  // Starting values; the owner tunes them by eye on a real reel.
  transitions: {
    numbered: {
      layer: FRAME,
      motion: "fade",
      seconds: 0.3,
      ease: "power2.out",
      description:
        "a large number over the phrase, the phrase below: for each item of a list the speaker goes through, numbered in order",
    },
  },
  transition: {
    gap: 24,
  },
  // Intense (the pros' level): something new about every 3 s, a written hook
  // from 0.2 s (the big word's lead) to 3 s, the first seconds that decide
  // whether people keep watching.
  pace: {
    extraEverySeconds: 3,
    hook: { fromSeconds: 0.2, untilSeconds: 3, maxWords: 7, maxCharacters: 45 },
  },
  // One pick (a component) per this many seconds of speech, at each level.
  picksEverySeconds: { intense: 2.5, medium: 4.5, calm: 10 },
  sounds: {
    click: {
      file: "assets/sounds/mouse-click-trimmed.wav",
      durationSeconds: 0.23,
      gainDb: -6,
      minGapSeconds: 0.25,
    },
  },
  // Starting values; the owner tunes them by eye on a real reel.
  behind: {
    word: {
      font: "primary",
      color: "#FFFFFF",
      belowHeadTop: 60,
      noHeadY: 700,
      minVisible: 0.7,
    },
    padFrames: 3,
    frameRate: 30,
    minSeconds: 1,
    maxSeconds: 2,
    card: {
      widthShare: 1 / 3,
      aspect: 4 / 5,
      inset: 40,
      stroke: 8,
    },
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
  glossary: [{ term: "lock-in", heard: [["locking"], ["lock", "in"]] }],
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
