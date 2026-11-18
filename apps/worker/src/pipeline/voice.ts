import type { Voice } from "@edit-issebya/edit";

// The voice's measure: the RMS level and the sample peak, in dBFS, of every
// 0.1 s of the retimed footage's sound (4800 samples at 48 kHz, all channels
// together). Retime stores it in its transcript, and the sounds mixed over the
// voice take their level from it (`sounds.ts` in packages/edit: the typed
// hook's key sounds). RMS and not LUFS: a key press lasts 70 ms, under the
// shortest LUFS window (400 ms), and both sides of the comparison must be
// measured the same way.
export const VOICE_WINDOW_SECONDS = 0.1;
const RATE = 48000;
const RMS_KEY = "lavfi.astats.Overall.RMS_level";
const PEAK_KEY = "lavfi.astats.Overall.Peak_level";
// What digital silence (-inf) counts as: JSON holds no infinity.
const SILENCE_FLOOR_DB = -120;

const ASTATS_MEASURES = "measure_overall=RMS_level+Peak_level";

const SAFE_FILE = /^[\w./-]+$/;

// ffmpeg prints both values of every window into `printFile`. The name goes
// inside the filter graph unescaped, so it must be a plain path (run with cwd
// set).
export function voiceArgs(input: string, printFile: string): string[] {
  if (!SAFE_FILE.test(printFile)) throw new Error(`voice: unsafe file name ${printFile}`);
  return [
    "-hide_banner",
    "-v",
    "error",
    "-i",
    input,
    "-vn",
    "-af",
    [
      `aresample=${RATE}`,
      `asetnsamples=n=${Math.round(RATE * VOICE_WINDOW_SECONDS)}:p=0`,
      // Both values over all channels together, none per channel.
      ["astats=metadata=1", "reset=1", "measure_perchannel=none", ASTATS_MEASURES].join(":"),
      `ametadata=mode=print:file=${printFile}`,
    ].join(","),
    "-f",
    "null",
    "-",
  ];
}

function values(text: string, key: string): number[] {
  const out: number[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith(`${key}=`)) continue;
    const raw = line.slice(key.length + 1).trim();
    const value = raw === "-inf" ? SILENCE_FLOOR_DB : Number(raw);
    if (!Number.isFinite(value)) throw new Error(`voice: unreadable level ${raw}`);
    out.push(Math.max(value, SILENCE_FLOOR_DB));
  }
  return out;
}

// The measure from ametadata's print file, to a tenth of a dB: a level to the
// nearest tenth, a peak to the tenth above it (a ceiling worked out from a
// stored peak is then never over the real one).
export function parseVoice(text: string): Voice {
  const levels = values(text, RMS_KEY).map((db) => Math.round(db * 10) / 10);
  const peaks = values(text, PEAK_KEY).map((db) => Math.ceil(db * 10 - 1e-9) / 10);
  if (levels.length === 0 || levels.length !== peaks.length) {
    throw new Error(`voice: ${levels.length} levels and ${peaks.length} peaks read`);
  }
  return { windowSeconds: VOICE_WINDOW_SECONDS, levels, peaks };
}
