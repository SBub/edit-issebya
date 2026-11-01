import { type Edit, ISSEBYA, type Transcript } from "@edit-issebya/edit";
import { describe, expect, it } from "vitest";
import { PROMPT_VERSION, decidePrompt, headTrackSummary, retryPrompt } from "./prompt.ts";

const transcript: Transcript = {
  words: [
    { id: "w0001", text: "Locking", start: 0.1, end: 0.5 },
    { id: "w0002", text: "in.", start: 0.5, end: 0.9 },
  ],
};

const edit: Edit = {
  format: 1,
  inputs: {
    footage: "1".repeat(64),
    transcript: "2".repeat(64),
    cutout: "3".repeat(64),
    headTrack: "4".repeat(64),
  },
  tracks: {
    footage: [],
    cutout: [],
    captions: [
      { id: "c-w0001", start: { word: "w0001" }, end: { word: "w0001" }, text: "locking" },
    ],
    overlays: [],
    transitions: [],
    sounds: [],
  },
};

// The JSON object after `## Input`.
function inputOf(prompt: string): Record<string, unknown> {
  return JSON.parse(prompt.split("## Input\n")[1]!) as Record<string, unknown>;
}

describe("decidePrompt", () => {
  it("holds the instructions, then the reel as one JSON object", async () => {
    const prompt = await decidePrompt({
      edit,
      transcript,
      headTrack: [],
      preset: ISSEBYA,
      request: null,
    });
    expect(prompt).toMatch(/^# Edit one short vertical video/);
    const input = inputOf(prompt);
    expect(input.transcript).toEqual(transcript.words);
    expect(input.current_edit).toEqual(edit.tracks);
    expect(input.request).toBeNull();
    expect((input.preset as { glossary: unknown }).glossary).toEqual(ISSEBYA.glossary);
    expect(Object.keys(input.preset as object).sort()).toEqual([
      "colors",
      "fonts",
      "frame",
      "glossary",
      "minSoundGap",
      "safe",
      "sounds",
      "transitions",
    ]);
  });

  it("names a prompt version", () => {
    expect(PROMPT_VERSION).not.toBe("");
  });
});

describe("headTrackSummary", () => {
  it("gives one head box per half second, or null", () => {
    expect(
      headTrackSummary([
        { t: 0, head_top: 500.4, cx: 540, head_w: 300 },
        { t: 0.25, head_top: 490.6, cx: 560, head_w: 301 },
        null,
        null,
        { t: 1, head_top: 520, cx: 600, head_w: 280 },
      ]),
    ).toEqual([
      { t: 0, head: { top: 491, left: 390, right: 711 } },
      { t: 0.5, head: null },
      { t: 1, head: { top: 520, left: 460, right: 740 } },
    ]);
  });
});

describe("retryPrompt", () => {
  it("adds every reason after the first prompt", () => {
    const retry = retryPrompt("first prompt\n", [
      "title: outside the safe box (right)",
      "s2: too close",
    ]);
    expect(retry).toBe(
      "first prompt\n\n## Your previous answer failed these checks\n\n- title: outside the safe box (right)\n- s2: too close\n\nAnswer again with the full answer.\n",
    );
  });
});
