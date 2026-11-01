import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeAtomic } from "./atomic.ts";
import type { PipelineStep } from "./definition.ts";
import { envelopeArgs, parseEnvelope } from "./envelope.ts";
import { parseProbe, probeArgs } from "./probe.ts";
import { retimeEncodeArgs, retimeFilterGraph } from "./retime-encode.ts";
import { planRetime, remapTime } from "./retime-plan.ts";
import { RETIME_PRESET, RETIME_VERSION, type RetimeSettings } from "./retime-preset.ts";
import { parseTranscript, remapTranscript } from "./transcript.ts";

const OUTPUTS = ["source.mp4", "transcript.json", "retime.json", "envelope.json"].map((file) => ({
  file,
  keep: "kept" as const,
}));
const ENVELOPE_PRINT = "envelope.txt";
const GRAPH = "retime-graph.txt";
const PARTIAL = "source.part.mp4";

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 1)}\n`;
}

// Probe, envelope, plan, one encode; then the retimed transcript (same ids),
// the plan and the envelope beside the footage.
export const retime: PipelineStep<RetimeSettings> = {
  name: "retime",
  version: RETIME_VERSION,
  settings: RETIME_PRESET,
  reelStatus: "retiming",
  outputs: OUTPUTS,
  reusedWhat: "retimed",
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
    await tool({ file: tools.ffmpeg, args: envelopeArgs(footage, ENVELOPE_PRINT), cwd: dir });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    const envelope = parseEnvelope(await readFile(join(dir, ENVELOPE_PRINT), "utf8"));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    const transcript = parseTranscript(await readFile(files["transcript.json"]!, "utf8"));
    const plan = planRetime({
      words: transcript.words,
      envelope,
      durationSeconds: probe.durationSeconds,
      settings,
    });

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    await writeFile(join(dir, GRAPH), retimeFilterGraph(plan, probe.audio.sampleRate, settings));
    const partial = join(dir, PARTIAL);
    await tool({
      file: tools.ffmpeg,
      args: retimeEncodeArgs(footage, GRAPH, partial, settings),
      cwd: dir,
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the job's scratch folder
    await rename(partial, join(dir, "source.mp4"));

    const retimed = remapTranscript(transcript, (t) => remapTime(plan, t));
    await writeAtomic(join(dir, "transcript.json"), `${JSON.stringify(retimed, null, 2)}\n`);
    await writeAtomic(join(dir, "retime.json"), json(plan));
    await writeAtomic(join(dir, "envelope.json"), `${JSON.stringify(envelope)}\n`);
    return {
      what: `retimed to ${plan.durationSeconds.toFixed(1)} seconds, ${settings.baseSpeed}x`,
    };
  },
};
