export const RETIME_VERSION = 1;

// Every retime setting in one object; each value is part of the fingerprint
// (app_docs/pipeline.md describes each one).
export interface RetimeSettings {
  baseSpeed: number;
  slowSpeed: number;
  slowWordsPerSecond: number;
  drawnOutWordSeconds: number;
  longPauseSeconds: number;
  phraseGapSeconds: number;
  minSlowStretchSeconds: number;
  silenceDb: number;
  envelopeFrameSeconds: number;
  minGapAfterSeconds: number;
  gapRate: number;
  // null: no pause is cut.
  maxPauseSeconds: number | null;
  frameRate: number;
  endFadeSeconds: number;
  videoCodec: string;
  preset: string;
  crf: number;
  audioBitrate: string;
}

export const RETIME_PRESET: RetimeSettings = {
  baseSpeed: 1.05,
  slowSpeed: 1.1,
  slowWordsPerSecond: 2.7,
  drawnOutWordSeconds: 0.6,
  longPauseSeconds: 0.3,
  phraseGapSeconds: 0.1,
  minSlowStretchSeconds: 0.8,
  silenceDb: -40,
  envelopeFrameSeconds: 0.01,
  minGapAfterSeconds: 0.065,
  gapRate: 0.6,
  maxPauseSeconds: null,
  frameRate: 30,
  endFadeSeconds: 0.03,
  videoCodec: "libx264",
  preset: "medium",
  crf: 18,
  audioBitrate: "256k",
};
