import type { ChildProcess } from "node:child_process";
import { once } from "node:events";

// For the worker's own entries (the cut-out's MODNet entry, the head track's
// U2Net entry) and the ffmpeg processes they start themselves.

// A child's stderr, kept for the failure line: its last line.
export function stderrOf(child: ChildProcess): () => string {
  let text = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    text = (text + chunk.toString("utf8")).slice(-4096);
  });
  return () => text.trim().split("\n").at(-1) ?? "";
}

export function exited(child: ChildProcess): Promise<number | null> {
  return once(child, "close").then(([code]) => code as number | null);
}
