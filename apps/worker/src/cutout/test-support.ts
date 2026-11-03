// Test helper for the cut-out tests: the behind fixture version of
// packages/edit and a spawnTool double that writes each call's output.
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { type Edit, ISSEBYA_PRESET, parseEdit, transcriptSchema } from "@edit-issebya/edit";
import type { ToolCall } from "../step-runner.ts";
import type { SpawnTool } from "../step-runner.ts";

const TESTDATA = new URL("../../../../packages/edit/src/testdata/", import.meta.url);

const readJson = (path: string): unknown =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed fixtures
  JSON.parse(readFileSync(new URL(path, TESTDATA), "utf8"));

export const BEHIND_TRANSCRIPT = transcriptSchema.parse(readJson("rethink-work/transcript.json"));
export const BEHIND_PHOTO = "3f6c1a52-8e4d-4b7a-9c21-5d0e8f7b6a14";

// The fixture with one right photo and one big word, its masks and photos
// removed (what a new answer looks like before the cut-out step).
export function behindEdit(): Edit {
  const parsed = parseEdit(
    readJson("versions/rethink-work-behind.edit.json"),
    ISSEBYA_PRESET,
    BEHIND_TRANSCRIPT,
  );
  if (!parsed.ok) throw new Error(parsed.reasons.join("; "));
  const inputs = { ...parsed.edit.inputs };
  delete inputs.masks;
  delete inputs.photos;
  return { ...parsed.edit, inputs };
}

// Every tool call it gets, and a run that writes `mask <n>` to the file after
// `--output` (vseg) or the last argument (ffmpeg), exit 0.
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
