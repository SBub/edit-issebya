import type { AnswerField, Placed, ReadBackContext } from "./component-defs/answer.ts";
import { COMPONENTS, COMPONENT_LIST } from "./component-defs/index.ts";
import { type Preset, wordsText } from "./preset.ts";
import type { Anchor, Edit } from "./schema.ts";
import { resolveTimeline } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";

// THE LAYOUT ENGINE'S INPUT. Claude (the decide step) answers in meaning only:
// which words are accents, which words are questions the speaker puts to the
// viewer, which words are big words behind, which words a VISUAL sits on (an
// empty frame, with a short description of what it would show), which phrases
// form each LIST (a numbered list, its items each over its phrase), which
// misheard words to fix, and one short written hook line for the start.
// Everything refers to the transcript by word id; there
// are no times, positions, sizes or spots. The layout engine (`engine.ts`,
// `placeEdit`) turns it into placed tracks.

export interface AccentChoice {
  from: string;
  to: string;
  // Set by the engine on a QUESTION (its overlay id is `question-N`): placed
  // and timed like an accent, shown with its own look (`question.ts`); never
  // in an answer.
  question?: boolean;
}

// A QUESTION: a question the speaker puts to the viewer over the words `from`
// to `to`, often rhetorical. It is placed and timed as an ACCENT and shown
// with its own look (`question.ts`): word by word, a question mark at its end.
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

// A LIST item carries the phrase `from` to `to`; its key phrase (in accent
// text) starts on `key_from`, the words before it are the lead-in.
export interface TransitionChoice {
  from: string;
  to: string;
  key_from: string;
}

// A LIST: its items in order. Its items number 1, 2, ... within the list when
// it has more than one item; a one-item list shows no number.
export interface ListChoice {
  items: TransitionChoice[];
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

// The answer's lists, one field per component that has an `answer` (`component-defs/`): its
// field name and the type of its picks come from the class.
type AnswerFields<R> = {
  [
    K in keyof R as R[K] extends { answer: AnswerField<infer F, unknown> } ? F : never
  ]: R[K] extends { answer: AnswerField<string, infer Item> } ? Item[] : never;
};

export type EngineInput = AnswerFields<typeof COMPONENTS> & {
  word_fixes: WordFix[];
  // None (null or left out): no hook.
  hook?: HookChoice | null;
};

// An answer with no pick: every list empty, no hook. The lists come from the components, in the
// order of `COMPONENTS`, then `word_fixes`.
export function emptyAnswer(): Omit<EngineInput, "hook"> {
  const answer: Record<string, unknown[]> = {};
  for (const component of COMPONENT_LIST) {
    if (component.answer) answer[component.answer.field] = component.answer.empty();
  }
  answer.word_fixes = [];
  return answer as Omit<EngineInput, "hook">;
}

// The ids from `from` to `to`, in transcript order.
function range(from: string, to: string, transcript: Transcript): string[] {
  const ids = transcript.words.map((word) => word.id);
  return ids.slice(ids.indexOf(from), ids.indexOf(to) + 1);
}

// The current version's choices in the engine input's terms (what Claude is
// shown and starts from): each item by the words under it. An item no word is
// spoken under is left out. A LIST item reads back from its own words, its key
// phrase from its key word, and the items placed in one list (the same `list`
// number) read back as one list in reel order; a placed item with no `list`
// reads back as a list of its own. A VISUAL reads back with its description.
// The hook reads back as its text (null when the version has none).
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
  const context: ReadBackContext = { transcript, preset, under, ends };

  // Each component reads back the stored items it owns; the hook is not one of the lists.
  const choices: Record<string, unknown> = { ...emptyAnswer() };
  for (const component of COMPONENT_LIST) {
    if (!component.answer) continue;
    const stored = (edit.tracks[component.stored.track] ?? []) as Placed[];
    choices[component.answer.field] = component.readBack(
      stored.filter((item) => component.owns(item)),
      context,
    );
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
  const hook = COMPONENTS.HOOK.readBack(
    edit.tracks.overlays.filter((item) => COMPONENTS.HOOK.owns(item)),
  ).at(-1);
  return { ...choices, word_fixes, hook: hook ?? null } as EngineInput;
}
