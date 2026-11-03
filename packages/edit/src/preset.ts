import type { Box } from "./head-track.ts";

export type FontKey = "primary" | "secondary";
export const FONT_KEYS = ["primary", "secondary"] as const satisfies readonly FontKey[];

export interface PresetFont {
  family: string;
  // Relative to packages/edit (and to the built page): `assets/fonts/...`.
  file: string;
  weight: number;
}

// A text role of the style: the font, colour and size a kind of text is set
// in. Transitions and the default caption and accent read them, so a later
// font pair or colour wheel changes the roles, never a transition.
export interface TextRole {
  font: FontKey;
  color: string;
  size: number;
}

export interface PresetRoles {
  accentText: TextRole;
  captionText: TextRole;
  background: { color: string };
}

// What `decide` may choose for a transition.
export type TransitionType = "dim" | "panel" | "numbered";
export const TRANSITION_TYPES = [
  "dim",
  "panel",
  "numbered",
] as const satisfies readonly TransitionType[];

// What a stored timed transition (one with `start` and `end`) may name.
export type LegacyTransitionType = "dim" | "panel" | "card";
export const LEGACY_TRANSITION_TYPES = [
  "dim",
  "panel",
  "card",
] as const satisfies readonly LegacyTransitionType[];

// One transition of the library: never a font or a colour, only the roles.
export interface LibraryTransition {
  // The layer covering the footage, in frame pixels.
  layer: Box;
  // The background role, at this opacity (1 is solid).
  background: { role: "background"; strength: number };
  // How the layer comes in and goes out: a fade, or a slide up from below.
  motion: "fade" | "slide";
  // The default length of the entrance and of the exit.
  seconds: number;
  ease: string;
  // Where the phrase's levels are set; inside the platform guard.
  text: Box;
  // What Claude reads to pick the type.
  description: string;
  // `numbered` only: the number's size over the accent text's.
  numberScale?: number;
}

// The frozen look of a stored timed transition.
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
  // A decide answer holds at most this many photos and big words per reel.
  maxPhotos: number;
  maxWords: number;
  // The largest share (0 to 1) of a photo's spot the face box may cover.
  maxFaceShare: number;
}

export interface TransitionRules {
  // A phrase transition holds at most this long after its last word.
  maxHoldSeconds: number;
  // A phrase transition lasts at least this long.
  minSeconds: number;
  // At most one transition per this many seconds of reel (at least one).
  densitySeconds: number;
  // The ranges a change request may set `motion_seconds` and `hold_seconds` in.
  motionRange: { min: number; max: number };
  holdRange: { min: number; max: number };
  // The levels shrink together down to this share of their size to fit.
  shrinkFloor: number;
}

export interface GlossaryTerm {
  term: string;
  // The word sequences the transcriber writes for it, lower-case, cleaned.
  heard: string[][];
}

export interface Preset {
  id: "issebya";
  frame: { width: number; height: number };
  // Text never leaves it; always inside `PLATFORM_SAFE`.
  safe: Box;
  fonts: Record<FontKey, PresetFont>;
  roles: PresetRoles;
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
    // The line captions use when no head is in the frame.
    fallbackY: number;
    lineGap: number;
  };
  accent: { aboveHead: number; noHeadY: number };
  // Spots beside the head (build.py's `_slots`).
  slots: { firstRow: number; rowGap: number; rightDrop: number; minLeft: number; minRight: number };
  transitions: Record<TransitionType, LibraryTransition>;
  legacyTransitions: Record<LegacyTransitionType, PresetTransition>;
  transitionRules: TransitionRules;
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

// Where TikTok and Instagram Reels leave text visible at 1080x1920: the
// stricter edge of the two platforms on each side (TikTok's reference: top
// 252, left 120, a 240 px right margin beside the button column, 756 px
// covered at the bottom). A guard, not a taste value: no preset and no change
// request moves it (owner decision, issue #114, 2026-11-03).
export const PLATFORM_SAFE: Box = { left: 120, right: 840, top: 252, bottom: 1164 };

// The `rethink-work` style's own box, before the platform guard cuts it.
const STYLE_SAFE: Box = { left: 130, right: 860, top: 260, bottom: 1400 };

