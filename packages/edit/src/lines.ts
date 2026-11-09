// A text's lines from its `breaks`: each break is the number of words on the
// lines before it, so a break after word n has n in it (1 to 60, ascending).
// A break past the text's last word is ignored: a text shorter than its
// breaks stays on the lines it has.
export function textLines(text: string, breaks: readonly number[] | undefined): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let from = 0;
  for (const cut of breaks ?? []) {
    if (cut >= words.length) break;
    lines.push(words.slice(from, cut).join(" "));
    from = cut;
  }
  lines.push(words.slice(from).join(" "));
  return lines;
}

// The `breaks` of a text's lines: the word count before each line break.
export function breaksOf(lines: readonly string[]): number[] {
  const breaks: number[] = [];
  let count = 0;
  for (const line of lines.slice(0, -1)) {
    count += line.split(" ").length;
    breaks.push(count);
  }
  return breaks;
}
