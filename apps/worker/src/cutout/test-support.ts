// Test helper for the cut-out tests: the behind fixture version of
// packages/edit and a spawnTool double that writes each call's output.
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  type Edit,
  ISSEBYA_PRESET,
  headTrackSchema,
  parseEdit,
  transcriptSchema,
} from "@edit-issebya/edit";
import type { ToolCall } from "../step-runner.ts";
import type { SpawnTool } from "../step-runner.ts";

const TESTDATA = new URL("../../../../packages/edit/src/testdata/", import.meta.url);

const readJson = (path: string): unknown =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed fixtures
  JSON.parse(readFileSync(new URL(path, TESTDATA), "utf8"));

export const BEHIND_TRANSCRIPT = transcriptSchema.parse(readJson("rethink-work/transcript.json"));
// The same clip's head track: over the fixture's two spans the crops are 266
// and 350 (the highest person tops 460 and 528, the widest heads 388 and 356).
export const BEHIND_HEAD_TRACK = headTrackSchema.parse(readJson("rethink-work/head-track.json"));

// The fixture with two big words over two spans, its masks removed (what a new
// answer looks like before the cut-out step). Its VISUAL is made a big word
// over the same span: a VISUAL needs no mask, and the cases here need two.
export function behindEdit(): Edit {
  const parsed = parseEdit(
    readJson("versions/rethink-work-behind.edit.json"),
    ISSEBYA_PRESET,
    BEHIND_TRANSCRIPT,
  );
  if (!parsed.ok) throw new Error(parsed.reasons.join("; "));
  const inputs = { ...parsed.edit.inputs };
  delete inputs.masks;
  const behind = (parsed.edit.tracks.behind ?? []).map((item) =>
    item.kind === "visual"
      ? {
          id: "behind-word-2",
          kind: "word" as const,
          text: "WORK",
          start: item.start,
          end: item.end,
        }
      : item,
  );
  return { ...parsed.edit, tracks: { ...parsed.edit.tracks, behind }, inputs };
}

// Every tool call it gets, and a run that writes `mask <n>` to the file after
// `--output` (the MODNet entry) or the last argument (ffmpeg), exit 0.
export function fakeMaskSpawn(): { spawnTool: SpawnTool; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const spawnTool: SpawnTool = async (call) => {
    calls.push(call);
    const at = call.args.indexOf("--output");
    const output = at >= 0 ? call.args[at + 1]! : call.args.at(-1)!;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the test's temp folder
    await writeFile(output, `mask ${calls.length}`);
    return { code: 0, exitSignal: null, report: "", output: "", stdout: "", groupPeakBytes: null };
  };
  return { spawnTool, calls };
}
