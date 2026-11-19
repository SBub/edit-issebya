// THE WORD-BY-WORD REVEAL: a text builds up on screen word by word, each word
// cutting in at the moment it is spoken. Every word is in its final place from
// the start, hidden, so the lines never reflow. The entrance of every QUESTION
// (`question.ts`), of every accent and of
// every caption. Pure helpers shared by the builder (each word's moment) and
// the specs (what is on screen at a time), so both always agree.

// One shown word of a text and the moment it appears.
export interface RevealWord {
  text: string;
  at: number;
}

// Each shown word of a text with the moment it appears: the start of its
// spoken word, never before the text's own start nor after its end, and
// never before the word shown before it. `text` is the text on screen,
// `spoken` its spoken words in order, `span` its time on screen. The first
// word comes in as the text starts (a text that starts after its first word
// was said shows it at once). A text with another word count than its spoken
// words (a word fix that joins or splits words) spreads its words over the
// spoken ones in order.
export function wordReveal(
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

// The text as far as it is built at `time`: the words that have appeared,
// joined as the screen shows them. Empty before the first word.
export function revealShownAt(reveal: readonly RevealWord[], time: number): string {
  return reveal
    .filter((word) => word.at <= time)
    .map((word) => word.text)
    .join(" ");
}
