import { describe, expect, it } from "vitest";
import { build } from "./build.ts";
import { captionBlocks } from "./caption-blocks.ts";
import { decideCounts, editFromAnswer } from "./decide.ts";
import { choicesOf } from "./engine-input.ts";
import {
  type WordCorrection,
  applyWordCorrections,
  captionCorrections,
  correctedTranscript,
  liveCorrections,
  withWordCorrections,
} from "./owner-corrections.ts";
import { applyOwnerTexts, ownerTextOf } from "./owner-text.ts";
import { ISSEBYA_PRESET, wordsText } from "./preset.ts";
import { type Edit, parseEdit } from "./schema.ts";
import { FIXTURES } from "./test-support/fixtures.ts";
import { nodeMeasurer } from "./test-support/measurer.node.ts";
import { sentenceSpans } from "./transcript.ts";

// A placed version with the hook, two accents and a big word, and its answer.
const hook = FIXTURES.find((fixture) => fixture.name === "rethink-work-hook")!;
const preset = ISSEBYA_PRESET;
const { transcript, headTrack } = hook;
const answer = choicesOf(hook.edit, transcript, preset);

async function contextOf() {
  return { transcript, headTrack, preset, measurer: await nodeMeasurer() };
}

// The first caption group with three captions or more, its block and its words.
function groupOf(edit: Edit) {
  const byId = new Map(edit.tracks.captions.map((item) => [item.id, item]));
  for (const block of captionBlocks(edit, transcript)) {
    const group = block.groups.find((entry) => entry.captions.length >= 3);
    if (group) {
      return { block, group, words: group.captions.flatMap((id) => byId.get(id)!.words) };
    }
  }
  throw new Error("no caption group that long");
}

async function withText(id: string, part: string | undefined, text: string) {
  const applied = applyOwnerTexts(
    hook.edit,
    [part === undefined ? { id, text } : { id, part, text }],
    await contextOf(),
  );
  if (!applied.ok) throw new Error(applied.reasons.join("; "));
  return applied.edit;
}

// The answer placed again with the corrections, the way every rebuild does it.
async function rebuilt(corrections: readonly WordCorrection[], input = answer) {
  const context = await contextOf();
  const made = editFromAnswer(
    hook.edit,
    withWordCorrections(input, corrections),
    preset,
    transcript,
    headTrack,
    context.measurer,
  );
  if (!made.ok) throw new Error(made.reasons.join("; "));
  return applyWordCorrections(made.edit, corrections, context);
}

const shown = (edit: Edit, word: string) => {
  const item = edit.tracks.captions.find((entry) => entry.words.includes(word))!;
  return item.text ?? wordsText(item.words, transcript, preset);
};

describe("the corrections one save makes", () => {
  it("is the one caption the owner's text changed, by its spoken word", async () => {
    const { block, group, words } = groupOf(hook.edit);
    const text = ownerTextOf(hook.edit, { id: block.id, part: group.id }, await contextOf())!.text;
    const typed = text.split(" ");
    typed[1] = "FIXED";
    const edit = await withText(block.id, group.id, typed.join(" "));
    expect(captionCorrections(hook.edit, edit, transcript, preset)).toEqual([
      { word: words[1], text: "FIXED" },
    ]);
  });

  it("gives a word the owner's caption no longer shows an empty text, after the word whose caption it joined", async () => {
    const { block, group, words } = groupOf(hook.edit);
    // Fewer words than spoken: the captions left with no word join the one before.
    const edit = await withText(block.id, group.id, "all of it");
    const corrections = captionCorrections(hook.edit, edit, transcript, preset);
    expect(corrections.map((entry) => entry.word)).toEqual(words);
    expect(
      corrections
        .map((entry) => entry.text)
        .filter((text) => text !== "")
        .join(" "),
    ).toBe("all of it");
    if (words.length > 3) expect(corrections.some((entry) => entry.text === "")).toBe(true);
    expect(corrections[0]!.text).not.toBe("");
  });

  it("is nothing for a version with no caption text changed: another element's fix is that element's only", async () => {
    expect(captionCorrections(hook.edit, hook.edit, transcript, preset)).toEqual([]);
    for (const id of ["accent-1", "hook", "big-word-1"]) {
      const edit = await withText(id, undefined, "something else");
      expect(captionCorrections(hook.edit, edit, transcript, preset), id).toEqual([]);
    }
  });
});

