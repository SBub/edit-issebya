import {
  type Edit,
  type EditMask,
  type EditRef,
  ISSEBYA_PRESET,
  type Transcript,
  maskSpans,
} from "@edit-issebya/edit";
import { cacheKey, fingerprint } from "../pipeline/fingerprint.ts";
import { MASK_TOOL_VERSION } from "./mask-tool.ts";
import { MATTE_SETTINGS } from "./matte.ts";

// The on-demand cut-out step and its one output: the person mask of one
// padded span of a behind item.
export const MASK_STEP = "cutout";
const MASK_FILE = "mask.mp4";

// What a mask depends on: the footage (by its producer), the span and how it
// is made (MODNet's model hash, working size, smoothing, provider, format,
// and the tool's code version). A new span, new footage, a new setting or a
// new tool version is a new mask; the same span of the same footage is reused
// by every later version.
export function maskFingerprint(footage: EditRef, span: { start: number; end: number }): string {
  return fingerprint({
    inputs: [{ step: footage.step, fingerprint: footage.fingerprint, file: footage.file }],
    settings: { start: span.start, end: span.end, ...MATTE_SETTINGS },
    version: MASK_TOOL_VERSION,
  });
}

// `${prefix}cache/cutout/<fingerprint>/mask.mp4`.
export function cutoutKey(prefix: string, fp: string): string {
  return cacheKey(prefix, MASK_STEP, fp, MASK_FILE);
}

// The masks an edit's behind items need, by fingerprint, before any of them
// is made: the same spans the builder draws and ensureCutouts makes. An edit
// without behind items gets none.
export function plannedMasks(edit: Edit, transcript: Transcript): EditMask[] {
  return maskSpans(edit, transcript, ISSEBYA_PRESET).map(({ start, end }) => ({
    step: MASK_STEP,
    fingerprint: maskFingerprint(edit.inputs.footage, { start, end }),
    file: MASK_FILE,
    start,
    end,
  }));
}

// The edit naming its planned masks (none when every item is a photo in
// front of the speaker) and its photos (sorted), or neither without
// behind-track items: what a saved version's inputs say.
export function withMasks(edit: Edit, transcript: Transcript): Edit {
  const inputs = { ...edit.inputs };
  delete inputs.masks;
  delete inputs.photos;
  const items = edit.tracks.behind ?? [];
  if (items.length === 0) return { ...edit, inputs };
  const photos = [
    ...new Set(items.flatMap((item) => (item.kind === "photo" ? [item.photo_id] : []))),
  ].sort();
  // Photos in front of the speaker only: no mask at all.
  const masks = plannedMasks(edit, transcript);
  return { ...edit, inputs: { ...inputs, ...(masks.length > 0 ? { masks } : {}), photos } };
}
