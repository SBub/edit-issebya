import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "./atomic.ts";
import type { PipelineStep, StepOutput } from "./definition.ts";
import { envelopeArgs, parseEnvelope } from "./envelope.ts";
import { parseProbe, probeArgs } from "./probe.ts";
import { retimeEncodeArgs, retimeFilterGraph } from "./retime-encode.ts";
import { pausesLeft, planRetime, remapTime, retimeTranscript } from "./retime-plan.ts";
import { RETIME_PRESET, RETIME_VERSION, type RetimeSettings } from "./retime-preset.ts";
import { missedSpeech } from "./speech-gaps.ts";
import { type Transcript, parseTranscript } from "./transcript.ts";
import { parseVoice, voiceArgs } from "./voice.ts";

// The retimed footage is heavy and rebuilt from the kept upload; the small
// JSON files stay.
const OUTPUTS: readonly StepOutput[] = [
  { file: "source.mp4", retention: "rebuildable" },
  { file: "transcript.json", retention: "kept" },
  { file: "retime.json", retention: "kept" },
  { file: "envelope.json", retention: "kept" },
];
const ENVELOPE_PRINT = "envelope.txt";
const VOICE_PRINT = "voice.txt";
const GRAPH = "retime-graph.txt";
const PARTIAL = "source.part.mp4";

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 1)}\n`;
}

// The transcript as stored: a word a block, the voice's two lists a line each.
export function transcriptJson(transcript: Transcript): string {
  const { voice, ...rest } = transcript;
  const words = JSON.stringify(rest, null, 2);
  if (!voice) return `${words}\n`;
  const lines = [
    `    "windowSeconds": ${voice.windowSeconds},`,
    `    "levels": ${JSON.stringify(voice.levels)},`,
    `    "peaks": ${JSON.stringify(voice.peaks)}`,
  ];
  return `${words.slice(0, -2)},\n  "voice": {\n${lines.join("\n")}\n  }\n}\n`;
}

// The retimed length from `retime.json`: what background removal and the
// render work on.
function retimedSeconds(text: string): number {
  const { durationSeconds } = JSON.parse(text) as { durationSeconds?: unknown };
  if (typeof durationSeconds !== "number" || !(durationSeconds > 0)) {
    throw new Error(`retime.json has no positive durationSeconds: ${String(durationSeconds)}`);
  }
  return durationSeconds;
}

const seconds = (t: number) => t.toFixed(1);

// The step line: the retimed length and speed, then the pauses left, if any
// ("2 pauses over 0.3 s left, 1.4 s in all"), then every possible missed word
// kept, with its retimed time ("1 possible missed word kept (sound at speech
// level in a pause) at 12.3 to 12.8 s").
export function retimeSummary(
  durationSeconds: number,
  left: readonly [number, number][],
  missed: readonly [number, number][],
  settings: RetimeSettings,
): string {
  const parts = [`retimed to ${seconds(durationSeconds)} seconds, ${settings.baseSpeed}x`];
  if (left.length > 0) {
    const total = left.reduce((sum, [a, b]) => sum + b - a, 0);
    const pauses = left.length === 1 ? "1 pause" : `${left.length} pauses`;
    parts.push(`${pauses} over ${settings.maxPauseSeconds} s left, ${seconds(total)} s in all`);
  }
  if (missed.length > 0) {
    const words =
      missed.length === 1 ? "1 possible missed word" : `${missed.length} possible missed words`;
    const times = missed.map(([a, b]) => `${seconds(a)} to ${seconds(b)} s`).join(", ");
    parts.push(`${words} kept (sound at speech level in a pause) at ${times}`);
  }
  return parts.join(", ");
}

// Probe, envelope, plan (the transcript's gaps are the pauses, the audio only
// holds back a possible missed word), one encode; then the retimed transcript
// (same ids, every time through the plan, and the voice's measure taken on the
// retimed sound: `voice.ts`), the plan and the envelope beside the footage.
// The summary names the pauses still longer than maxPauseSeconds (pausesLeft)
// and every possible missed word kept (missedSpeech). The step's version is
// not raised for the voice's measure (app_docs/pipeline.md says why).
export const retime: PipelineStep<RetimeSettings> = {
  name: "retime",
  version: RETIME_VERSION,
  settings: RETIME_PRESET,
  reelStatus: "retiming",
  outputs: OUTPUTS,
  reusedWhat: "retimed",
  footage: { file: "retime.json", seconds: retimedSeconds },
  inputs: (_source, fingerprints) => [
    {
      ref: { step: "convert", fingerprint: fingerprints.convert!, file: "converted.mp4" },
      as: "converted.mp4",
    },
    {
      ref: { step: "transcribe", fingerprint: fingerprints.transcribe!, file: "transcript.json" },
      as: "transcript.json",
    },
  ],
  async run({ tool, tools, dir, files, settings }) {
    const footage = files["converted.mp4"]!;
    const probe = parseProbe(await tool({ file: tools.ffprobe, args: probeArgs(footage) }));
    if (!probe.audio) throw new Error("retime: the footage has no audio");
    await tool({
      file: tools.ffmpeg,
      args: envelopeArgs(footage, ENVELOPE_PRINT),
      cwd: dir,
      ignoreStdout: true,
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    const envelope = parseEnvelope(await readFile(join(dir, ENVELOPE_PRINT), "utf8"));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    const transcript = parseTranscript(await readFile(files["transcript.json"]!, "utf8"));
    const clip = {
      words: transcript.words,
      envelope,
      durationSeconds: probe.durationSeconds,
      settings,
    };
    const plan = planRetime(clip);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    await writeFile(join(dir, GRAPH), retimeFilterGraph(plan, probe.audio.sampleRate, settings));
    const partial = join(dir, PARTIAL);
    await tool({
      file: tools.ffmpeg,
      args: retimeEncodeArgs(footage, GRAPH, partial, settings),
      cwd: dir,
      ignoreStdout: true,
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    await rename(partial, join(dir, "source.mp4"));

    // The voice as the reel plays it (sped up, the joins faded, through the
    // AAC encoder): a sound-only pass over the file just written.
    await tool({
      file: tools.ffmpeg,
      args: voiceArgs(join(dir, "source.mp4"), VOICE_PRINT),
      cwd: dir,
      ignoreStdout: true,
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    const voice = parseVoice(await readFile(join(dir, VOICE_PRINT), "utf8"));

    const retimed = { ...retimeTranscript({ transcript, plan }), voice };
    await writeAtomic(join(dir, "transcript.json"), transcriptJson(retimed));
    await writeAtomic(join(dir, "retime.json"), json(plan));
    await writeAtomic(join(dir, "envelope.json"), `${JSON.stringify(envelope)}\n`);
    const missed = missedSpeech(clip).map(([a, b]): [number, number] => [
      remapTime(plan, a),
      remapTime(plan, b),
    ]);
    return {
      what: retimeSummary(plan.durationSeconds, pausesLeft({ plan, ...clip }), missed, settings),
    };
  },
};
