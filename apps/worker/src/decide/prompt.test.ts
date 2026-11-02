import { readFileSync } from "node:fs";
import { ISSEBYA_PRESET, headTrackSchema, parseEdit, transcriptSchema } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import { decideInput, headTrackSummary } from "./input.ts";
import { PROMPT_VERSION, decidePrompt } from "./prompt.ts";

const read = (path: string): unknown =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- committed fixtures
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

const transcript = transcriptSchema.parse(
  read("../../../../fixtures/pipeline/retime/transcript.json"),
);
const headTrack = headTrackSchema.parse(
  read("../../../../fixtures/pipeline/head_track/head-track.json"),
);
const parsed = parseEdit(
  read("../../../../packages/edit/src/testdata/versions/baseline-short-speech.edit.json"),
  ISSEBYA_PRESET,
  transcript,
);
if (!parsed.ok) throw new Error(parsed.reasons.join("; "));
const current = parsed.edit;
const input = decideInput({
  current,
  transcript,
  headTrack,
  preset: ISSEBYA_PRESET,
  request: null,
});

describe("decidePrompt", () => {
  it("is versioned", () => {
    expect(PROMPT_VERSION).toBe("decide-1");
  });

  it("carries the current version, every word id, the glossary, the safe box and no request", () => {
    const prompt = decidePrompt(input);
    expect(prompt).toContain(JSON.stringify(current, null, 2));
    for (const word of transcript.words) expect(prompt).toContain(`"id": "${word.id}"`);
    expect(prompt).toContain('"term": "lock-in"');
    const { safe } = ISSEBYA_PRESET;
    for (const n of [safe.left, safe.right, safe.top, safe.bottom]) {
      expect(prompt).toContain(String(n));
    }
    expect(prompt).toMatch(/The owner's request:\n\n\(none\)/);
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
    expect(prompt).not.toContain("refused");
  });

  it("ends with every reason on the retry", () => {
    const reasons = ["safe-box title: runs past the safe box", "glossary cw0003: write lock-in"];
    const prompt = decidePrompt(input, reasons);
    expect(prompt.trimEnd().split("\n").slice(-3)).toEqual([
      "Your previous answer was refused for these reasons. Fix them and answer again:",
      ...reasons.map((reason) => `- ${reason}`),
    ]);
  });
});

describe("headTrackSummary", () => {
  it("says the fixture clip never shows a head", () => {
    expect(headTrackSummary(headTrack)).toEqual({
      samples: headTrack.length,
      step_seconds: 0.25,
      head_present: false,
      face_box: null,
      no_head: [{ start: 0, end: headTrack.length * 0.25 }],
    });
  });

  it("lists the spans without a head and the whole-clip face", () => {
    const sample = { t: 0, head_top: 400, cx: 540, head_w: 200 };
    const summary = headTrackSummary([sample, null, null, { ...sample, t: 0.75 }]);
    expect(summary.head_present).toBe(true);
    expect(summary.no_head).toEqual([{ start: 0.25, end: 0.75 }]);
    expect(summary.face_box).not.toBeNull();
  });
});
