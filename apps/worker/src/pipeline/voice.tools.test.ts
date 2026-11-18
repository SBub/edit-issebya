import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptSchema } from "@edit-issebya/edit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { transcriptJson } from "./retime.ts";
import { REAL_TOOLS, realTool } from "./tools-test-support.ts";
import { parseVoice, voiceArgs } from "./voice.ts";

// The voice's measure with the real ffmpeg, on the committed retimed clips:
// what retime stores in its transcript, and what the committed fixture
// transcripts hold (they were written by this very measure).
const FIXTURES = new URL("../../../../fixtures/pipeline/", import.meta.url).pathname;
const CLIPS = [
  { clip: "short-speech", folder: join(FIXTURES, "retime"), seconds: 2.667 },
  { clip: "speech-ten", folder: join(FIXTURES, "speech-ten/retime"), seconds: 9.533 },
];

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "voice-tools-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe.each(CLIPS)("the measured voice of $clip", ({ clip, folder, seconds }) => {
  it("is a level and a peak for every 0.1 s of the retimed sound, as its fixture transcript holds", async () => {
    const print = `${clip}.txt`;
    await realTool({
      file: REAL_TOOLS.ffmpeg,
      args: voiceArgs(join(folder, "source.mp4"), print),
      cwd: dir,
      ignoreStdout: true,
    });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- inside the test's temp folder
    const voice = parseVoice(await readFile(join(dir, print), "utf8"));
    expect(voice.windowSeconds).toBe(0.1);
    expect(voice.levels).toHaveLength(Math.ceil(seconds * 10));
    expect(voice.peaks).toHaveLength(voice.levels.length);
    for (const [index, level] of voice.levels.entries()) {
      // A window's peak is never under its level, and never over full scale here.
      expect(voice.peaks[index]!).toBeGreaterThanOrEqual(level);
      expect(voice.peaks[index]!).toBeLessThanOrEqual(0);
    }
    // Speech: some window is louder than -25 dBFS.
    expect(Math.max(...voice.levels)).toBeGreaterThan(-25);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed fixture
    const stored = await readFile(join(folder, "transcript.json"), "utf8");
    const transcript = transcriptSchema.parse(JSON.parse(stored));
    expect(transcript.voice).toEqual(voice);
    // Byte for byte what retime writes for these words and this voice.
    expect(transcriptJson({ words: transcript.words, voice })).toBe(stored);
  });
});
