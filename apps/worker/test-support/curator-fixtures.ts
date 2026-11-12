import { type Edit, type Measurer, ISSEBYA_PRESET } from "@edit-issebya/edit";
import { transcriptOf } from "./eval-fixtures.ts";
import type { AiExchange, AiRequest, AiResult, AiRunner } from "../src/ai.ts";
import { NO_USAGE } from "../src/ai.ts";
import type { CuratorSources, LatestVersion, ParseCurrent } from "../src/evals/curator-input.ts";
import type { EvalWord } from "../src/evals/owner-marks.ts";

// Fixtures of the curator eval's tests (apps/worker/src/evals): one labelled
// reel, its stored decide run and latest version, all in memory. Test only.

export const TEXT = "we work to live and we live to work every day";
export const REEL = "aaaaaaaa-0000-4000-8000-000000000001";
export const VERSION = "00000000-0000-4000-8000-0000000000a2";
export const AI_KEY = `dev/reels/${REEL}/versions/${VERSION}.ai.json`;
export const HOOK = "a short hook";

// The owner's marks of TEXT: "work to live" (accent) and "day" (big word).
export const OWNER = {
  accent: [{ start: 1, end: 3.5, words: "work to live" }],
  bigword: [{ start: 10, end: 10.5, words: "day" }],
};

// A components answer over TEXT's ids (every list present, as the schema asks):
// the owner's accent and big word, and nothing else.
export const ANSWER = {
  accents: [{ from: "w2", to: "w4" }],
  questions: [],
  big_words: [{ from: "w11", to: "w11" }],
  visuals: [],
  lists: [],
  word_fixes: [],
};

// The latest version's edit, reduced to what the builder reads: its hook.
export const EDIT = { tracks: { overlays: [{ kind: "hook", id: "hook-1", text: HOOK }] } };

export const datasetWords = (text: string): EvalWord[] =>
  transcriptOf(text).words.map(({ text: word, start, end }) => ({ text: word, start, end }));

// The stored AI record of a decide run: its hook call and its decide call.
export function runRecord({
  hook = HOOK,
  intensity = ISSEBYA_PRESET.intensity,
  target,
}: {
  hook?: string;
  intensity?: string;
  target: number;
}) {
  return {
    format: 1,
    prompt_version: "reel-components@v1",
    hook_prompt_version: "reel-hook@v1",
    intensity,
    target_picks: target,
    calls: [
      { role: "hook", attempt: 1, answerText: JSON.stringify({ text: hook }) },
      { role: "decide", attempt: 1, answerText: JSON.stringify(ANSWER) },
    ],
  };
}

// Sources over one reel: a decide run of TEXT (version 2, its transcript
// stored) and that version as the latest. `overrides` change one read.
export function fixtureSources(
  overrides: {
    latest?: Partial<LatestVersion> | null;
    run?: unknown;
    // Extra stored JSON, by key.
    json?: Record<string, unknown>;
  } = {},
): CuratorSources {
  const latest: LatestVersion | null =
    overrides.latest === null
      ? null
      : {
          id: VERSION,
          number: 2,
          editKey: "edit-key",
          transcriptKey: "transcript-key",
          headTrackKey: "head-key",
          ...overrides.latest,
        };
  const json: Record<string, unknown> = {
    "transcript-key": transcriptOf(TEXT),
    "head-key": [],
    "edit-key": EDIT,
    [AI_KEY]: overrides.run ?? runRecord({ target: 3 }),
    ...overrides.json,
  };
  return {
    async aiFiles() {
      return [{ reelId: REEL, key: AI_KEY }];
    },
    async versions(ids) {
      return ids.map((id) => ({ id, number: 2, transcriptKey: "transcript-key" }));
    },
    async readJson(key) {
      return key in json ? json[key] : null;
    },
    async latestVersion(reelId) {
      return reelId === REEL ? latest : null;
    },
  };
}

// The parse of the latest version as the builder takes it: the stub edit.
export const parseEditStub: ParseCurrent = () => ({ ok: true, edit: EDIT as unknown as Edit });

// A measurer the tests never call (the validator is injected there).
export const noMeasurer = async () => ({}) as unknown as Measurer;

const exchange = {} as AiExchange;

export function answerResult(answer: unknown): AiResult {
  return { kind: "answer", answer, usage: NO_USAGE, exchange };
}

// An AI double: each call's reply by role. `reply` gets the request, so a test
// can answer the judge from the picks it was sent.
export function roleAi(reply: (request: AiRequest) => AiResult): AiRunner & { calls: AiRequest[] } {
  const calls: AiRequest[] = [];
  return {
    calls,
    async call(request) {
      calls.push(request);
      return reply(request);
    },
  };
}

// The picks the judge was sent: the last fenced JSON block of its prompt.
export function sentPicksOf(request: AiRequest): { pick: string; words: string }[] {
  const block = request.prompt.split("```json\n").at(-1)!.split("\n```")[0]!;
  return JSON.parse(block) as { pick: string; words: string }[];
}
