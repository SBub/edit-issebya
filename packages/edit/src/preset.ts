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

// Every transition type the stored format knows. `card` is kept only so
// versions saved with it still parse and render; it is no longer offered.
export type TransitionType = "dim" | "panel" | "numbered" | "card";
export const TRANSITION_TYPES = [
  "dim",
  "panel",
  "numbered",
  "card",
] as const satisfies readonly TransitionType[];

// The transition library: the kinds Claude may pick.
export const TRANSITION_KINDS = [
  "dim",
  "panel",
  "numbered",
] as const satisfies readonly TransitionType[];
export type TransitionKind = (typeof TRANSITION_KINDS)[number];

// One transition kind. No colour and no font: the layer is the preset's
// `background` role at `shade` opacity, the text inside it takes the caption
// and accent roles.
export interface PresetTransition {
  // The layer covering the footage, in frame pixels.
  layer: Box;
  // The opacity of the background role on the layer (1: the role as is).
  shade: number;
  // How the layer comes in and goes out: a fade, or a slide up from below.
  motion: "fade" | "slide";
  seconds: number;
  ease: string;
  // Where the transition's text levels may go: inside the layer and the
  // safe zone. `want` is the wanted top of the level stack.
  area: Box;
  want: number;
  // The line Claude reads about the kind (library kinds only).
  description?: string;
  // `numbered`: the number's font size.
  numberSize?: number;
  // Where captions inside the transition's span were set in versions saved
  // before the levels (the builder's old path).
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

// Where a library photo goes behind the speaker: three preset spots. A photo
// the layout engine places (a new version) has its own box; its spot names
// the preset spot nearest it.
export type BehindSpot = "top" | "left" | "right";
export const BEHIND_SPOTS = ["top", "left", "right"] as const satisfies readonly BehindSpot[];

// A VISUAL is a small corner card (picture in picture): an empty white frame
// over the footage, in one of these spots. Beside the face spots sit next to
// the moment's face, the others in the platform safe zone's corners.
type CardSpot =
  "top-left" | "top-right" | "bottom-left" | "bottom-right" | "beside-left" | "beside-right";
const CARD_SPOTS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "beside-left",
  "beside-right",
] as const satisfies readonly CardSpot[];

interface PresetCard {
  // Its width as a share of the frame's width (a third) and its ratio, width
  // over height (4:5): 360 by 450 px.
  widthShare: number;
  aspect: number;
  // The share of the card's size tried when no spot fits at the full size
  // (252 by 315 px), before a visual is dropped: on the speech-ten clip the
  // free strip beside the speaker is about 260 px wide, too narrow for 0.8.
  smaller: number;
  // The gap a corner card keeps from the edges of the platform safe zone.
  inset: number;
  // The frame's white stroke, in pixels (the builder's `.visual` rule).
  stroke: number;
  // The ring around a spot whose free space ranks the spots: the share of it
  // no text, face or notch covers is the spot's free space, the most first.
  ring: number;
  // The spots a card may take; a tie in free space goes to the earlier one.
  spots: readonly CardSpot[];
}

export interface PresetBehind {
  // Each spot's rectangle in frame pixels; the photo covers it exactly.
  spots: Record<BehindSpot, Box>;
  // A big word: as large as fits between the side margins (at most
  // `maxSize`), centred, its vertical centre wanted `belowHeadTop` below the
  // head's top (or at `noHeadY` with no head in the frame), moved up (never
  // above `PLATFORM_SAFE`'s top), then smaller, until the person covers at
  // most `1 - minVisible` of its height: only its lower part behind the head.
  // It takes the accent's timing.
  word: {
    font: FontKey;
    maxSize: number;
    margin: number;
    color: string;
    belowHeadTop: number;
    noHeadY: number;
    minVisible: number;
  };
  // The cut-out covers each item plus this many frames on each side.
  padFrames: number;
  frameRate: number;
  // A photo lasts between these, in seconds.
  minSeconds: number;
  maxSeconds: number;
  // The largest share (0 to 1) of a photo's spot the face box may cover.
  maxFaceShare: number;
  // A VISUAL's card (see `PresetCard`).
  card: PresetCard;
  // A library photo (an older version's). The layout engine places no photo
  // now: a visual is a card (`card`). A stored photo behind the speaker is
  // checked with `minVisible` (the person covers at most `1 - minVisible` of
  // its height in every column); a card's white edge needs `minContrast`
  // against the footage within `ring` pixels around it, else it moves to a
  // place nearby that has it, else stays, recorded `low-contrast`.
  photo: {
    minVisible: number;
    minContrast: number;
    ring: number;
  };
}