describe("the corrections that hold for a transcript", () => {
  it("keeps one whose word still has the text it was corrected from, in the transcript's order", () => {
    const [first, second, third] = transcript.words;
    const stored = [
      { word: third!.id, text: "three", original: third!.text },
      { word: first!.id, text: "one", original: first!.text },
      // The transcript says something else there now: not applied.
      { word: second!.id, text: "two", original: `${second!.text} once` },
      { word: "w9999", text: "none", original: "gone" },
    ];
    expect(liveCorrections(stored, transcript)).toEqual([
      { word: first!.id, text: "one" },
      { word: third!.id, text: "three" },
    ]);
  });
});

describe("the transcript the AI reads", () => {
  const tiny = {
    words: [
      { id: "w0001", text: " Jenzy", start: 0, end: 0.3 },
      { id: "w0002", text: " won't", start: 0.3, end: 0.6 },
      { id: "w0003", text: " work,", start: 0.6, end: 0.9 },
      { id: "w0004", text: " kind", start: 0.9, end: 1.1 },
      { id: "w0005", text: " of.", start: 1.1, end: 1.3 },
      { id: "w0006", text: " Next", start: 1.4, end: 1.6 },
    ],
  };

  it("says the owner's words in the spoken word's punctuation, ids and times kept", () => {
    const read = correctedTranscript(tiny, [
      { word: "w0001", text: "Gen Z" },
      { word: "w0003", text: "labour" },
    ]);
    expect(read.words.map((word) => word.text)).toEqual([
      " Gen Z",
      " won't",
      " labour,",
      " kind",
      " of.",
      " Next",
    ]);
    expect(read.words.map(({ id, start, end }) => ({ id, start, end }))).toEqual(
      tiny.words.map(({ id, start, end }) => ({ id, start, end })),
    );
  });

  it("leaves out a word the corrected caption does not show and keeps its sentence end", () => {
    const read = correctedTranscript(tiny, [
      { word: "w0004", text: "sort of" },
      { word: "w0005", text: "" },
    ]);
    expect(read.words.map((word) => word.text)).toEqual([
      " Jenzy",
      " won't",
      " work,",
      " sort of.",
      " Next",
    ]);
    // The sentences end where they did.
    expect(sentenceSpans(read).map((span) => span.to)).toEqual(["w0004", "w0006"]);
    expect(sentenceSpans(tiny).map((span) => span.to)).toEqual(["w0005", "w0006"]);
  });

  it("is the transcript itself with no correction", () => {
    expect(correctedTranscript(tiny, [])).toBe(tiny);
  });
});

