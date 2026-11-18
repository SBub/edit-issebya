import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Tool } from "../step-runner.ts";
import { CLIP, REAL_TOOLS, realTool } from "./tools-test-support.ts";
import { TRANSCRIBE_SETTINGS, transcribe } from "./transcribe.ts";
import { parseTranscript } from "./transcript.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "transcribe-tools-"));
  deafDir = await mkdtemp(join(tmpdir(), "transcribe-relisten-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(deafDir, { recursive: true, force: true });
});

// The real tools on the ten-second clip of real speech ("Media has given us
// alternative ways to earn..."), except that Whisper `small` "drops" two
// words: once its call on the whole clip is done, "alternative" and "ways"
// are taken out of what it wrote. The aligner then stretches "to" over their
// sound, which is the spot. Every other call (the aligner, ffmpeg, Whisper `medium`) is untouched.
let deafDir: string;
const DROPPED = ["alternative", "ways"];
const SPEECH = new URL("../../../../fixtures/footage/speech-ten.mp4", import.meta.url).pathname;
const deafTool: Tool = async (call) => {
  const out = await realTool(call);
  const small = call.args.indexOf("--model") >= 0 && call.args.includes("small");
  if (!small) return out;
  const file = join(call.args[call.args.indexOf("--dir") + 1]!, "transcript.json");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
  const words = JSON.parse(await readFile(file, "utf8")) as { text: string }[];
  const kept = words.filter((word) => !DROPPED.includes(word.text.trim().toLowerCase()));
  expect(words.length - kept.length).toBe(DROPPED.length);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
  await writeFile(file, JSON.stringify(kept));
  return out;
};

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

  // Needs Whisper `medium` (models:fetch) beside `small`.
  it("hears two dropped words again with whisper medium and puts them back", async () => {
    const { what } = await transcribe.run({
      tool: deafTool,
      tools: REAL_TOOLS,
      dir: deafDir,
      files: { "converted.mp4": SPEECH },
      settings: TRANSCRIBE_SETTINGS,
      signal: new AbortController().signal,
    });
    const read = async (file: string) =>
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
      parseTranscript(await readFile(join(deafDir, file), "utf8")).words;
    const letters = (text: string) => text.toLowerCase().replace(/[^a-z']/g, "");
    const before = await read("aligned.json");
    const words = await read("transcript.json");
    expect(before.map((word) => letters(word.text)).join(" ")).toMatch(/has given us to earn/);
    expect(words.map((word) => letters(word.text)).join(" ")).toMatch(
      /has given us alternative ways to earn/,
    );
    expect(words).toHaveLength(before.length + 2);
    expect(words.map((word) => word.id)).toEqual(
      words.map((_, index) => `w${String(index + 1).padStart(4, "0")}`),
    );
    // The aligner timed the new list: "to" is no longer stretched over the
    // two words, which sit where its sound was.
    const at = (list: typeof words, text: string) =>
      list.find((word) => letters(word.text) === text)!;
    expect(at(before, "to").end - at(before, "to").start).toBeGreaterThan(0.5);
    expect(at(words, "to").end - at(words, "to").start).toBeLessThan(0.3);
    expect(at(words, "alternative").start).toBeGreaterThanOrEqual(at(words, "us").end);
    expect(at(words, "ways").end).toBeLessThanOrEqual(at(words, "to").start);
    expect(what).toBe(`transcribed, ${words.length} words, 1 spot re-listened, 2 words added`);
  });
});
