import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The worker's scripted AI replies for the fixture clip: the written hook
// (role `hook`, "A short test for the real studio") and the decide answer (one
// accent word, one fixed word). On the 2.7 s clip the hook holds the screen
// from 0.2 s to the end, and the accent shows over it (`all` placement: the
// layout engine drops nothing the answer picks).
export const SHORT_SPEECH_ANSWER = fileURLToPath(
  new URL("../../worker/src/decide/testdata/short-speech-answer.json", import.meta.url),
);

// The worker's "not available" script: OpenRouter answering 402 (credits used
// up) to the hook call and to every other call, so the decide step waits for
// the AI (`the OpenRouter credits are used up`).
export const CREDITS_USED_UP_SCRIPT = fileURLToPath(
  new URL("../../worker/src/decide/testdata/ai-credits-used-up-script.json", import.meta.url),
);

// The worker's scripted describe_photo answer for fixtures/photos/sample.jpg:
// one sentence and three tags.
export const DESCRIBE_ANSWER = fileURLToPath(
  new URL("../../worker/src/photos/testdata/describe-answer.json", import.meta.url),
);

// The committed replies from the fixture file: the hook reply (role `hook`)
// and the decide reply (no role), as the double reads them.
interface Reply {
  role?: "hook";
  answer: unknown;
  usage?: unknown;
  model?: string;
}

async function committedReplies(): Promise<{ hook: Reply; decide: Reply }> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed worker script
  const replies = JSON.parse(await readFile(SHORT_SPEECH_ANSWER, "utf8")) as Reply[];
  const hook = replies.find((reply) => reply.role === "hook");
  const decide = replies.find((reply) => reply.role !== "hook");
  if (!hook || !decide) throw new Error("the committed AI script names a hook and a decide reply");
  return { hook, decide };
}

// Writes, into `dir`, a script whose decide answer makes no choice at all,
// with the committed hook. Version 1 has no choice and no hook, so version 2
// is version 1 plus the hook only (every reel has one now). Returns its path.
export async function unchangedAnswerScript(dir: string): Promise<string> {
  const { hook } = await committedReplies();
  const reply = {
    answer: {
      accents: [],
      big_words: [],
      visuals: [],
      transitions: [],
      word_fixes: [],
    },
  };
  const path = join(dir, "unchanged-answer.json");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file in the caller's temp folder
  await writeFile(path, JSON.stringify([hook, reply]));
  return path;
}

// One round of a scripted decide: the visuals behind the speaker (none by
// default), a big word (a word id; none by default), the transitions (none by
// default) and the hook's text (the committed one by default). The version
// title and summary are never scripted: a new version saves neither.
interface AnswerRound {
  visuals?: Record<string, unknown>[];
  bigWord?: string;
  transitions?: Record<string, unknown>[];
  hook?: { text: string };
}

// The committed decide reply with the round's visuals, big word and transitions.
async function roundReply({ visuals = [], bigWord, transitions }: AnswerRound = {}) {
  const { decide } = await committedReplies();
  const reply = structuredClone(decide) as {
    answer: Record<string, unknown> & {
      accents: unknown[];
      visuals: unknown[];
      big_words: { from: string; to: string }[];
      transitions: unknown[];
    };
  };
  reply.answer.visuals = visuals;
  reply.answer.big_words = bigWord ? [{ from: bigWord, to: bigWord }] : [];
  // On the 2.7 s fixture clip the accent holds the screen for most of it: a
  // round with a behind item leaves the accent out, so that round's expected
  // overlays stay as they were (a round's own transitions stay as given).
  if (visuals.length > 0 || bigWord) {
    reply.answer.accents = [];
    reply.answer.transitions = [];
  }
  if (transitions) reply.answer.transitions = transitions;
  return reply;
}

// Writes, into `dir`, a script of one reply per round, replayed in order
// (the last repeating), for a first answer the decide step refuses and a
// retry that passes. Each round's hook reply comes first, in the hook lane.
// Returns its path.
async function answerRoundsScript(
  dir: string,
  rounds: readonly AnswerRound[],
  decideOf: (round: AnswerRound) => unknown = roundReply,
): Promise<string> {
  const { hook } = await committedReplies();
  const hooks = rounds.map((round) => ({
    ...hook,
    answer: round.hook ?? (hook.answer as { text: string }),
  }));
  const decides = await Promise.all(rounds.map((round) => decideOf(round)));
  const path = join(dir, `answer-rounds-${crypto.randomUUID()}.json`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- a file in the caller's temp folder
  await writeFile(path, JSON.stringify([...hooks, ...decides]));
  return path;
}

// One VISUAL over the fixture clip's one sentence, w0001 to w0010, with a
// short description (never shown on screen). The layout puts its frame in
// front of the speaker when that is free.
function behindVisualItem(): Record<string, unknown> {
  return { from: "w0001", to: "w0010", description: "a messy desk at night" };
}

// Writes, into `dir`, a script whose one answer is the committed decide answer
// plus one VISUAL over the sentence. Returns its path.
export async function behindVisualAnswerScript(dir: string): Promise<string> {
  return answerRoundsScript(dir, [{ visuals: [behindVisualItem()] }]);
}

// Writes, into `dir`, a script whose one answer is the committed decide answer
// plus the big word `word` (a word id) behind the speaker, shown from that word
// for at most 2 s. Returns its path.
export async function behindWordAnswerScript(dir: string, word: string): Promise<string> {
  return answerRoundsScript(dir, [{ bigWord: word }]);
}

// The speech-ten clip (fixtures/footage/speech-ten.mp4, words w0001 to w0036).
// Its hook holds the screen from 0.2 s to 3 s, so each choice here is on words
// after it. The committed decide reply belongs to the short clip, whose word
// ids mean other words on this clip, so these answers hold the round's own
// choices and nothing else (no accent, no word fix).
function speechTenReply(round: AnswerRound) {
  return {
    answer: {
      accents: [],
      big_words: round.bigWord ? [{ from: round.bigWord, to: round.bigWord }] : [],
      visuals: round.visuals ?? [],
      transitions: round.transitions ?? [],
      word_fixes: [],
    },
  };
}

// Writes, into `dir`, a script whose one answer is a VISUAL over w0021 to
// w0027 ("And if you look at Gen Z") and nothing else. Returns its path.
export async function speechTenVisualAnswerScript(dir: string): Promise<string> {
  return answerRoundsScript(
    dir,
    [{ visuals: [{ from: "w0021", to: "w0027", description: "a phone on a desk" }] }],
    speechTenReply,
  );
}

// Writes, into `dir`, a script whose one answer is a LIST (a numbered
// transition) over w0028 to w0032, its key phrase from w0031 ("to work,") and
// its lead-in "they don't leave". Returns its path.
export async function speechTenTransitionAnswerScript(dir: string): Promise<string> {
  return answerRoundsScript(
    dir,
    [{ transitions: [{ kind: "numbered", from: "w0028", to: "w0032", key_from: "w0031" }] }],
    speechTenReply,
  );
}
