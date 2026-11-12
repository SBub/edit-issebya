import type { Transcript } from "@edit-issebya/edit";

// Fixtures of the judge eval's tests (apps/worker/src/evals): a transcript
// made from a line of text and a dataset item as PostHog serves one.

// One word per token: ids `<prefix>1`, `<prefix>2`, ..., word n spoken from
// n - 1 to n - 0.5 seconds.
export function transcriptOf(text: string, prefix = "w"): Transcript {
  return {
    words: text.split(" ").map((word, index) => ({
      id: `${prefix}${index + 1}`,
      text: word,
      start: index,
      end: index + 0.5,
    })),
  };
}

type Mark = { start: number; end: number; words?: string };

// A dataset item over `text`, with the owner's marks as given.
export function ownerItemJson(
  text: string,
  expected: {
    accent?: Mark[];
    bigword?: Mark[];
    question?: Mark[];
    nothing?: Mark[];
    list?: { level?: string; start: number; end: number; items: Mark[] }[];
  },
  { reelId = "aaaaaaaa", id = "item-a" }: { reelId?: string; id?: string } = {},
): unknown {
  return {
    id,
    client_item_id: `owner-reels-${reelId}`,
    version_id: `${id}-version`,
    input: {
      transcript: {
        text,
        words: transcriptOf(text).words.map(({ text: word, start, end }) => ({
          text: word,
          start,
          end,
        })),
      },
    },
    expected_output: {
      hook: [],
      visual: [{ start: 0, end: 0.5, words: text.split(" ")[0], component: "visual" }],
      ...expected,
    },
    metadata: { reel_id: reelId, source: "owner" },
  };
}
