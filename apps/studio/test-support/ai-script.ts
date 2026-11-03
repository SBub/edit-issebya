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

// What a decide answer does with the reel's behind rules.
interface BehindRules {
  photos: "keep" | "forbid" | "allow";
  big_word: "keep" | "forbid" | "allow";
}

const KEEP_RULES: BehindRules = { photos: "keep", big_word: "keep" };

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
      behind_rules: KEEP_RULES,
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

// One round of a scripted decide: the behind items (none: no behind track),
// the change summary and the behind rules (all `keep` by default).
interface AnswerRound {
  items: Record<string, unknown>[];
  changeSummary: string;
  rules?: BehindRules;
}

// The committed decide answer with the round's behind items, summary and rules.
async function roundEnvelope({ items, changeSummary, rules = KEEP_RULES }: AnswerRound) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed worker script
  const envelope = JSON.parse(await readFile(SHORT_SPEECH_ANSWER, "utf8")) as {
    structured_output: {
      tracks: Record<string, unknown>;
      change_summary: string;
      behind_rules: BehindRules;
    };
  };
  // A transition and a behind item never show together, and the clip's behind
  // items cover the whole clip: the round drops the committed transition.
  if (items.length > 0) {
    envelope.structured_output.tracks.behind = items;
    envelope.structured_output.tracks.transitions = [];
  }
  envelope.structured_output.change_summary = changeSummary;
  envelope.structured_output.behind_rules = rules;
  return envelope;
}

// Writes, into `dir`, a script of one envelope per round, replayed in order
// (the last repeating), for a first answer the decide step refuses and a
// retry that passes. Returns its path.
export async function answerRoundsScript(
  dir: string,
  rounds: readonly AnswerRound[],
): Promise<string> {
  const envelopes = await Promise.all(rounds.map(roundEnvelope));
  const path = join(dir, `answer-rounds-${crypto.randomUUID()}.json`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file in the caller's temp folder
  await writeFile(path, JSON.stringify(envelopes));
  return path;
}

// The change summary of the scripted answer to "make the transitions slower".
export const SLOWER_TRANSITIONS_SUMMARY =
  "made the transitions slower (0.6 s motion), for this reel only";

// Writes, into `dir`, a script whose one answer is the committed decide answer
// with its dim's motion raised to 0.6 s (the answer to "make the transitions
// slower"). Returns its path.
export async function slowerTransitionsAnswerScript(dir: string): Promise<string> {
  const envelope = await roundEnvelope({ items: [], changeSummary: SLOWER_TRANSITIONS_SUMMARY });
  const transitions = envelope.structured_output.tracks.transitions as Record<string, unknown>[];
  for (const transition of transitions) transition.motion_seconds = 0.6;
  const path = join(dir, `slower-transitions-${crypto.randomUUID()}.json`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file in the caller's temp folder
  await writeFile(path, JSON.stringify([envelope]));
  return path;
}

// Writes, into `dir`, a script whose one answer is the committed decide answer
// with `item` as the only behind-the-speaker item. Returns its path.
function writeBehindAnswer(
  dir: string,
  item: Record<string, unknown>,
  changeSummary: string,
  rules?: BehindRules,
): Promise<string> {
  return answerRoundsScript(dir, [{ items: [item], changeSummary, rules }]);
}

// Writes, into `dir`, a script whose one answer is the committed decide answer
// with nothing behind the speaker and photos switched off for the reel (the
// answer to "no photos in this one"). Returns its path.
export function forbidPhotosAnswerScript(dir: string): Promise<string> {
  return answerRoundsScript(dir, [
    {
      items: [],
      changeSummary: "took the photo out; no photos in this reel",
      rules: { photos: "forbid", big_word: "keep" },
    },
  ]);
}

// One library photo behind the speaker in `spot`, from the start of w0001 to
// the end of w0010 (about 2.6 s of the fixture clip).
export function behindPhotoItem(
  photoId: string,
  spot: "top" | "left" | "right",
  style?: Record<string, string>,
): Record<string, unknown> {
  return {
    id: "behind-photo",
    kind: "photo",
    photo_id: photoId,
    spot,
    start: { word: "w0001" },
    end: { word: "w0010", edge: "end" },
    ...(style ? { style } : {}),
  };
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
  return writeBehindAnswer(
    dir,
    behindPhotoItem(photoId, spot, style),
    `put the photo behind me on the ${spot}`,
  );
}

// Writes, into `dir`, a script whose one answer is the committed decide answer
// plus one big word behind the speaker over w0001 to the end of w0010 (about
// 2.6 s), the photo's span, since the clip is too short for two 2 to 4 s items
// in one version. Returns its path.
export async function behindWordAnswerScript(dir: string, text: string): Promise<string> {
  return writeBehindAnswer(
    dir,
    {
      id: "behind-word",
      kind: "word",
      text,
      start: { word: "w0001" },
      end: { word: "w0010", edge: "end" },
    },
    `put the word ${text} behind me`,
  );
}
