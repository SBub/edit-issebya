import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLIP, REAL_TOOLS, realTool } from "./tools-test-support.ts";
import { TRANSCRIBE_SETTINGS, transcribe } from "./transcribe.ts";
import { parseTranscript } from "./transcript.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "transcribe-tools-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("transcribe with the real HyperFrames", () => {
  it("hears the clip's sentence, with ids in order", async () => {
    const { what } = await transcribe.run({
      tool: realTool,
      tools: REAL_TOOLS,
      dir,
      files: { "converted.mp4": CLIP },
      settings: TRANSCRIBE_SETTINGS,
      signal: new AbortController().signal,
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    const { words } = parseTranscript(await readFile(join(dir, "transcript.json"), "utf8"));
    const heard = words.map((word) => word.text.toLowerCase().replace(/[^a-z']/g, "")).join(" ");
    // Whisper writes the homophone "real" for "reel".
    expect(heard).toMatch(/this is a short test clip for the re[ae]l studio/);
    expect(words.map((word) => word.id)).toEqual(
      words.map((_, index) => `w${String(index + 1).padStart(4, "0")}`),
    );
    expect(what).toBe(`transcribed, ${words.length} words`);
  });
});
