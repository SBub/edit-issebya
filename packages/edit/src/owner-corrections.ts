import { build } from "./build.ts";
import { captionBlocks } from "./caption-blocks.ts";
import type { EngineInput } from "./engine-input.ts";
import type { EngineNote } from "./engine-note.ts";
import type { HeadTrack } from "./head-track.ts";
import type { Measurer } from "./measure.ts";
import { withOwnerMarks } from "./owner-marks.ts";
import { type OwnerText, applyOwnerTexts, relaidBlock } from "./owner-text.ts";
import { type Preset, wordsText } from "./preset.ts";
import type { CaptionItem, Edit } from "./schema.ts";
import type { Transcript } from "./transcript.ts";

// THE OWNER'S TRANSCRIPT CORRECTIONS (app_docs/owner-edits.md, "Transcript
// corrections"; owner decisions 2026-11-19): a text fix the owner types into
// a CAPTION says what was really spoken, so it is kept for the reel, per
// spoken word, beside the version it was typed in (the `owner_word_corrections`
// table, which no pipeline step writes). The version the owner saved shows the
// fix only where it was typed. Every later rebuild (a font pair change, a
// Start over, the automatic decide of a reel processed again) builds from the
// transcript with the corrections applied: the captions show them, the
// components placed on those words show them, and the AI reads them. The
// owner wins over the transcript and over the curator's `word_fixes`.
// A fix typed into any other element (an accent, a question, a big word, a
// list, the hook) is that element's only and is never a correction.

// One spoken word as the owner corrected it. An empty text is a word the
// owner's caption does not show: it joined the caption of the word before it
// (the owner typed fewer words than were spoken).
export interface WordCorrection {
  word: string;
  text: string;
}

// A correction as the reel keeps it: with the word's text in the transcript
// it was made on, so it is applied only while the transcript still has that
// word (a reel processed again from other footage keeps none by accident).
export interface StoredCorrection extends WordCorrection {
  original: string;
}

// The record's rule and entry name of a correction's note (the owner's edits'
// own, `owner-carry.ts`).
const RULE = "owner-edit";
const VARIANT = "owner/carried";

const sameWords = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, index) => id === b[index]);

const quote = (text: string): string => `"${text.length > 40 ? `${text.slice(0, 39)}…` : text}"`;

// The corrections one save makes: every caption of `after` (the version being
// saved) that no caption of `before` (the version edited) shows with the same
// words and the same text. Its first spoken word gets the caption's text and
// each other word of it an empty one. A caption the owner did not change gives
// nothing, so a correction is only ever what the owner typed.
export function captionCorrections(
  before: Edit,
  after: Edit,
  transcript: Transcript,
  preset: Preset,
): WordCorrection[] {
  const shown = (item: CaptionItem) => item.text ?? wordsText(item.words, transcript, preset);
  const was = before.tracks.captions.map((item) => ({ words: item.words, text: shown(item) }));
  const corrections: WordCorrection[] = [];
  for (const item of after.tracks.captions) {
    const text = shown(item);
    if (was.some((entry) => entry.text === text && sameWords(entry.words, item.words))) continue;
    item.words.forEach((word, index) => {
      corrections.push({ word, text: index === 0 ? text : "" });
    });
  }
  return corrections;
}

// The corrections that hold for a transcript: each one whose word is still in
// it with the text it was corrected from, in the transcript's order.
export function liveCorrections(
  stored: readonly StoredCorrection[],
  transcript: Transcript,
): WordCorrection[] {
  const byWord = new Map(stored.map((entry) => [entry.word, entry]));
  return transcript.words.flatMap((word) => {
    const entry = byWord.get(word.id);
    return entry && entry.original === word.text ? [{ word: word.id, text: entry.text }] : [];
  });
}