// The issebya style: the values of the approved `rethink-work` reel.
export const ISSEBYA_PRESET: Preset = {
  id: "issebya",
  frame: { width: 1080, height: 1920 },
  safe: intersectBox(STYLE_SAFE, PLATFORM_SAFE),
  fonts: {
    primary: {
      family: "Raleway Light",
      file: "assets/fonts/Raleway-Light.ttf",
      weight: 300,
    },
    secondary: {
      family: "Golos Text",
      file: "assets/fonts/GolosText-Bold.ttf",
      weight: 700,
    },
  },
  roles: {
    accentText: { font: "primary", color: "#B3E6FF", size: 110 },
    captionText: { font: "secondary", color: "#FFFFFF", size: 50 },
    background: { color: "#121212" },
  },
  caption: {
    rise: 12,
    inSeconds: 0.18,
    inEase: "power2.out",
    outSeconds: 0.15,
    minSeconds: 0.25,
    groupPauseSeconds: 0.35,
    groupMaxUnits: 4,
    fallbackY: 1054,
    lineGap: 14,
  },
  accent: { aboveHead: 190, noHeadY: 894 },
  slots: { firstRow: 610, rowGap: 85, rightDrop: 42, minLeft: 110, minRight: 90 },
  // Starting values; the owner tunes them by eye on a real reel.
  transitions: {
    dim: {
      layer: FRAME,
      background: { role: "background", strength: 0.62 },
      motion: "fade",
      seconds: 0.3,
      ease: "power2.out",
      text: { left: 130, right: 840, top: 700, bottom: 1164 },
      description: "the key thought of the reel, with its lead-in",
    },
    panel: {
      layer: { left: 0, right: 1080, top: 914, bottom: 1920 },
      background: { role: "background", strength: 1 },
      motion: "slide",
      seconds: 0.5,
      ease: "power3.inOut",
      text: { left: 130, right: 840, top: 964, bottom: 1164 },
      description: "a short statement that should stand alone",
    },
    numbered: {
      layer: FRAME,
      background: { role: "background", strength: 0.4 },
      motion: "fade",
      seconds: 0.3,
      ease: "power2.out",
      text: { left: 130, right: 840, top: 560, bottom: 1164 },
      description:
        "one point of a list; points named in a row are numbered 1, 2, 3 even when not counted aloud",
      numberScale: 1.6,
    },
  },
  // The frozen look of stored timed transitions (the ones with `start` and
  // `end`), so old versions build byte for byte as they did. Never offered to
  // `decide`, never changed, never extended.
  legacyTransitions: {
    dim: {
      layer: FRAME,
      background: "rgba(0, 0, 0, 0.62)",
      motion: "fade",
      seconds: 0.3,
      ease: "power2.out",
      text: { left: 130, right: 840, top: 944, bottom: 1164 },
    },
    panel: {
      layer: { left: 0, right: 1080, top: 914, bottom: 1920 },
      background: "#121212",
      motion: "slide",
      seconds: 0.5,
      ease: "power3.inOut",
      text: { left: 130, right: 840, top: 964, bottom: 1164 },
    },
    card: {
      layer: FRAME,
      background: "rgba(8, 8, 8, 0.9)",
      motion: "fade",
      seconds: 0.25,
      ease: "power2.out",
      text: { left: 130, right: 840, top: 640, bottom: 1164 },
    },
  },
  transitionRules: {
    maxHoldSeconds: 1,
    minSeconds: 1.5,
    densitySeconds: 7,
    motionRange: { min: 0.2, max: 1.5 },
    holdRange: { min: 0, max: 2 },
    shrinkFloor: 0.6,
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
    maxPhotos: 2,
    maxWords: 1,
    maxFaceShare: 0.4,
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

// The size of the first role (accent text, then caption text) set in a font:
// the size an item that names the font and no size gets.
export function fontSize(preset: Preset, font: FontKey): number {
  const { accentText, captionText } = preset.roles;
  return [accentText, captionText].find((role) => role.font === font)?.size ?? captionText.size;
}

// A `#RRGGBB` colour at an opacity: the colour itself when solid, else rgba().
export function backgroundCss(color: string, strength: number): string {
  if (strength >= 1) return color;
  const channel = (at: number) => Number.parseInt(color.slice(at, at + 2), 16);
  return `rgba(${channel(1)}, ${channel(3)}, ${channel(5)}, ${strength})`;
}
