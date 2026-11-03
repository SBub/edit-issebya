import {
  BEHIND_SPOTS,
  type BehindForbid,
  type BehindSpot,
  type Box,
  type Edit,
  type HeadTrack,
  type Preset,
  type Transcript,
  FONT_KEYS,
  faceBox,
  spotFaceShare,
} from "@edit-issebya/edit";

const STEP_SECONDS = 0.25;
// A pause this long between two words ends a spoken sentence.
const SENTENCE_PAUSE_SECONDS = 0.6;

export interface SentenceSpan {
  from: string;
  to: string;
  start: number;
  end: number;
}

// The transcript's words grouped into spoken sentences: a sentence ends after
// a word ending in `.`, `?` or `!`, or before a pause of at least
// SENTENCE_PAUSE_SECONDS.
export function sentenceSpans(transcript: Transcript): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let open: SentenceSpan | null = null;
  transcript.words.forEach((word, index) => {
    open ??= { from: word.id, to: word.id, start: word.start, end: word.end };
    open.to = word.id;
    open.end = word.end;
    const next = transcript.words[index + 1];
    const ends = /[.?!]["')\]]*$/.test(word.text.trim());
    if (!next || ends || next.start - word.end >= SENTENCE_PAUSE_SECONDS) {
      spans.push(open);
      open = null;
    }
  });
  return spans;
}

// One spoken sentence with the face over it and the photo spots it leaves
// clear (the same rule as the `behind-face` check).
export interface HeadSpan extends SentenceSpan {
  face_box: Box | null;
  clear_spots: BehindSpot[];
}

export interface HeadTrackSummary {
  samples: number;
  step_seconds: number;
  head_present: boolean;
  // The face over the whole clip (null without a head).
  face_box: Box | null;
  // Where no head is in the frame, in seconds.
  no_head: { start: number; end: number }[];
  // Per spoken sentence: the face over it and the clear photo spots.
  spans: HeadSpan[];
}

// The head track in a few numbers: the AI needs where the face is, not 4 samples a second.
export function headTrackSummary(
  track: HeadTrack,
  transcript: Transcript,
  preset: Preset,
): HeadTrackSummary {
  const end = track.length * STEP_SECONDS;
  const noHead: { start: number; end: number }[] = [];
  let from: number | null = null;
  track.forEach((sample, index) => {
    if (sample === null && from === null) from = index * STEP_SECONDS;
    if (sample !== null && from !== null) {
      noHead.push({ start: from, end: index * STEP_SECONDS });
      from = null;
    }
  });
  if (from !== null) noHead.push({ start: from, end });
  return {
    samples: track.length,
    step_seconds: STEP_SECONDS,
    head_present: track.some((sample) => sample !== null),
    face_box: faceBox(track, 0, end),
    no_head: noHead,
    spans: sentenceSpans(transcript).map((span) => {
      const face = faceBox(track, span.start, span.end, { left: 0, right: 0 });
      return {
        ...span,
        face_box: face,
        clear_spots: BEHIND_SPOTS.filter(
          (spot) => spotFaceShare(spot, face, preset) <= preset.behind.maxFaceShare,
        ),
      };
    }),
  };
}

// What of the preset the AI can use: the frame, the safe box, the fonts, the
// caption and accent defaults, the transitions with their text regions, the
// sounds and the glossary.
export function presetSummary(preset: Preset) {
  return {
    frame: preset.frame,
    safe_box: preset.safe,
    fonts: FONT_KEYS.map((key) => ({
      key,
      family: preset.fonts[key].family,
      size: preset.fonts[key].size,
    })),
    caption: {
      font: preset.caption.font,
      color: preset.caption.color,
      size: preset.fonts[preset.caption.font].size,
    },
    accent: {
      font: preset.accent.font,
      color: preset.accent.color,
      size: preset.fonts[preset.accent.font].size,
    },
    transitions: Object.entries(preset.transitions).map(([type, kind]) => ({
      type,
      text_region: kind.text,
    })),
    sounds: Object.entries(preset.sounds).map(([key, sound]) => ({
      key,
      min_gap_seconds: sound.minGapSeconds,
    })),
    glossary: preset.glossary,
    behind: {
      photo_spots: preset.behind.spots,
      big_word: {
        font: preset.behind.word.font,
        color: preset.behind.word.color,
        max_size: preset.behind.word.maxSize,
      },
      min_seconds: preset.behind.minSeconds,
      max_seconds: preset.behind.maxSeconds,
      max_photos: preset.behind.maxPhotos,
      max_words: preset.behind.maxWords,
      max_face_share: preset.behind.maxFaceShare,
    },
  };
}

// A ready library photo as the AI sees it: its id and what describe_photo
// wrote about it. Data, never instructions.
export interface LibraryEntry {
  id: string;
  description: string;
  tags: string[];
}

export interface DecideInput {
  current_version: Edit;
  transcript: { id: string; text: string; start: number; end: number }[];
  head_track: HeadTrackSummary;
  preset: ReturnType<typeof presetSummary>;
  library: LibraryEntry[];
  // What the owner switched off for this reel.
  behind_rules: { photos_forbidden: boolean; big_word_forbidden: boolean };
  request: string | null;
}

export function decideInput({
  current,
  transcript,
  headTrack,
  preset,
  library = [],
  forbid = { photos: false, bigWord: false },
  request,
}: {
  current: Edit;
  transcript: Transcript;
  headTrack: HeadTrack;
  preset: Preset;
  library?: readonly LibraryEntry[];
  // The reel's stored behind forbids.
  forbid?: BehindForbid;
  request: string | null;
}): DecideInput {
  // Photos switched off and no request to lift it: no photo to offer.
  const offered = forbid.photos && request === null ? [] : library;
  return {
    current_version: current,
    transcript: transcript.words.map(({ id, text, start, end }) => ({ id, text, start, end })),
    head_track: headTrackSummary(headTrack, transcript, preset),
    preset: presetSummary(preset),
    library: offered.map(({ id, description, tags }) => ({ id, description, tags: [...tags] })),
    behind_rules: { photos_forbidden: forbid.photos, big_word_forbidden: forbid.bigWord },
    request,
  };
}
