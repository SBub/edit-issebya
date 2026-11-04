import { z } from "zod";
import type { Box } from "./head-track.ts";
import { BEHIND_SPOTS, FONT_KEYS, type Preset, SOUND_KEYS, TRANSITION_TYPES } from "./preset.ts";
import { resolveAnchor } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";

// The edit format (`edit.json`, format 1). Every item starts and ends on an
// anchor: a word (its start or end edge, plus a small nudge), a time in
// seconds (only where nobody speaks) or the reel's start or end. Items follow
// their words through a re-time because anchors are resolved at every build.

const ITEM_ID = /^[a-z][a-z0-9-]{0,63}$/;
const COLOR = /^#[0-9A-Fa-f]{6}$/;
const STYLE_KEY = /^[a-z-]{1,40}$/;
// No way out of the style attribute: no declaration end, block, tag,
// backslash escape or external resource.
const STYLE_VALUE = /^[^;{}<>\\]{0,200}$/;

const refSchema = z.object({
  step: z.string().min(1),
  fingerprint: z.string().min(1),
  file: z.string().min(1),
});

// One stored person mask (the `cutout` step's `mask.mp4`) and the span of the
// reel it covers, in seconds.
const maskRefSchema = refSchema.extend({
  step: z.literal("cutout"),
  start: z.number().min(0),
  end: z.number().positive(),
});

const editInputsSchema = z.object({
  footage: refSchema,
  transcript: refSchema,
  // The whole-clip cut-out is never written since it left the pipeline; a
  // stored version naming one still parses.
  cutout: refSchema.optional(),
  head_track: refSchema,
  // The masks of the behind items' padded spans and the library photos the
  // behind track names, filled by the worker before the version is saved.
  masks: z.array(maskRefSchema).optional(),
  photos: z.array(z.uuid()).optional(),
});

// A big word behind the speaker: one word, nothing that could leave its tag.
export const BEHIND_WORD = /^[^\s<>&]{1,24}$/;

