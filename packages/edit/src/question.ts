// THE QUESTION'S LOOK (`question/word-by-word`): the question builds up on
// screen word by word, each word appearing as it is spoken, and ends with a
// question mark that comes in with the last word (the mark is part of the last
// shown word). Pure helpers shared by the layout engine (the text it measures
// and places) and the builder (the text it draws), so both always agree. The
// reveal itself is `reveal.ts`.

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