// One intensity level's pacing, in seconds of reel.
export interface PresetPace {
  // Something new on screen besides the captions (an accent, a big word, a
  // photo or a transition) at least this often: what the editor aims for.
  extraEverySeconds: number;
  // About one transition per this many seconds, at most (the engine drops
  // the rest): slower than the extras, since a transition covers the speaker.
  transitionEverySeconds: number;
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
  // How the layout engine places the picks. `all`: every pick the answer
  // proposed is shown at its own words' times, never dropped for room, for
  // another extra, for the hook or for pace; overlaps are kept (the engine
  // notes them). `clean`: the strict layout, which drops, moves and retimes
  // picks that do not fit and never overlaps. The worker uses `all`.
  placement: "all" | "clean";
  frame: { width: number; height: number };
  // Text never leaves it; always inside `PLATFORM_SAFE`. A rectangle for the
  // placement code: the button-column notch (`PLATFORM_BUTTONS`) is left to
  // the safe-box check.
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
  // An accent shows from `leadSeconds` before its first word (so its
  // entrance has finished as the word is heard) to `afterSeconds` after its
  // last, at least `minSeconds`. A big word behind the speaker takes the
  // same timing, its one word both first and last.
  accent: {
    font: FontKey;
    color: string;
    aboveHead: number;
    noHeadY: number;
    minSeconds: number;
    afterSeconds: number;
    leadSeconds: number;
  };
  // The layout engine: text shrinks to `minScale` of its size before it gives
  // up a place, and keeps `gap` pixels from the face and from other text.
  layout: { minScale: number; gap: number };
  // Readable text (WCAG contrast against the footage behind it): captions
  // need `caption.min`, accents and the big word (large text) `large.min`.
  // Below it a text moves to a free place within `moveRadius` (a grid every
  // `moveStep` pixels) in the same zone, else stays where it is, plain: never
  // a shadow, never a colour change (owner decision 2026-11-04).
  // `shadows` are legacy, for versions saved before then only: their stored
  // `shadow` level (1 soft, 2 strong) renders with them, `dark` under a light
  // text, `light` under a dark one. No new version uses them.
  readability: {
    caption: { min: number };
    large: { min: number };
    moveRadius: number;
    moveStep: number;
    shadows: { dark: [string, string]; light: [string, string] };
  };
  // Spots beside the head (build.py's `_slots`).
  slots: { firstRow: number; rowGap: number; rightDrop: number; minLeft: number; minRight: number };
  // The background style role: the colour of every transition layer.
  background: string;
  transitions: Record<TransitionType, PresetTransition>;
  // Transition timing: the layer's entrance finishes as its phrase's first
  // word starts; it has left when the next word starts, holding at most
  // `holdSeconds` after the phrase (`longHoldSeconds` when asked), never
  // shorter than `minSeconds`. `slowFactor` stretches the motion when asked
  // slower; `gap` pixels between stacked text levels. How often one comes is
  // the pace's.
  transition: {
    minSeconds: number;
    holdSeconds: number;
    longHoldSeconds: number;
    slowFactor: number;
    gap: number;
  };
  // How busy the reel is: one intensity level (Medium, the only one so far).
  // A later level (Calm, Intense) swaps this block whole.
  pace: PresetPace;
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

// The `rethink-work` style's own box, before the platform guard cuts it. With
// the 2026-11-03 zone it lies wholly inside `PLATFORM_SAFE` and clear of
// `PLATFORM_BUTTONS`, so the preset's safe box is this box.
const STYLE_SAFE: Box = { left: 130, right: 860, top: 260, bottom: 1400 };

// The issebya style: the values of the approved `rethink-work` reel.
export const ISSEBYA_PRESET: Preset = {
  id: "issebya",
  placement: "all",
  frame: { width: 1080, height: 1920 },
  safe: intersectBox(STYLE_SAFE, PLATFORM_SAFE),
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
  layout: { minScale: 0.6, gap: 12 },
  readability: {
    caption: { min: 4.5 },
    large: { min: 3 },
    moveRadius: 300,
    moveStep: 60,
    shadows: {
      dark: [
        "0 2px 8px rgba(0, 0, 0, 0.55)",
        "0 2px 6px rgba(0, 0, 0, 0.8), 0 0 18px rgba(0, 0, 0, 0.6)",
      ],
      light: [
        "0 2px 8px rgba(255, 255, 255, 0.55)",
        "0 2px 6px rgba(255, 255, 255, 0.8), 0 0 18px rgba(255, 255, 255, 0.6)",
      ],
    },
  },
  slots: { firstRow: 610, rowGap: 85, rightDrop: 42, minLeft: 110, minRight: 90 },
  background: "#121212",
  // Starting values; the owner tunes them by eye on a real reel.
  transitions: {
    dim: {
      layer: FRAME,
      shade: 0.62,
      motion: "fade",
      seconds: 0.3,
      ease: "power2.out",
      area: STYLE_SAFE,
      want: 1180,
      description: "darkens the whole picture: for a turn in the story or a strong statement",
      text: { left: 130, right: 860, top: 1180, bottom: 1400 },
    },
    panel: {
      layer: { left: 0, right: 1080, top: 1150, bottom: 1920 },
      shade: 1,
      motion: "slide",
      seconds: 0.5,
      ease: "power3.inOut",
      area: { left: 130, right: 860, top: 1170, bottom: 1400 },
      want: 1180,
      description:
        "a dark panel slides up over the lower part: for an aside, a definition or a short explanation",
      text: { left: 130, right: 860, top: 1200, bottom: 1400 },
    },
    numbered: {
      layer: FRAME,
      shade: 0.38,
      motion: "fade",
      seconds: 0.3,
      ease: "power2.out",
      area: STYLE_SAFE,
      want: 640,
      description:
        "a large number over a light dim with the phrase below: for each item of a list the speaker goes through, numbered in order",
      numberSize: 300,
      text: STYLE_SAFE,
    },
    // Kept only for versions saved with it; never offered.
    card: {
      layer: FRAME,
      shade: 0.9,
      motion: "fade",
      seconds: 0.25,
      ease: "power2.out",
      area: { left: 130, right: 860, top: 640, bottom: 1400 },
      want: 640,
      text: { left: 130, right: 860, top: 640, bottom: 1400 },
    },
  },
  transition: {
    minSeconds: 1.5,
    holdSeconds: 1,
    longHoldSeconds: 2,
    slowFactor: 1.6,
    gap: 24,
  },
  // Medium: something new about every 3 s, a transition about every 9 s, a
  // written hook from 0.2 s (the accent's lead) to 3 s, the first seconds
  // that decide whether people keep watching.
  pace: {
    extraEverySeconds: 3,
    transitionEverySeconds: 9,
    hook: { fromSeconds: 0.2, untilSeconds: 3, maxWords: 7, maxCharacters: 45 },
  },
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
    spots: {
      top: { left: 90, right: 990, top: 160, bottom: 760 },
      left: { left: 40, right: 500, top: 560, bottom: 1180 },
      right: { left: 580, right: 1040, top: 560, bottom: 1180 },
    },
    word: {
      font: "primary",
      maxSize: 400,
      margin: 40,
      color: "#FFFFFF",
      belowHeadTop: 60,
      noHeadY: 700,
      minVisible: 0.7,
    },
    padFrames: 3,
    frameRate: 30,
    minSeconds: 1,
    maxSeconds: 2,
    maxFaceShare: 0.4,
    photo: {
      minVisible: 0.7,
      minContrast: 1.5,
      ring: 30,
    },
    card: {
      widthShare: 1 / 3,
      aspect: 4 / 5,
      smaller: 0.7,
      inset: 40,
      stroke: 8,
      ring: 60,
      spots: CARD_SPOTS,
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

// The strict layout (`placement: "clean"`): the issebya preset with the
// engine's drops, retimes and no overlaps. Tests and goldens that assert those
// use it; the worker places with `ISSEBYA_PRESET`.
export const CLEAN_PRESET: Preset = { ...ISSEBYA_PRESET, placement: "clean" };

// A spoken word as a caption shows it (build.py's `clean`): surrounding
// spaces and punctuation stripped, lower-case except the preset's kept words.
export function cleanWord(text: string, preset: Preset): string {
  const lower = text
    .trim()
    .replace(/^[\s,.?!:;"]+|[\s,.?!:;"]+$/g, "")
    .toLowerCase();
  return preset.keepCaps[lower] ?? lower;
}
