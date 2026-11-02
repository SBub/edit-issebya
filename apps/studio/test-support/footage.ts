import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

// A deterministic stand-in for phone footage: seeded pseudo-random bytes
// (xorshift32), so every run writes the same file and the same SHA-256. Only
// its size and bytes matter to the upload, never that it plays.
export async function writeFootage(
  dir: string,
  bytes = 35 * 1024 * 1024,
): Promise<{ path: string; bytes: number; sha256: string }> {
  const body = new Uint8Array(bytes);
  const words = new Uint32Array(body.buffer, 0, Math.floor(bytes / 4));
  let state = 0x9e3779b9;
  for (let i = 0; i < words.length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    words[i] = state >>> 0;
  }
  const path = join(dir, "footage-35mb.mp4");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the spec's temp dir
  await writeFile(path, body);
  return { path, bytes, sha256: createHash("sha256").update(body).digest("hex") };
}
