// The last lines of an error's message and stack, short enough for a row.
export function errorTail(
  error: unknown,
  { lines = 20, chars = 2000 }: { lines?: number; chars?: number } = {},
): string {
  let text: string;
  if (error instanceof Error) {
    text = error.stack?.includes(error.message)
      ? error.stack
      : `${error.message}\n${error.stack ?? ""}`;
  } else {
    text = String(error);
  }
  const tail = text.trimEnd().split("\n").slice(-lines).join("\n");
  return tail.length > chars ? tail.slice(-chars) : tail;
}

// The error's message without its stack, for the worker's one log line: the
// first line (a failed tool's `<step> exited with <code>`), then the last
// `lines` lines after it (the tool's stderr), the rest cut to `chars`.
export function failureReason(
  error: unknown,
  { lines = 20, chars = 2000 }: { lines?: number; chars?: number } = {},
): string {
  const text = (error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    .replace(/\r\n/g, "\n")
    .trimEnd();
  const [head = "", ...rest] = text.split("\n");
  const shown = rest
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-lines);
  let tail = shown.join("\n");
  if (tail.length > chars) tail = tail.slice(-chars);
  return tail ? `${head}\n${tail}` : head;
}
