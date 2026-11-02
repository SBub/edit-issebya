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
