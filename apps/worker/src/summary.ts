import { formatBytes } from "./format.ts";

const TAIL_LINES = 20;
const TAIL_BYTES = 4096;

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

// Whole seconds in words, zero parts omitted; hours drop the seconds.
export function formatDuration(ms: number): string {
  if (ms < 1000) return "under a second";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(plural(hours, "hour"));
  if (minutes > 0) parts.push(plural(minutes, "minute"));
  if (seconds > 0 && hours === 0) parts.push(plural(seconds, "second"));
  return parts.join(" ");
}

// The step log's one line: `background removed, 6 minutes 47 seconds, 51.0 MB`.
export function stepSummary({
  what,
  wallMs,
  sizeBytes,
}: {
  what: string;
  wallMs: number;
  sizeBytes: number | null;
}): string {
  const parts = [what, formatDuration(wallMs)];
  if (sizeBytes !== null) parts.push(formatBytes(sizeBytes));
  return parts.join(", ");
}

// The end of a step's output: the last 20 lines, and never more than 4096
// bytes of UTF-8, cut at a line start (or else a character boundary).
export function outputTail(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const tail = lines.slice(-TAIL_LINES).join("\n");
  const bytes = Buffer.from(tail, "utf8");
  if (bytes.length <= TAIL_BYTES) return tail;
  let start = bytes.length - TAIL_BYTES;
  const newline = bytes.indexOf(0x0a, start);
  if (newline !== -1 && newline < bytes.length - 1) {
    start = newline + 1;
  } else {
    // Continuation bytes are 10xxxxxx: move forward to a character's first byte.
    while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
  }
  return bytes.subarray(start).toString("utf8");
}