// The free custom-style field: CSS property to value, added to the element.
const styleSchema = z.record(
  z.string().regex(STYLE_KEY),
  z
    .string()
    .regex(STYLE_VALUE)
    .refine((value) => !/url\s*\(/i.test(value), { message: "url() is not allowed" }),
);

// Optional limits on top of the format's own: `duration` caps `{ time }`
// anchors, `bounds` keeps every set position inside a box. Stored versions
// parse without them (frame-wide positions, any time); the decide answer
// carries them.
// `photoIds` limits the behind track's photos to these library photos (the
// owner's ready ones); without it any photo id parses.
export interface EditLimits {
  duration?: number;
  bounds?: Box;
  photoIds?: readonly string[];
  // The decide limits: at most this many photos and big words behind the
  // speaker. Stored versions parse without them.
  behindCounts?: { photos: number; words: number };
}

// The six tracks, built per reel: the word ids are the transcript's, the
// fonts the preset's, so an unknown word or font is refused by the schema
// itself. No refinement, so it converts to JSON Schema as is.
function tracksSchemaFor(preset: Preset, transcript: Transcript, limits: EditLimits = {}) {
  const ids = transcript.words.map((word) => word.id);
  const wordId = ids.length > 0 ? z.enum(ids as [string, ...string[]]) : z.never();
  const time =
    limits.duration === undefined ? z.number().min(0) : z.number().min(0).max(limits.duration);
  const bounds = limits.bounds ?? {
    left: 0,
    right: preset.frame.width,
    top: 0,
    bottom: preset.frame.height,
  };
  const anchor = z.union([
    z.object({
      word: wordId,
      edge: z.enum(["start", "end"]).optional(),
      offset: z.number().min(-1).max(1).optional(),
    }),
    z.object({ time }),
    z.object({ reel: z.enum(["start", "end"]) }),
  ]);
  const base = {
    id: z.string().regex(ITEM_ID),
    start: anchor,
    end: anchor,
    style: styleSchema.optional(),
  };
  const shadowLevel = z.union([z.literal(1), z.literal(2)]);
  const textProps = {
    text: z.string().min(1).max(200).optional(),
    font: z.enum(FONT_KEYS).optional(),
    size: z.number().int().min(8).max(400).optional(),
    color: z.string().regex(COLOR).optional(),
    position: z
      .object({
        x: z.number().min(bounds.left).max(bounds.right),
        y: z.number().min(bounds.top).max(bounds.bottom),
        align: z.enum(["left", "right", "center"]),
      })
      .optional(),
    // Set in two lines: this many words of the text on the first.
    break_after: z.number().int().min(1).max(60).optional(),
    // A soft shadow the layout engine added for contrast (two preset levels);
    // the text's colour is never changed for it.
    shadow: shadowLevel.optional(),
  };
  const clip = z.object({
    ...base,
    hidden: z.array(z.object({ start: anchor, end: anchor })).optional(),
  });
  const caption = z.object({ ...base, words: z.array(wordId).min(1), ...textProps });
  const overlay = z.object({
    ...base,
    kind: z.literal("accent"),
    words: z.array(wordId).min(1).optional(),
    ...textProps,
  });
  const transition = z.object({
    ...base,
    type: z.enum(TRANSITION_TYPES),
    // Replaces the preset's layer colour.
    color: z.string().regex(COLOR).optional(),
  });
  const sound = z.object({
    ...base,
    sound: z.enum(SOUND_KEYS),
    gain_db: z.number().min(-60).max(12).optional(),
  });
  const photoId =
    limits.photoIds === undefined
      ? z.uuid()
      : limits.photoIds.length > 0
        ? z.enum(limits.photoIds as [string, ...string[]])
        : z.never();
  const behind = z.discriminatedUnion("kind", [
    z.object({ ...base, kind: z.literal("photo"), photo_id: photoId, spot: z.enum(BEHIND_SPOTS) }),
    z.object({
      ...base,
      kind: z.literal("word"),
      text: z.string().regex(BEHIND_WORD),
      // Where the layout engine set it (its top left corner in the frame) and
      // at what size; a version saved before the engine has neither.
      position: z
        .object({
          x: z.number().min(0).max(preset.frame.width),
          y: z.number().min(0).max(preset.frame.height),
        })
        .optional(),
      size: z.number().int().min(8).max(400).optional(),
      shadow: shadowLevel.optional(),
    }),
  ]);
  return z.object({
    footage: z.array(clip),
    // Stored versions may carry it; new ones omit it and the builder ignores it.
    cutout: z.array(clip).optional(),
    captions: z.array(caption),
    overlays: z.array(overlay),
    transitions: z.array(transition),
    sounds: z.array(sound),
    // A library photo or one big word behind the speaker; stored versions
    // without it parse, and the builder reads it as empty.
    behind: (limits.behindCounts === undefined
      ? z.array(behind)
      : z.array(behind).max(limits.behindCounts.photos + limits.behindCounts.words)
    ).optional(),
  });
}

type Tracks = z.infer<ReturnType<typeof tracksSchemaFor>>;

const SLACK = 1e-6;

// What the JSON Schema cannot say: every id once, no item ending before it
// starts, an overlay showing words or text, and a behind item lasting the
// preset's 2 to 4 seconds, never at the same time as another one or as a
// hidden stretch of footage.
function refineEdit(
  edit: { duration: number; tracks: Tracks },
  transcript: Transcript,
  preset: Preset,
  limits: EditLimits,
  ctx: z.RefinementCtx,
): void {
  const words = new Map(transcript.words.map((word) => [word.id, word]));
  const seen = new Set<string>();
  const items = [
    ...edit.tracks.footage.map((item) => ["footage", item] as const),
    ...(edit.tracks.cutout ?? []).map((item) => ["cutout", item] as const),
    ...edit.tracks.captions.map((item) => ["caption", item] as const),
    ...edit.tracks.overlays.map((item) => ["overlay", item] as const),
    ...edit.tracks.transitions.map((item) => ["transition", item] as const),
    ...edit.tracks.sounds.map((item) => ["sound", item] as const),
    ...(edit.tracks.behind ?? []).map((item) => ["behind", item] as const),
  ];
  for (const [kind, item] of items) {
    if (seen.has(item.id)) {
      ctx.addIssue({ code: "custom", message: `${kind} ${item.id}: id used twice` });
    }
    seen.add(item.id);
    const start = resolveAnchor(item.start, words, edit.duration);
    const end = resolveAnchor(item.end, words, edit.duration);
    if (end < start) {
      ctx.addIssue({
        code: "custom",
        message: `${kind} ${item.id}: ends (${end.toFixed(3)} s) before it starts (${start.toFixed(3)} s)`,
      });
    }
    if (kind === "overlay" && !("text" in item && item.text) && !("words" in item && item.words)) {
      ctx.addIssue({ code: "custom", message: `overlay ${item.id}: needs words or text` });
    }
  }
  refineBehind(edit, transcript, preset, limits, ctx);
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];

function ordinal(n: number): string {
  return ORDINALS[n - 1] ?? `${n}th`;
}

// The behind track's own rules (counts with the decide limits, length, one at
// a time, clear of hidden footage).
function refineBehind(
  edit: { duration: number; tracks: Tracks },
  transcript: Transcript,
  preset: Preset,
  limits: EditLimits,
  ctx: z.RefinementCtx,
): void {
  const words = new Map(transcript.words.map((word) => [word.id, word]));
  if (limits.behindCounts) {
    const { photos, words: bigWords } = limits.behindCounts;
    let photoCount = 0;
    let wordCount = 0;
    for (const item of edit.tracks.behind ?? []) {
      if (item.kind === "photo") {
        photoCount += 1;
        if (photoCount > photos) {
          ctx.addIssue({
            code: "custom",
            message: `behind ${item.id}: a ${ordinal(photoCount)} photo; at most ${photos} photo${photos === 1 ? "" : "s"} per reel`,
          });
        }
      } else {
        wordCount += 1;
        if (wordCount > bigWords) {
          ctx.addIssue({
            code: "custom",
            message: `behind ${item.id}: a ${ordinal(wordCount)} big word; at most ${bigWords} per reel`,
          });
        }
      }
    }
  }
  const { minSeconds, maxSeconds } = preset.behind;
  const spans = (edit.tracks.behind ?? []).map((item) => ({
    id: item.id,
    start: resolveAnchor(item.start, words, edit.duration),
    end: resolveAnchor(item.end, words, edit.duration),
  }));
  for (const span of spans) {
    const length = span.end - span.start;
    if (length < minSeconds - SLACK || length > maxSeconds + SLACK) {
      ctx.addIssue({
        code: "custom",
        message: `behind ${span.id}: lasts ${length.toFixed(3)} s, must be ${minSeconds} to ${maxSeconds} s`,
      });
    }
  }
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  for (let index = 1; index < sorted.length; index += 1) {
    const before = sorted[index - 1]!;
    const span = sorted[index]!;
    if (span.start < before.end - SLACK) {
      ctx.addIssue({
        code: "custom",
        message: `behind ${span.id}: overlaps behind ${before.id}; only one at a time`,
      });
    }
  }
  const hidden = edit.tracks.footage.flatMap((clip) =>
    (clip.hidden ?? []).map((range) => ({
      clip: clip.id,
      range: {
        start: resolveAnchor(range.start, words, edit.duration),
        end: resolveAnchor(range.end, words, edit.duration),
      },
    })),
  );
  for (const span of spans) {
    const crossing = hidden.find(
      ({ range }) => span.start < range.end - SLACK && range.start < span.end - SLACK,
    );
    if (crossing) {
      ctx.addIssue({
        code: "custom",
        message: `behind ${span.id}: overlaps a hidden span of footage ${crossing.clip}`,
      });
    }
  }
}

// The whole edit, built per reel (see tracksSchemaFor). It stays
// `z.toJSONSchema`-compatible (refinements are dropped from the JSON Schema).
export function editSchemaFor(preset: Preset, transcript: Transcript, limits: EditLimits = {}) {
  return z
    .object({
      format: z.literal(1),
      preset: z.literal(preset.id),
      duration: z.number().positive(),
      inputs: editInputsSchema,
      tracks: tracksSchemaFor(preset, transcript, limits),
    })
    .superRefine((edit, ctx) => refineEdit(edit, transcript, preset, limits, ctx));
}

export type Edit = z.infer<ReturnType<typeof editSchemaFor>>;
export type EditInputs = Edit["inputs"];
export type EditRef = EditInputs["footage"];
export type Anchor = Edit["tracks"]["captions"][number]["start"];
export type ClipItem = Edit["tracks"]["footage"][number];
export type CaptionItem = Edit["tracks"]["captions"][number];
export type OverlayItem = Edit["tracks"]["overlays"][number];
export type TransitionItem = Edit["tracks"]["transitions"][number];
export type SoundItem = Edit["tracks"]["sounds"][number];
export type BehindItem = NonNullable<Edit["tracks"]["behind"]>[number];
export type BehindPhotoItem = Extract<BehindItem, { kind: "photo" }>;
export type BehindWordItem = Extract<BehindItem, { kind: "word" }>;
export type EditMask = NonNullable<EditInputs["masks"]>[number];

// The path of an issue, as the item it names: `tracks.captions.3` becomes
// `captions[3]`.
function where(path: readonly PropertyKey[]): string {
  const parts = path.map(String);
  if (parts[0] === "tracks" && parts.length >= 3) {
    const rest = parts.slice(3).join(".");
    return `${parts[1]}[${parts[2]}]${rest ? `.${rest}` : ""}`;
  }
  return parts.join(".") || "edit";
}

export function parseEdit(
  json: unknown,
  preset: Preset,
  transcript: Transcript,
  limits: EditLimits = {},
): { ok: true; edit: Edit } | { ok: false; reasons: string[] } {
  const result = editSchemaFor(preset, transcript, limits).safeParse(json);
  if (result.success) return { ok: true, edit: result.data };
  return { ok: false, reasons: issueReasons(json, result.error.issues) };
}

// Readable reasons for a refused edit (or decide answer): the item an issue
// points into, where in it, and Zod's message.
export function issueReasons(
  json: unknown,
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): string[] {
  return issues.map((issue) => {
    const item = issueItem(json, issue.path);
    const at = where(issue.path);
    return item ? `${item} (${at}): ${issue.message}` : `${at}: ${issue.message}`;
  });
}

// The id of the item an issue's path points into, when it has one.
function issueItem(json: unknown, path: readonly PropertyKey[]): string | null {
  if (path[0] !== "tracks" || path.length < 3) return null;
  const tracks = (json as { tracks?: Record<string, unknown> } | null)?.tracks;
  const list = tracks?.[String(path[1])];
  const item = Array.isArray(list) ? (list[Number(path[2])] as { id?: unknown }) : null;
  return typeof item?.id === "string" ? `item ${item.id}` : null;
}
