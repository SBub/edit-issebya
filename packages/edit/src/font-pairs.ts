// The font pairs (`app_docs/font-pairs.md`): two fonts a reel is set in. The
// simple font writes every caption, big word, hook, question and list (it is
// always readable); the artistic font writes the accents only. Each face is a
// static instance of an OFL Google Font, so HarfBuzz measures the very file the
// page loads (no variable axes). The files live in `assets/fonts`, relative to
// packages/edit, as the built page names them.

// The two roles a text style takes its font from (`variants.ts`, STYLES).
export const FONT_ROLES = ["simple", "artistic"] as const;
export type FontRole = (typeof FONT_ROLES)[number];

export interface PresetFont {
  // The CSS family the page names the face by (the font's own full name).
  family: string;
  // Relative to packages/edit (and to the built page): `assets/fonts/...`.
  file: string;
  weight: number;
  style: "normal" | "italic";
}

export const FONT_PAIR_IDS = [
  "classic",
  "script",
  "signature",
  "handwritten",
  "retro",
  "bold",
] as const;
export type FontPairId = (typeof FONT_PAIR_IDS)[number];

export interface FontPair {
  id: FontPairId;
  label: string;
  // What the pair looks like, in the owner's words, for the picker's caption.
  standsInFor: string;
  simple: PresetFont;
  artistic: PresetFont;
}

// The six pairs the owner approved. `classic` is the default.
export const FONT_PAIRS: Record<FontPairId, FontPair> = {
  classic: {
    id: "classic",
    label: "Classic",
    standsInFor: "Helvetica + PlayFair",
    simple: {
      family: "Inter Tight SemiBold",
      file: "assets/fonts/InterTight-SemiBold.ttf",
      weight: 600,
      style: "normal",
    },
    artistic: {
      family: "Playfair Display Italic",
      file: "assets/fonts/PlayfairDisplay-Italic.ttf",
      weight: 400,
      style: "italic",
    },
  },
  script: {
    id: "script",
    label: "Script",
    standsInFor: "Inter + Bikham",
    simple: {
      family: "Inter SemiBold",
      file: "assets/fonts/Inter-SemiBold.ttf",
      weight: 600,
      style: "normal",
    },
    artistic: {
      family: "Pinyon Script",
      file: "assets/fonts/PinyonScript-Regular.ttf",
      weight: 400,
      style: "normal",
    },
  },
  signature: {
    id: "signature",
    label: "Signature",
    standsInFor: "Bebas Neue + Bella Script",
    simple: {
      family: "Oswald Medium",
      file: "assets/fonts/Oswald-Medium.ttf",
      weight: 500,
      style: "normal",
    },
    artistic: {
      family: "Hurricane",
      file: "assets/fonts/Hurricane-Regular.ttf",
      weight: 400,
      style: "normal",
    },
  },
  handwritten: {
    id: "handwritten",
    label: "Handwritten",
    standsInFor: "Heading Now + Denistina",
    simple: {
      family: "Antonio Bold",
      file: "assets/fonts/Antonio-Bold.ttf",
      weight: 700,
      style: "normal",
    },
    artistic: {
      family: "Herr Von Muellerhoff",
      file: "assets/fonts/HerrVonMuellerhoff-Regular.ttf",
      weight: 400,
      style: "normal",
    },
  },
  retro: {
    id: "retro",
    label: "Retro",
    standsInFor: "Old Soviet + Neue Machina",
    simple: {
      family: "Unbounded",
      file: "assets/fonts/Unbounded-Regular.ttf",
      weight: 400,
      style: "normal",
    },
    artistic: {
      family: "Syne SemiBold",
      file: "assets/fonts/Syne-SemiBold.ttf",
      weight: 600,
      style: "normal",
    },
  },
  bold: {
    id: "bold",
    label: "Bold",
    standsInFor: "Druk + Notepad",
    simple: {
      family: "Archivo Expanded Black",
      file: "assets/fonts/Archivo-ExpandedBlack.ttf",
      weight: 900,
      style: "normal",
    },
    artistic: {
      family: "Oswald ExtraLight",
      file: "assets/fonts/Oswald-ExtraLight.ttf",
      weight: 200,
      style: "normal",
    },
  },
};

export const DEFAULT_FONT_PAIR_ID: FontPairId = "classic";

export function fontPairOf(id: FontPairId): FontPair {
  return FONT_PAIRS[id];
}

export function isFontPairId(value: unknown): value is FontPairId {
  return typeof value === "string" && (FONT_PAIR_IDS as readonly string[]).includes(value);
}

// Every font file a pair names, each once (both roles may share one), sorted.
export function fontPairFiles(pair: FontPair): string[] {
  return [...new Set(FONT_ROLES.map((role) => pair[role].file))].sort();
}

// Every font file of every pair: what the studio may serve.
export function allFontFiles(): string[] {
  return [...new Set(FONT_PAIR_IDS.flatMap((id) => fontPairFiles(FONT_PAIRS[id])))].sort();
}