describe("the corrections in a rebuild", () => {
  it("win over the curator's fix of the same word, and a left-out word takes no fix", () => {
    const [first, second, third] = transcript.words;
    const input = {
      ...answer,
      word_fixes: [
        { word: first!.id, text: "curator" },
        { word: second!.id, text: "curator too" },
        { word: third!.id, text: "kept" },
      ],
    };
    expect(
      withWordCorrections(input, [
        { word: first!.id, text: "owner" },
        { word: second!.id, text: "" },
      ]).word_fixes,
    ).toEqual([
      { word: third!.id, text: "kept" },
      { word: first!.id, text: "owner" },
    ]);
    expect(withWordCorrections(input, [])).toBe(input);
  });

  it("show on the caption of the word, marked as the owner's, and never count as a curator's fix", async () => {
    const { words } = groupOf(hook.edit);
    const result = await rebuilt([{ word: words[1]!, text: "FIXED" }]);
    expect(result).toMatchObject({ kept: 1, dropped: 0, notes: [] });
    expect(shown(result.edit, words[1]!)).toBe("FIXED");
    expect(shown(result.edit, words[0]!)).toBe(wordsText([words[0]!], transcript, preset));
    const caption = result.edit.tracks.captions.find((item) => item.words.includes(words[1]!))!;
    expect(result.edit.owner).toEqual({ placed: [], texts: [caption.id] });
    // The curator's own fixes are counted as before, the owner's never.
    expect(decideCounts(result.edit, transcript, preset).wordsFixed).toBe(
      decideCounts((await rebuilt([])).edit, transcript, preset).wordsFixed,
    );
    expect(parseEdit(JSON.parse(JSON.stringify(result.edit)), preset, transcript).ok).toBe(true);
  });

  it("show on a component placed on the corrected word too", async () => {
    const accent = answer.accents[0]!;
    const result = await rebuilt([{ word: accent.from, text: "OWNERWORD" }]);
    const built = build(result.edit, transcript, headTrack, preset, (await contextOf()).measurer, {
      layer: "front",
    });
    expect(built.components.find((entry) => entry.id === "accent-1")!.text).toContain("OWNERWORD");
    expect(result.kept).toBe(1);
    // The text is the reel's, not the accent's own: the accent is not marked.
    expect(result.edit.owner?.texts ?? []).not.toContain("accent-1");
    expect(parseEdit(JSON.parse(JSON.stringify(result.edit)), preset, transcript).ok).toBe(true);
  });

  it("make a caption typed over several spoken words one caption again", async () => {
    const { block, group, words } = groupOf(hook.edit);
    const corrections = captionCorrections(
      hook.edit,
      await withText(block.id, group.id, "all of it"),
      transcript,
      preset,
    );
    const result = await rebuilt(corrections);
    expect(result.dropped).toBe(0);
    const captions = result.edit.tracks.captions.filter((item) =>
      item.words.some((word) => words.includes(word)),
    );
    // Every spoken word is still some caption's, and the captions say the
    // owner's text in order.
    expect(captions.flatMap((item) => item.words)).toEqual(words);
    expect(captions.map((item) => item.text ?? wordsText(item.words, transcript, preset))).toEqual(
      corrections.filter((entry) => entry.text !== "").map((entry) => entry.text),
    );
    expect(parseEdit(JSON.parse(JSON.stringify(result.edit)), preset, transcript).ok).toBe(true);
  });

  it("note a caption that cannot be one caption in the new placement, its first word still the owner's", async () => {
    const { words } = groupOf(hook.edit);
    // Two words of two different sentences can never be one caption.
    const far = transcript.words.at(-1)!.id;
    const spans = sentenceSpans(transcript);
    expect(spans.length).toBeGreaterThan(1);
    const lastOfFirst = spans[0]!.to;
    const firstOfSecond = spans[1]!.from;
    expect(far).not.toBe(lastOfFirst);
    const result = await rebuilt([
      { word: lastOfFirst, text: "JOINED" },
      { word: firstOfSecond, text: "" },
    ]);
    if (result.dropped === 1) {
      expect(result.notes).toEqual([
        expect.objectContaining({
          item: lastOfFirst,
          component: "CAPTION",
          rule: "owner-edit",
          outcome: "dropped",
          reason: expect.stringMatching(
            /^your caption text "JOINED" could not be kept as one caption: /,
          ),
        }),
      ]);
    } else {
      expect(result.kept).toBe(1);
    }
    expect(words.length).toBeGreaterThan(0);
  });

  it("change nothing with no correction", async () => {
    const context = await contextOf();
    const made = editFromAnswer(hook.edit, answer, preset, transcript, headTrack, context.measurer);
    if (!made.ok) throw new Error(made.reasons.join("; "));
    const result = applyWordCorrections(made.edit, [], context);
    expect(result).toEqual({ edit: made.edit, notes: [], kept: 0, dropped: 0 });
  });
});
