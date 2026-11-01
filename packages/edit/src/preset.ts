// A style preset: everything an edit item does not set itself. Plain data, so
// the same preset gives the same page in the browser and in Node.

export interface PresetFont {
  family: string;
  // Relative to the package's `assets/` folder.
  file: string;
  weight: number;
  size: number;
}

export interface PresetSound {
  file: string;
  gainDb: number;
  // Seconds: the clip's length on the timeline.
  duration: number;
}

export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface Preset {
  name: string;
  frame: { width: number; height: number };
  // Text stays inside it.
  safe: Box;
  fonts: Record<string, PresetFont>;
  colors: Record<string, string>;
  shadow: boolean;
  caption: {
    font: string;
    color: string;
    // Rows beside the head, this many pixels apart.
    lineGap: number;
    // Rows never start above this y.
    minRowTop: number;
    faceMargin: { left: number; right: number };
    // The face box's height as a multiple of the head's width.
    faceHeightRatio: number;
    // The one centred line used when there is no head.
    lowLineTop: number;
    // Seconds: fade-in length, its rise in pixels, fade-out length, and the
    // shortest time a caption stays fully on screen.
    appear: number;
    rise: number;
    fade: number;
    minOnScreen: number;
  };
  accent: { font: string; color: string; aboveHead: number };
  sounds: Record<string, PresetSound>;
  // Seconds between two sound hits, at least.
  minSoundGap: number;
  // Full-screen text moments (T1, T2, T3 of the reference reel) and where
  // their text sits.
  transitions: string[];
  transitionText: { font: string; color: string; top: Record<string, number> };
  // Words shown as written here, whatever their case in the transcript.
  keepCaps: Record<string, string>;
  // A term the transcript hears as another word, shown as one word.
  glossary: { term: string; heard: string[] }[];
  // Seconds of footage after the last word when no footage item sets the end.
  tail: number;
  gsap: string;
}

// The issebya style, from the reference reel's build (`rethink-work/build.py`).
export const ISSEBYA: Preset = {
  name: "issebya",
  frame: { width: 1080, height: 1920 },
  safe: { left: 130, right: 860, top: 260, bottom: 1400 },
  fonts: {
    primary: { family: "Raleway Light", file: "fonts/Raleway-Light.ttf", weight: 300, size: 110 },
    secondary: { family: "Golos Text", file: "fonts/GolosText-Bold.ttf", weight: 700, size: 50 },
  },
  colors: { text: "#FFFFFF", accent: "#B3E6FF" },
  shadow: false,
  caption: {
    font: "secondary",
    color: "text",
    lineGap: 85,
    minRowTop: 610,
    faceMargin: { left: 35, right: 30 },
    faceHeightRatio: 1.35,
    lowLineTop: 1290,
    appear: 0.18,
    rise: 12,
    fade: 0.15,
    minOnScreen: 0.25,
  },
  accent: { font: "primary", color: "accent", aboveHead: 190 },
  sounds: {
    click: { file: "sounds/mouse-click-trimmed.wav", gainDb: -13, duration: 0.23 },
  },
  minSoundGap: 0.25,
  transitions: ["dim", "panel", "card"],
  transitionText: {
    font: "primary",
    color: "accent",
    top: { dim: 1120, panel: 1225, card: 640 },
  },
  keepCaps: { i: "I", ai: "AI", gen: "Gen", z: "Z" },
  glossary: [{ term: "lock-in", heard: ["locking"] }],
  tail: 0.5,
  gsap: "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js",
};
