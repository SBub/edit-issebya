export const RETIME_VERSION = 6;

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
  // A possible missed word: sound in a transcript gap no more than this many dB
  // under the clip's speech level (the median level inside its words)...
  missedSpeechBelowSpeechDb: number;
  // ...for at least this long without a break. It is kept, never cut.
  missedSpeechSeconds: number;
  envelopeFrameSeconds: number;
  // A pause between words shorter than this once sped up has its middle frame
  // played at gapRate...
  minGapAfterSeconds: number;
  gapRate: number;
  // ...when every 10 ms of that frame is at least this many dB under the
  // clip's speech level. A louder frame keeps its speed: under 1x the pitch
  // drops, and a voice would sound as a short deep blip.
  gapQuietBelowSpeechDb: number;
  // Retimed seconds a pause keeps (its middle is cut); null: no pause is cut.
  maxPauseSeconds: number | null;
  frameRate: number;
  // The sound of every piece fades out over this long before a join and in
  // over this long after it (retime-encode.ts), so a join inside a breath or
  // room sound does not click. The length does not change.
  joinFadeSeconds: number;
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
  missedSpeechBelowSpeechDb: 10,
  missedSpeechSeconds: 0.25,
  envelopeFrameSeconds: 0.01,
  minGapAfterSeconds: 0.065,
  gapRate: 0.6,
  gapQuietBelowSpeechDb: 20,
  maxPauseSeconds: 0.3,
  frameRate: 30,
  joinFadeSeconds: 0.005,
  endFadeSeconds: 0.03,
  videoCodec: "libx264",
  preset: "medium",
  crf: 18,
  audioBitrate: "256k",
};
