import { describe, expect, it } from "vitest";
import { transcriptOf } from "../../test-support/eval-fixtures.ts";
import { type RunSources, curatorAnswer, curatorRunsFor, runCandidates } from "./curator-runs.ts";

const TEXT = "we work to live and we live to work every day";
const TRANSCRIPT = transcriptOf(TEXT);

// A stored AI record (`<version id>.ai.json`) as the decide step writes one:
// the hook call, then the decide attempts, each with its raw answer text.
function aiRecord(answers: unknown[], promptVersion = "reel-components@v7") {
  return {
    format: 1,
    reel_id: "reel",
    version_id: "version",
    prompt_version: promptVersion,
    hook_prompt_version: "reel-hook@v2",
    calls: [
      { role: "hook", attempt: 1, answerText: JSON.stringify({ text: "A hook" }) },
      ...answers.map((answer, index) => ({
        role: "decide",
        attempt: index + 1,
        answerText: typeof answer === "string" ? answer : JSON.stringify(answer),
      })),
    ],
  };
}

const ANSWER = {
  accents: [{ from: "w2", to: "w4" }],
  questions: [{ from: "w6", to: "w9" }],
  big_words: [{ from: "w11", to: "w11" }],
  visuals: [{ from: "w1", to: "w2", description: "a desk" }],
  lists: [
    {
      items: [
        { from: "w2", to: "w2", key_from: "w2" },
        { from: "w8", to: "w9", key_from: "w9" },
      ],
    },
  ],
  word_fixes: [],
};

describe("curatorAnswer", () => {
  it("reads the picks of the decide answer and keeps the prompt version", () => {
    expect(curatorAnswer(aiRecord([ANSWER]), TRANSCRIPT)).toEqual({
      promptVersion: "reel-components@v7",
      unreadable: 0,
      picks: [
        { component: "accent", span: { from: 1, to: 3 } },
        { component: "question", span: { from: 5, to: 8 } },
        { component: "bigword", span: { from: 10, to: 10 } },
        {
          component: "list",
          span: { from: 1, to: 8 },
          items: [
            { from: 1, to: 1 },
            { from: 7, to: 8 },
          ],
        },
      ],
    });
  });

  it("takes the last decide answer (the one saved after a refused first), fenced or not", () => {
    const refused = { ...ANSWER, accents: [{ from: "w1", to: "w1" }] };
    const fencedAnswer = ["```json", JSON.stringify({ ...ANSWER, lists: [] }), "```"].join("\n");
    const answer = curatorAnswer(aiRecord([refused, fencedAnswer]), TRANSCRIPT);
    expect(answer?.picks.map((pick) => pick.component)).toEqual(["accent", "question", "bigword"]);
    expect(answer?.picks[0]?.span).toEqual({ from: 1, to: 3 });
  });

  it("leaves out a pick naming a word the transcript does not have, and counts it", () => {
    const answer = curatorAnswer(
      aiRecord([
        {
          accents: [
            { from: "w2", to: "w99" },
            { from: "w4", to: "w2" },
          ],
          lists: [
            {
              items: [
                { from: "w2", to: "w2" },
                { from: "nope", to: "w3" },
              ],
            },
          ],
        },
      ]),
      TRANSCRIPT,
    );
    expect(answer).toMatchObject({ picks: [], unreadable: 3 });
  });

  it("has no answer in a record without a readable decide call", () => {
    expect(curatorAnswer(aiRecord([]), TRANSCRIPT)).toBeNull();
    expect(curatorAnswer(aiRecord(["not json"]), TRANSCRIPT)).toBeNull();
    expect(curatorAnswer(null, TRANSCRIPT)).toBeNull();
  });
});

const REEL = "aaaaaaaa-0000-4000-8000-000000000001";
const REUPLOAD = "bbbbbbbb-0000-4000-8000-000000000002";
const OTHER = "cccccccc-0000-4000-8000-000000000003";
const version = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const aiKey = (reel: string, n: number) => `dev/reels/${reel}/versions/${version(n)}.ai.json`;

function sources(): RunSources & { reads: string[] } {
  const reads: string[] = [];
  const objects: Record<string, unknown> = {
    "t/own": TRANSCRIPT,
    // The same words under other ids and at other seconds: a re-upload.
    "t/reupload": {
      words: transcriptOf(TEXT, "x").words.map((word) => ({ ...word, end: word.end + 0.1 })),
    },
    "t/retimed": transcriptOf("we work to live"),
    "t/other": transcriptOf("something else entirely"),
    [aiKey(REEL, 1)]: aiRecord([ANSWER], "reel-components@v6"),
    [aiKey(REEL, 2)]: aiRecord([ANSWER]),
    [aiKey(REEL, 3)]: aiRecord([ANSWER]),
    [aiKey(REUPLOAD, 4)]: aiRecord([{ accents: [{ from: "x2", to: "x4" }] }]),
    [aiKey(OTHER, 5)]: aiRecord([ANSWER]),
  };
  return {
    reads,
    async aiFiles() {
      return [
        { reelId: REUPLOAD, key: aiKey(REUPLOAD, 4) },
        { reelId: REEL, key: aiKey(REEL, 2) },
        { reelId: REEL, key: aiKey(REEL, 1) },
        { reelId: REEL, key: aiKey(REEL, 3) },
        { reelId: OTHER, key: aiKey(OTHER, 5) },
        { reelId: OTHER, key: "dev/reels/x/versions/not-a-record.json" },
      ];
    },
    async versions(ids) {
      const keys = ["t/own", "t/own", "t/retimed", "t/reupload", "t/other"];
      return ids.map((id) => {
        const n = Number(id.at(-1));
        return { id, number: n, transcriptKey: keys[n - 1]! };
      });
    },
    async readJson(key) {
      reads.push(key);
      return objects[key] ?? null;
    },
  };
}

describe("the stored curator runs", () => {
  it("lists every stored run with its transcript, each transcript read once", async () => {
    const from = sources();
    const candidates = await runCandidates(from);
    expect(candidates.map((run) => [run.reelId.slice(0, 8), run.number])).toEqual([
      ["aaaaaaaa", 1],
      ["aaaaaaaa", 2],
      ["aaaaaaaa", 3],
      ["bbbbbbbb", 4],
      ["cccccccc", 5],
    ]);
    expect(from.reads.sort()).toEqual(["t/other", "t/own", "t/retimed", "t/reupload"]);
  });

  it("gives a labelled reel its own runs and those of a reel with the same words", async () => {
    const from = sources();
    const item = { reelId: "aaaaaaaa", words: TRANSCRIPT.words };
    const found = await curatorRunsFor(item, await runCandidates(from), from.readJson);
    expect(found.runs.map((run) => [run.reelId, run.number, run.promptVersion])).toEqual([
      [REEL, 1, "reel-components@v6"],
      [REEL, 2, "reel-components@v7"],
      [REUPLOAD, 4, "reel-components@v7"],
    ]);
    // The re-upload's picks land on the same word positions.
    expect(found.runs[2]?.picks).toEqual([{ component: "accent", span: { from: 1, to: 3 } }]);
    // Version 3 of the reel itself was decided from another transcript.
    expect(found.differing).toBe(1);
    // Only the matching runs' records are read.
    expect(from.reads).not.toContain(aiKey(OTHER, 5));
    expect(from.reads).not.toContain(aiKey(REEL, 3));
  });
});
