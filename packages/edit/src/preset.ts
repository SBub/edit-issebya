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

export type TransitionType = "dim" | "panel" | "card";
export const TRANSITION_TYPES = [
  "dim",
  "panel",
  "card",
] as const satisfies readonly TransitionType[];

export interface PresetTransition {
  // The layer covering the footage, in frame pixels.
  layer: Box;
  background: string;
  // How the layer comes in and goes out: a fade, or a slide up from below.
  motion: "fade" | "slide";
  seconds: number;
  ease: string;
  // Where captions inside the transition's span are set.
  text: Box;
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

// Where a library photo goes behind the speaker: three preset spots.
export type BehindSpot = "top" | "left" | "right";
export const BEHIND_SPOTS = ["top", "left", "right"] as const satisfies readonly BehindSpot[];

export interface PresetBehind {
  // Each spot's rectangle in frame pixels; the photo covers it exactly.
  spots: Record<BehindSpot, Box>;
  // The one big word: as large as fits between the side margins (at most
  // `maxSize`), centred, its vertical centre `belowHeadTop` below the head's
  // top so the head overlaps it, or at `noHeadY` with no head in the frame.
  word: {
    font: FontKey;
    maxSize: number;
    margin: number;
    color: string;
    belowHeadTop: number;
    noHeadY: number;
  };
  // The cut-out covers each item plus this many frames on each side.
  padFrames: number;
  frameRate: number;
  // A behind item lasts between these, in seconds.
  minSeconds: number;
  maxSeconds: number;
}

export interface GlossaryTerm {
  term: string;
  // The word sequences the transcriber writes for it, lower-case, cleaned.
  heard: string[][];
}

export interface Preset {
  id: "issebya";
  frame: { width: number; height: number };
  // Text never leaves it.
  safe: Box;
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
  accent: { font: FontKey; color: string; aboveHead: number; noHeadY: number };
  // Spots beside the head (build.py's `_slots`).
  slots: { firstRow: number; rowGap: number; rightDrop: number; minLeft: number; minRight: number };
  transitions: Record<TransitionType, PresetTransition>;
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

// The issebya style: the values of the approved `rethink-work` reel.
export const ISSEBYA_PRESET: Preset = {
  id: "issebya",
  frame: { width: 1080, height: 1920 },
  safe: { left: 130, right: 860, top: 260, bottom: 1400 },
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
  accent: { font: "primary", color: "#B3E6FF", aboveHead: 190, noHeadY: 1130 },
  slots: { firstRow: 610, rowGap: 85, rightDrop: 42, minLeft: 110, minRight: 90 },
  transitions: {
    dim: {
      layer: FRAME,
      background: "rgba(0, 0, 0, 0.62)",
      motion: "fade",
      seconds: 0.3,
      ease: "power2.out",
      text: { left: 130, right: 860, top: 1180, bottom: 1400 },
    },
    panel: {
      layer: { left: 0, right: 1080, top: 1150, bottom: 1920 },
      background: "#121212",
      motion: "slide",
      seconds: 0.5,
      ease: "power3.inOut",
      text: { left: 130, right: 860, top: 1200, bottom: 1400 },
    },
    card: {
      layer: FRAME,
      background: "rgba(8, 8, 8, 0.9)",
      motion: "fade",
      seconds: 0.25,
      ease: "power2.out",
      text: { left: 130, right: 860, top: 640, bottom: 1400 },
    },
  },
  sounds: {
    click: {
      file: "assets/sounds/mouse-click-trimmed.wav",
      durationSeconds: 0.23,
      gainDb: -13,
      minGapSeconds: 0.25,
    },
  },
  // Starting values; the owner tunes them by eye on a real reel.
  behind: {
    spots: {
      top: { left: 90, right: 990, top: 160, bottom: 760 },
      left: { left: 40, right: 500, top: 560, bottom: 1180 },
      right: { left: 580, right: 1040, top: 560, bottom: 1180 },
    },
    word: {
      font: "secondary",
      maxSize: 400,
      margin: 40,
      color: "#FFFFFF",
      belowHeadTop: 60,
      noHeadY: 700,
    },
    padFrames: 3,
    frameRate: 30,
    minSeconds: 2,
    maxSeconds: 4,
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

// A spoken word as a caption shows it (build.py's `clean`): surrounding
// spaces and punctuation stripped, lower-case except the preset's kept words.
export function cleanWord(text: string, preset: Preset): string {
  const lower = text
    .trim()
    .replace(/^[\s,.?!:;"]+|[\s,.?!:;"]+$/g, "")
    .toLowerCase();
  return preset.keepCaps[lower] ?? lower;
}
