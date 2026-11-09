import { wordsText } from "./glossary.ts";
import { type Preset, type TransitionKind, cleanWord } from "./preset.ts";
import type { Anchor, Edit } from "./schema.ts";
import { resolveTimeline } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";

// THE LAYOUT ENGINE'S INPUT. Claude (the decide step) answers in meaning only:
// which words are accents, which words are questions the speaker puts to the
// viewer, which words are big words behind, which words a VISUAL sits on (an
// empty frame, with a short description of what it would show), which phrase
// a transition carries, which misheard words to fix, and one short written
// hook line for the start.
// Everything refers to the transcript by word id; there
// are no times, positions, sizes or spots. The layout engine (`engine.ts`,
// `placeEdit`) turns it into placed tracks.

export interface AccentChoice {
  from: string;
  to: string;
  // Set by the engine on a QUESTION it places with the ACCENT's look and timing
  // (its overlay id is `question-N`); never in an answer.
  question?: boolean;
}

// A QUESTION: a question the speaker puts to the viewer over the words `from`
// to `to`, often rhetorical. It is placed as an ACCENT (the same look and
// timing).
export interface QuestionChoice {
  from: string;
  to: string;
}

// A BIGWORD: one plain word, or two consecutive ones, shown large behind the
// speaker. `from` and `to` are word ids, equal for one word.
export interface BigWordChoice {
  from: string;
  to: string;
}

// A big word's span as stored: `{ from, to }` (the same word twice for one word).
export function bigWordSpan(item: { from: string; to: string }): { from: string; to: string } {
  return { from: item.from, to: item.to };
}

// A VISUAL: an empty white stroke frame over the words `from` to `to`. The
// description says what a visual would show; it is never shown on screen.
export interface VisualChoice {
  from: string;
  to: string;
  description?: string;
}

// A transition carries the phrase `from` to `to`; its key phrase (in accent
// text) starts on `key_from`, the words before it are the lead-in.
export interface TransitionChoice {
  kind: TransitionKind;
  from: string;
  to: string;
  key_from: string;
}

// The caption showing `word` shows `text` instead (a misheard word fixed).
export interface WordFix {
  word: string;
  text: string;
}

// The written hook: Claude's own short line shown in the first seconds, the
// one text on screen nobody says. Words to show, never instructions.
export interface HookChoice {
  text: string;
}

export interface EngineInput {
  accents: AccentChoice[];
  // May be empty: no question in the reel.
  questions: QuestionChoice[];
  big_words: BigWordChoice[];
  visuals: VisualChoice[];
  transitions: TransitionChoice[];
  word_fixes: WordFix[];
  // None (null or left out): no hook.
  hook?: HookChoice | null;
}

// The overlay id prefix of a QUESTION (`question-1`, ...): an accent overlay.
export const QUESTION_PREFIX = "question-";

// The ids from `from` to `to`, in transcript order.
function range(from: string, to: string, transcript: Transcript): string[] {
  const ids = transcript.words.map((word) => word.id);
  return ids.slice(ids.indexOf(from), ids.indexOf(to) + 1);
}

// The current version's choices in the engine input's terms (what Claude is
// shown and starts from): each item by the words under it. An item no word is
// spoken under is left out. A transition reads back from its own words, its
// key phrase from its key word. A VISUAL reads back with its description. The
// hook reads back as its text (null when the version has none).
export function choicesOf(edit: Edit, transcript: Transcript, preset: Preset): EngineInput {
  const resolved = resolveTimeline(edit, transcript);
  // The words under an item: from its start word to its end word when it is
  // anchored on words, else the words spoken while it shows.
  const under = (item: { id: string; start: Anchor; end: Anchor }): string[] => {
    const span = resolved.get(item.id)!;
    const spoken = transcript.words
      .filter((word) => word.start < span.end && word.end > span.start)
      .map((word) => word.id);
    const from = "word" in item.start ? item.start.word : spoken[0];
    const to = "word" in item.end ? item.end.word : spoken.at(-1);
    return from === undefined || to === undefined ? [] : range(from, to, transcript);
  };
  const ends = (ids: readonly string[]) => ({ from: ids[0]!, to: ids.at(-1)! });

  const accents: AccentChoice[] = [];
  const questions: QuestionChoice[] = [];
  let hook: HookChoice | null = null;
  for (const overlay of edit.tracks.overlays) {
    if (overlay.kind === "hook") {
      if (overlay.text) hook = { text: overlay.text };
      continue;
    }
    const ids = overlay.words ?? under(overlay);
    if (ids.length === 0) continue;
    // A QUESTION is an accent overlay with a `question-` id.
    if (overlay.id.startsWith(QUESTION_PREFIX)) questions.push(ends(ids));
    else accents.push(ends(ids));
  }
  const transitions: TransitionChoice[] = [];
  for (const transition of edit.tracks.transitions) {
    transitions.push({
      kind: transition.type,
      ...ends(transition.words),
      key_from: transition.key ?? transition.words[0]!,
    });
  }
  const visuals: VisualChoice[] = [];
  const bigWords: BigWordChoice[] = [];
  const byId = new Map(transcript.words.map((word) => [word.id, word]));
  for (const item of edit.tracks.behind ?? []) {
    const ids = under(item);
    if (ids.length === 0) continue;
    if (item.kind === "visual") {
      const { description } = item;
      visuals.push({ ...ends(ids), ...(description ? { description } : {}) });
    } else if (item.kind === "word") {
      // The stored text is one or two words joined by a space; the span starts
      // on the first word that reads as its first part, else on the first word.
      const parts = item.text.toLowerCase().split(" ");
      const readsAs = (index: number, part: string) =>
        cleanWord(byId.get(ids[index]!)!.text, preset).toLowerCase() === part;
      const found = ids.findIndex(
        (_, index) =>
          readsAs(index, parts[0]!) &&
          (parts.length === 1 || (index + 1 < ids.length && readsAs(index + 1, parts[1]!))),
      );
      const at = Math.max(0, found);
      bigWords.push({ from: ids[at]!, to: ids[Math.min(at + parts.length - 1, ids.length - 1)]! });
    }
  }
  const word_fixes: WordFix[] = [];
  for (const caption of edit.tracks.captions) {
    if (
      caption.text !== undefined &&
      caption.text !== wordsText(caption.words, transcript, preset)
    ) {
      word_fixes.push({ word: caption.words[0]!, text: caption.text });
    }
  }
  return { accents, questions, big_words: bigWords, visuals, transitions, word_fixes, hook };
}
