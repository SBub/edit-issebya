// The footage the studio takes, and what the owner reads when a clip is
// refused: one place for the limits and the messages (app_docs/failures.md).
export const FOOTAGE_LIMITS = { maxDurationSeconds: 90 };

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

// A clip's length in words, rounded up to whole seconds: `1 minute 30
// seconds`, `2 minutes 10 seconds`, `45 seconds`.
export function formatClipLength(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  const parts: string[] = [];
  if (minutes > 0) parts.push(plural(minutes, "minute"));
  if (rest > 0 || minutes === 0) parts.push(plural(rest, "second"));
  return parts.join(" ");
}

export const FOOTAGE_MESSAGES = {
  notVideo: "This file is not a video the studio can read.",
  noSound: "This clip has no sound; the studio needs the voice.",
  notVertical: (shape: "landscape" | "square", width: number, height: number) =>
    `This clip is ${shape} (${width} x ${height}); the studio takes vertical footage only.`,
  tooLong: (seconds: number) =>
    `This clip is ${formatClipLength(seconds)}; the studio takes up to ${formatClipLength(
      FOOTAGE_LIMITS.maxDurationSeconds,
    )}.`,
};
