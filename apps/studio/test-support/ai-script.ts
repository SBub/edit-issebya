import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The worker's scripted decide answer for the fixture clip (one Claude Code
// result envelope): a title, one accent, one dim transition, one fixed word.
export const SHORT_SPEECH_ANSWER = fileURLToPath(
  new URL("../../worker/src/decide/testdata/short-speech-answer.json", import.meta.url),
);

// The worker's "not available" fixture: Claude Code reporting its usage limit,
// so the decide step waits for the AI (`the usage limit is reached`).
export const USAGE_LIMIT_SCRIPT = fileURLToPath(
  new URL("../../worker/src/decide/testdata/claude-usage-limit.json", import.meta.url),
);

// The worker's scripted describe_photo answer for fixtures/photos/sample.jpg:
// one sentence and three tags.
export const DESCRIBE_ANSWER = fileURLToPath(
  new URL("../../worker/src/photos/testdata/describe-answer.json", import.meta.url),
);

// The worker's version 1 over fixtures/pipeline/.
const BASELINE = new URL(
  "../../../packages/edit/src/testdata/versions/baseline-short-speech.edit.json",
  import.meta.url,
);

// Writes, into `dir`, a script whose one answer repeats version 1's tracks, so
// the AI's version 2 has exactly version 1's bytes. Returns its path.
export async function unchangedAnswerScript(dir: string): Promise<string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture version
  const baseline = JSON.parse(await readFile(BASELINE, "utf8")) as { tracks: unknown };
  const envelope = {
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: {
      tracks: baseline.tracks,
      change_summary: "kept the first version as it is",
      unexpressed: [],
      free_field: [],
    },
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  const path = join(dir, "unchanged-answer.json");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file in the caller's temp folder
  await writeFile(path, JSON.stringify([envelope]));
  return path;
}

// Writes, into `dir`, a script whose one envelope carries a result that is
// not JSON, replayed for both calls, so the decide step refuses twice. Returns
// its path.
export async function brokenAnswerScript(dir: string): Promise<string> {
  const envelope = {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "not json",
    total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  const path = join(dir, "broken-answer.json");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file in the caller's temp folder
  await writeFile(path, JSON.stringify(envelope));
  return path;
}

// Writes, into `dir`, a script whose one answer is the committed decide answer
// plus one library photo behind the speaker in `spot`, from the start of
// w0001 to the end of w0010 (about 2.6 s of the fixture clip), with an
// optional free style (a probe moving it). Returns its path.
export async function behindPhotoAnswerScript(
  dir: string,
  photoId: string,
  spot: "top" | "left" | "right",
  style?: Record<string, string>,
): Promise<string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed worker script
  const envelope = JSON.parse(await readFile(SHORT_SPEECH_ANSWER, "utf8")) as {
    structured_output: { tracks: Record<string, unknown>; change_summary: string };
  };
  envelope.structured_output.tracks.behind = [
    {
      id: "behind-photo",
      kind: "photo",
      photo_id: photoId,
      spot,
      start: { word: "w0001" },
      end: { word: "w0010", edge: "end" },
      ...(style ? { style } : {}),
    },
  ];
  envelope.structured_output.change_summary = `put the photo behind me on the ${spot}`;
  const path = join(dir, `behind-answer-${crypto.randomUUID()}.json`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file in the caller's temp folder
  await writeFile(path, JSON.stringify([envelope]));
  return path;
}
