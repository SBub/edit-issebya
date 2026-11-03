import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The worker's scripted decide answer for the fixture clip (one Claude Code
// result envelope, meaning only): a title phrase, one accent word, one dim
// transition, one fixed word.
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

// A placement wish the owner's request forwards (a photo spot here).
type Wish = "top" | "left" | "right";

// Writes, into `dir`, a script whose one answer makes no choice at all. Version
// 1 has none either (no accents, transitions, photos or fixes), so the AI's
// version 2 has exactly version 1's bytes. Returns its path.
export async function unchangedAnswerScript(dir: string): Promise<string> {
  const envelope = {
    type: "result",
    subtype: "success",
    is_error: false,
    structured_output: {
      accents: [],
      big_word: null,
      photos: [],
      transitions: [],
      word_fixes: [],
      checklist: [],
      behind_rules: KEEP_RULES,
      change_title: "Nothing changed",
      change_summary: "The reel stays as it was.",
      unexpressed: [],
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

// One round of a scripted decide: the photos behind the speaker (none by
// default), the big word (a word id; none by default), the change summary and
// title (the committed answer's when not given) and the behind rules (all
// `keep` by default).
interface AnswerRound {
  photos?: Record<string, unknown>[];
  bigWord?: string;
  changeSummary: string;
  changeTitle?: string;
  rules?: BehindRules;
}

// The committed decide answer with the round's behind choices, summary and rules.
async function roundEnvelope({
  photos = [],
  bigWord,
  changeSummary,
  changeTitle,
  rules = KEEP_RULES,
}: AnswerRound) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed worker script
  const envelope = JSON.parse(await readFile(SHORT_SPEECH_ANSWER, "utf8")) as {
    structured_output: {
      photos: unknown[];
      big_word: { word: string } | null;
      change_title: string;
      change_summary: string;
      behind_rules: BehindRules;
    };
  };
  envelope.structured_output.photos = photos;
  envelope.structured_output.big_word = bigWord ? { word: bigWord } : null;
  envelope.structured_output.change_summary = changeSummary;
  if (changeTitle) envelope.structured_output.change_title = changeTitle;
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

// Writes, into `dir`, a script whose one answer is the committed decide answer
// with nothing behind the speaker and photos switched off for the reel (the
// answer to "no photos in this one"). Returns its path.
export function forbidPhotosAnswerScript(dir: string): Promise<string> {
  return answerRoundsScript(dir, [
    {
      changeSummary: "took the photo out; no photos in this reel",
      rules: { photos: "forbid", big_word: "keep" },
    },
  ]);
}

// One library photo behind the speaker over the fixture clip's one sentence,
// w0001 to w0010 (about 2.6 s), with the owner's wish for its spot when a
// request names one. Without a wish (and without a head in the fixture) the
// layout puts it in the first spot, `top`.
export function behindPhotoItem(photoId: string, wish?: Wish): Record<string, unknown> {
  return { photo_id: photoId, from: "w0001", to: "w0010", ...(wish ? { wish } : {}) };
}

// Writes, into `dir`, a script whose one answer is the committed decide answer
// plus one library photo behind the speaker, wished in `wish` (a change
// request's answer; leave it out for the automatic decide). Returns its path.
export async function behindPhotoAnswerScript(
  dir: string,
  photoId: string,
  wish?: Wish,
): Promise<string> {
  return answerRoundsScript(dir, [
    {
      photos: [behindPhotoItem(photoId, wish)],
      changeSummary: `put the photo behind me${wish ? ` on the ${wish}` : ""}`,
    },
  ]);
}

// Writes, into `dir`, a script whose one answer is the committed decide answer
// plus the big word `word` (a word id) behind the speaker, shown from that word
// to the end of its sentence. Returns its path.
export async function behindWordAnswerScript(dir: string, word: string): Promise<string> {
  return answerRoundsScript(dir, [{ bigWord: word, changeSummary: "put the big word behind me" }]);
}
