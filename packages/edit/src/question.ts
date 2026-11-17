// THE QUESTION'S LOOK (`question/word-by-word`): the question builds up on
// screen word by word, each word appearing as it is spoken, and ends with a
// question mark that comes in with the last word. Pure helpers shared by the
// layout engine (the text it measures and places) and the builder (the text it
// draws and each word's moment), so both always agree.

// The overlay id prefix of a QUESTION (`question-1`, ...): an accent overlay.
export const QUESTION_PREFIX = "question-";

// True for the overlay of a QUESTION: an accent overlay with a `question-` id.
export function isQuestion(item: { id: string; kind: string }): boolean {
  return item.kind === "accent" && item.id.startsWith(QUESTION_PREFIX);
}

// The text a question shows: its words with one question mark at the end. A
// text that already ends with one keeps it, never two.
export function questionText(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.endsWith("?") ? trimmed : `${trimmed}?`;
}

// One shown word of a question and the moment it appears.
export interface RevealWord {
  text: string;
  at: number;
}

// Each shown word of a question with the moment it appears: the start of its
// spoken word, never before the question's own start nor after its end, and
// never before the word shown before it. `text` is the question's text
// (`questionText`), `spoken` its spoken words in order, `span` its time on
// screen. The first word comes in as the question starts, and the question
// mark is part of the last word, so it appears with it. A text with another
// word count than its spoken words (a word fix that joins or splits words)
// spreads its words over the spoken ones in order.
export function questionReveal(
  text: string,
  spoken: readonly { start: number }[],
  span: { start: number; end: number },
): RevealWord[] {
  const shown = text.split(" ");
  let last = span.start;
  return shown.map((word, index) => {
    const said =
      spoken.length === 0
        ? undefined
        : spoken[
            shown.length === spoken.length
              ? index
              : Math.floor((index * spoken.length) / shown.length)
          ];
    const at = index === 0 || !said ? last : Math.min(Math.max(said.start, last), span.end);
    last = at;
    return { text: word, at };
  });
}

// The question as far as it is built at `time`: the words that have appeared,
// joined as the screen shows them. Empty before the first word.
export function questionShownAt(reveal: readonly RevealWord[], time: number): string {
  return reveal
    .filter((word) => word.at <= time)
    .map((word) => word.text)
    .join(" ");
}