// The punctuation a spoken word carries around its letters (a sentence's end
// is read from it, `sentenceSpans`).
const LEAD = /^[\s"'(\[]*/;
const TRAIL = /[\s,.?!:;"')\]]*$/;

// The transcript as the AI reads it (the hook's call and the components'
// script): each corrected word says the owner's text, inside the punctuation
// the spoken word had, and a word a corrected caption does not show is left
// out, its closing punctuation moved to the word before it. The words keep
// their ids and times. The transcript itself with no correction.
export function correctedTranscript(
  transcript: Transcript,
  corrections: readonly WordCorrection[],
): Transcript {
  if (corrections.length === 0) return transcript;
  const byWord = new Map(corrections.map((entry) => [entry.word, entry.text]));
  const words: Transcript["words"] = [];
  for (const word of transcript.words) {
    const text = byWord.get(word.id);
    if (text === undefined) {
      words.push(word);
      continue;
    }
    const trail = TRAIL.exec(word.text)![0];
    const last = words.at(-1);
    if (text === "" && last) {
      // Left out: the caption before it shows what was said here.
      if (/[.?!]/.test(trail) && !/[.?!]["')\]]*\s*$/.test(last.text)) {
        words[words.length - 1] = { ...last, text: `${last.text.trimEnd()}${trail}` };
      }
      continue;
    }
    if (text === "") {
      words.push(word);
      continue;
    }
    const closed = /[.?!]$/.test(text) ? trail.replace(/^[,.?!:;]+/, "") : trail;
    words.push({ ...word, text: `${LEAD.exec(word.text)![0]}${text}${closed}` });
  }
  return { ...transcript, words };
}

// An answer with the corrections as its word fixes: the owner's text for a
// word replaces the curator's, and a word a corrected caption does not show
// takes no fix. The engine then writes every caption and every component
// placed on a corrected word with the owner's text.
export function withWordCorrections(
  input: EngineInput,
  corrections: readonly WordCorrection[],
): EngineInput {
  if (corrections.length === 0) return input;
  const corrected = new Set(corrections.map((entry) => entry.word));
  return {
    ...input,
    word_fixes: [
      ...input.word_fixes.filter((fix) => !corrected.has(fix.word)),
      ...corrections.filter((entry) => entry.text !== ""),
    ],
  };
}

interface Context {
  transcript: Transcript;
  headTrack: HeadTrack;
  preset: Preset;
  measurer: Measurer;
}

// A caption's text set by its spoken words on a placed edit: the run of shown
// captions of one group that say exactly `words` becomes one caption with
// `text` (as the owner's version has it), the group wrapped again inside its
// block, the block's top and centre line kept, and the caption marked as the
// owner's (`edit.owner.texts`). Null when no group shows exactly those words
// as captions (a text on screen hides some of them, or they fall in two
// groups).
function fixCaptionRun(
  edit: Edit,
  fix: { words: readonly string[]; text: string },
  context: Context,
): Edit | null {
  const { transcript, headTrack, preset, measurer } = context;
  const byId = new Map(edit.tracks.captions.map((item) => [item.id, item]));
  for (const block of captionBlocks(edit, transcript)) {
    for (const group of block.groups) {
      const start = group.captions.findIndex((id) => byId.get(id)!.words[0] === fix.words[0]);
      if (start < 0) continue;
      const run: string[] = [];
      const words: string[] = [];
      for (const id of group.captions.slice(start)) {
        if (words.length >= fix.words.length) break;
        run.push(id);
        words.push(...byId.get(id)!.words);
      }
      if (!sameWords(words, fix.words)) continue;
      const first = byId.get(run[0]!)!;
      const replaced: CaptionItem = { ...first, words: [...fix.words], text: fix.text };
      if (fix.text === wordsText(fix.words, transcript, preset)) delete replaced.text;
      const box = build(edit, transcript, headTrack, preset, measurer, {
        layer: "front",
      }).components.find((component) => component.id === block.id);
      if (!box) continue;
      const relaid = relaidBlock(edit, block, group.id, run, [replaced], box, context);
      return withOwnerMarks(
        { ...edit, tracks: { ...edit.tracks, captions: relaid.captions } },
        { texts: [replaced.id] },
      );
    }
  }
  return null;
}

export interface CorrectionsApplied {
  edit: Edit;
  // One note per correction that could not be shown as the owner typed it.
  notes: EngineNote[];
  kept: number;
  dropped: number;
}

// The corrections on an edit the engine placed from an answer that carried
// them (`withWordCorrections`). The engine has already written each corrected
// word on its caption and in a list's phrase; here every caption showing one
// is marked as the owner's text, so it is never counted as a curator's fix,
// and a caption the owner typed over several spoken words is made one caption
// again (`fixCaptionRun`). One that cannot be (a text on screen hides part of
// its words in this placement) is noted, never lost silently: its first word
// still shows the owner's text. An accent, a question and a big word the new
// placement shows on a corrected word say the owner's words too: their text
// is written from their spoken words with the corrections and wrapped inside
// their box (`applyOwnerTexts`), with no mark, as the text is the reel's and
// not that element's own.
export function applyWordCorrections(
  edit: Edit,
  corrections: readonly WordCorrection[],
  context: Context,
): CorrectionsApplied {
  const notes: EngineNote[] = [];
  let kept = 0;
  let dropped = 0;
  if (corrections.length === 0) return { edit, notes, kept, dropped };
  const byWord = new Map(corrections.map((entry) => [entry.word, entry.text]));
  // Each corrected word with a text, and the words after it that its caption
  // does not show, in the transcript's order.
  const runs: { words: string[]; text: string }[] = [];
  let open: { words: string[]; text: string } | null = null;
  for (const word of context.transcript.words) {
    const text = byWord.get(word.id);
    if (text === undefined) open = null;
    else if (text !== "") {
      open = { words: [word.id], text };
      runs.push(open);
    } else open?.words.push(word.id);
  }
  let now = edit;
  for (const run of runs) {
    if (run.words.length > 1) {
      const fixed = fixCaptionRun(now, run, context);
      if (fixed) {
        now = fixed;
        kept += 1;
        continue;
      }
      dropped += 1;
      notes.push({
        item: run.words[0]!,
        component: "CAPTION",
        variant: VARIANT,
        start: 0,
        end: 0,
        rule: RULE,
        outcome: "dropped",
        blockers: [],
        reason: `your caption text ${quote(run.text)} could not be kept as one caption: the new version shows no captions on exactly the same words`,
      });
    } else kept += 1;
    // The captions the engine wrote with the owner's text for this word.
    const mine = now.tracks.captions
      .filter((item) => item.words.includes(run.words[0]!) && item.text !== undefined)
      .map((item) => item.id);
    now = withOwnerMarks(now, { texts: mine });
  }
  // The components on a corrected word: the words they show, corrected.
  const { transcript, preset } = context;
  const plain = (ids: readonly string[]) => wordsText(ids, transcript, preset);
  const corrected = (ids: readonly string[]) =>
    ids
      .flatMap((id) => {
        const text = byWord.get(id);
        return text === undefined ? [plain([id])] : text === "" ? [] : [text];
      })
      .join(" ");
  const texts: OwnerText[] = [];
  for (const item of now.tracks.overlays) {
    const words = item.words ?? [];
    if (item.kind === "hook" || !words.some((id) => byWord.has(id))) continue;
    if (item.text !== undefined && item.text !== plain(words)) continue;
    const text = corrected(words);
    if (text !== "" && text !== plain(words)) texts.push({ id: item.id, text });
  }
  for (const item of now.tracks.behind ?? []) {
    const words = item.kind === "word" ? (item.words ?? []) : [];
    if (item.kind !== "word" || !words.some((id) => byWord.has(id))) continue;
    if (item.text.toLowerCase() !== plain(words).toLowerCase()) continue;
    const text = corrected(words);
    if (text !== "" && text.toLowerCase() !== item.text.toLowerCase()) {
      texts.push({ id: item.id, text });
    }
  }
  for (const text of texts) {
    const applied = applyOwnerTexts(now, [text], { ...context, carried: true });
    if (!applied.ok) continue;
    // The text is the reel's correction, not this element's own: no mark.
    const marks = now.owner;
    now = { ...applied.edit };
    if (marks) now.owner = marks;
    else delete now.owner;
  }
  return { edit: now, notes, kept, dropped };
}
