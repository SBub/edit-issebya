// The audio envelope: the RMS level in dB of every 10 ms of audio (480
// samples at 48 kHz), the measure the silent gaps are found on.
const RMS_KEY = "lavfi.astats.Overall.RMS_level";
// What digital silence (-inf) counts as.
const SILENCE_FLOOR_DB = -180;

const SAFE_FILE = /^[\w./-]+$/;

// ffmpeg prints one value per frame into `printFile`. The name goes inside the
// filter graph unescaped, so it must be a plain path (run with cwd set).
export function envelopeArgs(input: string, printFile: string): string[] {
  if (!SAFE_FILE.test(printFile)) throw new Error(`envelope: unsafe file name ${printFile}`);
  return [
    "-hide_banner",
    "-v",
    "error",
    "-i",
    input,
    "-vn",
    "-af",
    [
      "aresample=48000",
      "asetnsamples=n=480:p=0",
      "astats=metadata=1:reset=1",
      `ametadata=mode=print:key=${RMS_KEY}:file=${printFile}`,
    ].join(","),
    "-f",
    "null",
    "-",
  ];
}

// The dB values of ametadata's print file, in frame order.
export function parseEnvelope(text: string): number[] {
  const values: number[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith(`${RMS_KEY}=`)) continue;
    const raw = line.slice(RMS_KEY.length + 1).trim();
    const value = raw === "-inf" ? SILENCE_FLOOR_DB : Number(raw);
    if (!Number.isFinite(value)) throw new Error(`envelope: unreadable level ${raw}`);
    values.push(Math.max(value, SILENCE_FLOOR_DB));
  }
  return values;
}

// [start, end] times of every run of frames below the threshold.
export function silentRuns(
  envelope: readonly number[],
  thresholdDb: number,
  frameSeconds: number,
): [number, number][] {
  const runs: [number, number][] = [];
  let start: number | null = null;
  envelope.forEach((db, index) => {
    if (db < thresholdDb) {
      start ??= index;
    } else if (start !== null) {
      runs.push([start * frameSeconds, index * frameSeconds]);
      start = null;
    }
  });
  if (start !== null) runs.push([start * frameSeconds, envelope.length * frameSeconds]);
  return runs;
}
