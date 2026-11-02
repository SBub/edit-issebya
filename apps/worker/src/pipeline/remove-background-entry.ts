// The remove_background step's own entry, run by the worker's Node. The pinned
// HyperFrames CLI (0.8.222) prints no progress when nobody watches: with
// `--json` its spinner is off, and without it the unattended spinner drops
// every message. The per-frame events exist only through `onProgress` of the
// package's public `hyperframes/api` export. So this entry calls that same
// `removeBackground` with exactly the options the CLI passes (input, output,
// device, quality), prints one `@hf-progress {"index","total","pct"}` line per
// frame (pct as the CLI's own spinner computes it) and, at the end, the same
// JSON result document the CLI prints under `--json`. Same function, same
// options, same model: the output is the CLI's, so the step's version,
// settings and fingerprints stay as they are.
//
// Arguments: <input> -o <output> --device <device> --quality <quality>
import { removeBackground } from "hyperframes/api";
import type { RemoveBackgroundDevice, RemoveBackgroundQuality } from "hyperframes/api";

function parseArgs(argv: string[]): {
  input: string;
  output: string;
  device: RemoveBackgroundDevice;
  quality: RemoveBackgroundQuality;
} {
  const [input, ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const name = rest[i];
    const value = rest[i + 1];
    if (name === undefined || value === undefined) throw new Error(`missing value for ${name}`);
    flags.set(name, value);
  }
  const output = flags.get("-o");
  if (!input || !output) {
    throw new Error(
      "usage: remove-background-entry <input> -o <output> --device <d> --quality <q>",
    );
  }
  return {
    input,
    output,
    device: (flags.get("--device") ?? "auto") as RemoveBackgroundDevice,
    quality: (flags.get("--quality") ?? "balanced") as RemoveBackgroundQuality,
  };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const result = await removeBackground({
    ...options,
    onProgress(event) {
      if (event.kind !== "frame" || !event.total) return;
      const pct = Math.floor((100 * event.index) / event.total);
      console.log(
        `@hf-progress ${JSON.stringify({ index: event.index, total: event.total, pct })}`,
      );
    },
  });
  console.log(
    JSON.stringify({
      ok: true,
      outputPath: result.outputPath,
      framesProcessed: result.framesProcessed,
      durationSeconds: Number(result.durationSeconds.toFixed(2)),
      avgMsPerFrame: Number(result.avgMsPerFrame.toFixed(1)),
      provider: result.provider,
      format: result.format,
    }),
  );
  // No process.exit: exiting with onnxruntime's threads still up aborts the
  // process (`mutex lock failed`); the CLI, too, lets the event loop drain.
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ ok: false, error: { code: "runtime_error", message } }));
  console.error(error);
  process.exitCode = 1;
}
