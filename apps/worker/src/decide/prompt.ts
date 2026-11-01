import { readFile } from "node:fs/promises";
import type { Edit, HeadTrack, Preset, Transcript } from "@edit-issebya/edit";
import { canonicalJson } from "../pipeline/canonical-json.ts";

// Names the prompt a version was made with. Change it in the same commit as
// any edit of prompt.md.
export const PROMPT_VERSION = "decide-1";

// The head track has one entry per 0.25 s; the prompt gets one per 0.5 s.
const SAMPLE_SECONDS = 0.25;
const WINDOW_SECONDS = 0.5;

interface HeadWindow {
  t: number;
  head: { top: number; left: number; right: number } | null;
}

// Where the head is, per half second, in whole pixels: the highest top and
// the widest extent of the window's samples, or null when none has a head.
export function headTrackSummary(headTrack: HeadTrack): HeadWindow[] {
  const perWindow = WINDOW_SECONDS / SAMPLE_SECONDS;
  const windows: HeadWindow[] = [];
  for (let start = 0; start < headTrack.length; start += perWindow) {
    const samples = headTrack.slice(start, start + perWindow).filter((sample) => sample !== null);
    windows.push({
      t: (start / perWindow) * WINDOW_SECONDS,
      head:
        samples.length === 0
          ? null
          : {
              top: Math.round(Math.min(...samples.map((s) => s.head_top))),
              left: Math.round(Math.min(...samples.map((s) => s.cx - s.head_w / 2))),
              right: Math.round(Math.max(...samples.map((s) => s.cx + s.head_w / 2))),
            },
    });
  }
  return windows;
}

// What the model needs of the preset: no file paths, no timing internals.
function presetForPrompt(preset: Preset) {
  return {
    frame: preset.frame,
    safe: preset.safe,
    fonts: Object.fromEntries(
      Object.entries(preset.fonts).map(([key, font]) => [
        key,
        { family: font.family, size: font.size },
      ]),
    ),
    colors: preset.colors,
    sounds: Object.fromEntries(
      Object.entries(preset.sounds).map(([key, sound]) => [key, { duration: sound.duration }]),
    ),
    transitions: preset.transitions,
    glossary: preset.glossary,
    minSoundGap: preset.minSoundGap,
  };
}

export interface PromptInput {
  edit: Edit;
  transcript: Transcript;
  headTrack: HeadTrack;
  preset: Preset;
  request: string | null;
}

// The committed instructions, then one canonical JSON object with the reel.
export async function decidePrompt({
  edit,
  transcript,
  headTrack,
  preset,
  request,
}: PromptInput): Promise<string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- the committed prompt beside this module
  const instructions = await readFile(new URL("./prompt.md", import.meta.url), "utf8");
  const input = canonicalJson({
    current_edit: edit.tracks,
    transcript: transcript.words.map(({ id, text, start, end }) => ({ id, text, start, end })),
    head_track: headTrackSummary(headTrack),
    preset: presetForPrompt(preset),
    request,
  });
  return `${instructions.trimEnd()}\n\n## Input\n\n${input}\n`;
}

// The first prompt again, with why the previous answer was refused.
export function retryPrompt(prompt: string, reasons: string[]): string {
  const lines = reasons.map((reason) => `- ${reason}`).join("\n");
  return `${prompt.trimEnd()}\n\n## Your previous answer failed these checks\n\n${lines}\n\nAnswer again with the full answer.\n`;
}
