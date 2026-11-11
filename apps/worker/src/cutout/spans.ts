import {
  type Edit,
  type EditMask,
  type EditRef,
  type HeadTrack,
  ISSEBYA_PRESET,
  type Transcript,
  maskSpans,
} from "@edit-issebya/edit";
import { cacheKey, fingerprint } from "../pipeline/fingerprint.ts";
import { spanCropTop } from "./crop.ts";
import { MASK_TOOL_VERSION } from "./mask-tool.ts";
import { MATTE_SETTINGS } from "./matte.ts";

// The on-demand cut-out step and its one output: the person mask of one
// padded span of a behind item.
export const MASK_STEP = "cutout";
const MASK_FILE = "mask.mp4";

// What a mask depends on: the footage (by its producer), the span, the rows
// left out above the speaker (spanCropTop) and how it is made (MODNet's model
// hash, working size, crop rule, smoothing, provider, format, and the tool's
// code version). A new span, new footage, another crop, a new setting or a new
// tool version is a new mask; the same span of the same footage is reused by
// every later version.
export function maskFingerprint(
  footage: EditRef,
  span: { start: number; end: number; cropTop: number },
): string {
  return fingerprint({
    inputs: [{ step: footage.step, fingerprint: footage.fingerprint, file: footage.file }],
    settings: { start: span.start, end: span.end, cropTop: span.cropTop, ...MATTE_SETTINGS },
    version: MASK_TOOL_VERSION,
  });
}

// `${prefix}cache/cutout/<fingerprint>/mask.mp4`.
export function cutoutKey(prefix: string, fp: string): string {
  return cacheKey(prefix, MASK_STEP, fp, MASK_FILE);
}

// The masks an edit's behind items need, by fingerprint, before any of them
// is made: the same spans the builder draws and ensureCutouts makes. An edit
// without behind items gets none. Each span's crop comes from the head track
// (null: no crop).
export function plannedMasks(
  edit: Edit,
  transcript: Transcript,
  headTrack: HeadTrack | null,
): EditMask[] {
  return maskSpans(edit, transcript, ISSEBYA_PRESET).map(({ start, end }) => ({
    step: MASK_STEP,
    fingerprint: maskFingerprint(edit.inputs.footage, {
      start,
      end,
      cropTop: spanCropTop(headTrack, { start, end }),
    }),
    file: MASK_FILE,
    start,
    end,
  }));
}

// The edit naming its planned masks (none when every item is a VISUAL in front
// of the speaker), or the edit without masks when it has no behind-track
// items: what a saved version's inputs say.
export function withMasks(edit: Edit, transcript: Transcript, headTrack: HeadTrack | null): Edit {
  const inputs = { ...edit.inputs };
  delete inputs.masks;
  const items = edit.tracks.behind ?? [];
  if (items.length === 0) return { ...edit, inputs };
  const masks = plannedMasks(edit, transcript, headTrack);
  return { ...edit, inputs: { ...inputs, ...(masks.length > 0 ? { masks } : {}) } };
}
