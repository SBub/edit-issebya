import {
  type Box,
  type Edit,
  type HeadTrack,
  type Preset,
  type Transcript,
  FONT_KEYS,
  faceBox,
} from "@edit-issebya/edit";

const STEP_SECONDS = 0.25;

export interface HeadTrackSummary {
  samples: number;
  step_seconds: number;
  head_present: boolean;
  // The face over the whole clip (null without a head).
  face_box: Box | null;
  // Where no head is in the frame, in seconds.
  no_head: { start: number; end: number }[];
}

// The head track in a few numbers: the AI needs where the face is, not 4 samples a second.
export function headTrackSummary(track: HeadTrack): HeadTrackSummary {
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
      hides_cutout: kind.hidesCutout,
    })),
    sounds: Object.entries(preset.sounds).map(([key, sound]) => ({
      key,
      min_gap_seconds: sound.minGapSeconds,
    })),
    glossary: preset.glossary,
  };
}

export interface DecideInput {
  current_version: Edit;
  transcript: { id: string; text: string; start: number; end: number }[];
  head_track: HeadTrackSummary;
  preset: ReturnType<typeof presetSummary>;
  request: string | null;
}

export function decideInput({
  current,
  transcript,
  headTrack,
  preset,
  request,
}: {
  current: Edit;
  transcript: Transcript;
  headTrack: HeadTrack;
  preset: Preset;
  request: string | null;
}): DecideInput {
  return {
    current_version: current,
    transcript: transcript.words.map(({ id, text, start, end }) => ({ id, text, start, end })),
    head_track: headTrackSummary(headTrack),
    preset: presetSummary(preset),
    request,
  };
}
