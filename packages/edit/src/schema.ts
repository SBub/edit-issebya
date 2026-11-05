import { z } from "zod";
import type { Box } from "./head-track.ts";
import { BEHIND_SPOTS, FONT_KEYS, type Preset, SOUND_KEYS, TRANSITION_TYPES } from "./preset.ts";
import { resolveAnchor } from "./timeline.ts";
import type { Transcript, Word } from "./transcript.ts";

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

// The overlay kinds: `accent` (words spoken), `hook` (the one written line at
// the start of the reel, the only text on screen nobody says). Versions saved
// before the hook have accents only.
const OVERLAY_KINDS = ["accent", "hook"] as const;

// Why a library photo sits behind its sentence: `match`, it shows what the
// sentence says; `mood`, it fits the reel's feel and catches the eye without
// showing what is said (never contradicting it).
export const PHOTO_REASONS = ["match", "mood"] as const;
export type PhotoReason = (typeof PHOTO_REASONS)[number];

// Where a library photo sits: `behind` the speaker (the cut-out composite,
// the person on top) or in `front` of them (over the footage, no cut-out).
// A photo without one (every version saved before it) is behind.
export const PHOTO_LAYERS = ["behind", "front"] as const;
export type PhotoLayer = (typeof PHOTO_LAYERS)[number];

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
  // The decide limit: a photo lasts the preset's `behind.minSeconds` to
  // `maxSeconds`, a big word the accent's timing (at least `minSeconds`, at
  // most from the lead before its word to `afterSeconds` after it). Stored
  // versions parse without it, so a version saved under older lengths still
  // renders.
  behindLengths?: boolean;
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
    // Legacy: a soft shadow the layout engine added for contrast (two preset
    // levels) before 2026-11-04. Kept so older versions parse and render
    // unchanged; the engine never writes it on a new version.
    shadow: shadowLevel.optional(),
  };
  const clip = z.object({
    ...base,
    hidden: z.array(z.object({ start: anchor, end: anchor })).optional(),
  });
  const caption = z.object({
    ...base,
    words: z.array(wordId).min(1),
    ...textProps,
    // The accent or big word (its id) showing this caption's words while it
    // would show: the layout engine leaves the caption out then, so no word is
    // on screen twice. A version saved before it has none.
    hidden_by: z.string().regex(ITEM_ID).optional(),
  });
  // An accent (spoken words), or the written hook (Claude's own line at the
  // start, never spoken: `text` only, no words).
  const overlay = z.object({
    ...base,
    kind: z.enum(OVERLAY_KINDS),
    words: z.array(wordId).min(1).optional(),
    ...textProps,
  });
  // One text level inside a transition's layer, placed by the engine: shown
  // whole from its `start` until the layer leaves.
  const level = z.object({
    text: z.string().min(1).max(300),
    start: anchor,
    position: textProps.position.unwrap(),
    size: z.number().int().min(8).max(400),
    break_after: textProps.break_after,
  });
  const transition = z.object({
    ...base,
    type: z.enum(TRANSITION_TYPES),
    // Replaces the preset's layer colour.
    color: z.string().regex(COLOR).optional(),
    // Written by the layout engine; a version saved before it has none. The
    // phrase it carries (word ids), its key phrase's first word, the motion
    // asked slower, the hold asked longer, its number in a list.
    words: z.array(wordId).min(1).optional(),
    key: wordId.optional(),
    pace: z.literal("slow").optional(),
    hold: z.literal("long").optional(),
    number: z.number().int().min(1).max(99).optional(),
    // The phrase's text inside the layer: the number (`numbered`), the
    // lead-in in caption text, the key phrase in accent text.
    levels: z.object({ number: level.optional(), lead: level.optional(), key: level }).optional(),
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
    z.object({
      ...base,
      kind: z.literal("photo"),
      photo_id: photoId,
      spot: z.enum(BEHIND_SPOTS),
      // Why the editor put it there; a version saved before it has none.
      reason: z.enum(PHOTO_REASONS).optional(),
      // Behind or in front of the speaker; absent: behind.
      layer: z.enum(PHOTO_LAYERS).optional(),
      // Where the layout engine set it (its top left corner, width and
      // height in the frame); absent: it covers its spot exactly.
      box: z
        .object({
          x: z.number().int().min(0).max(preset.frame.width),
          y: z.number().int().min(0).max(preset.frame.height),
          width: z.number().int().min(1).max(preset.frame.width),
          height: z.number().int().min(1).max(preset.frame.height),
        })
        .optional(),
    }),
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
    // Library photos and big words behind the speaker; stored versions
    // without it parse, and the builder reads it as empty.
    behind: z.array(behind).optional(),
  });
}

type Tracks = z.infer<ReturnType<typeof tracksSchemaFor>>;

const SLACK = 1e-6;

// What the JSON Schema cannot say: every id once, no item ending before it
// starts, an overlay showing words or text, at most one hook, with its own
// text and no words, a caption hidden only by an accent or a big word (never
// the hook, which nobody says), and a behind item never at the
// same time as another one or as a hidden stretch of footage (and, with the
// decide limit, lasting its kind's length).
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
  // The hook is written, never spoken: its own text and no words, at most one.
  const hooks = edit.tracks.overlays.filter((item) => item.kind === "hook");
  for (const item of hooks) {
    if (!item.text || item.words) {
      ctx.addIssue({
        code: "custom",
        message: `hook ${item.id}: a hook has its own text and no words`,
      });
    }
  }
  if (hooks.length > 1) {
    ctx.addIssue({ code: "custom", message: `hook ${hooks[1]!.id}: only one hook per reel` });
  }
  const showers = new Set([
    ...edit.tracks.overlays.flatMap((item) => (item.kind === "accent" ? [item.id] : [])),
    ...(edit.tracks.behind ?? []).flatMap((item) => (item.kind === "word" ? [item.id] : [])),
  ]);
  for (const item of edit.tracks.captions) {
    if (item.hidden_by !== undefined && !showers.has(item.hidden_by)) {
      ctx.addIssue({
        code: "custom",
        message: `caption ${item.id}: hidden by ${item.hidden_by}, which is no accent or big word`,
      });
    }
  }
  for (const item of edit.tracks.transitions) {
    if (item.key !== undefined && !(item.words ?? []).includes(item.key)) {
      ctx.addIssue({
        code: "custom",
        message: `transition ${item.id}: its key phrase starts on ${item.key}, outside its words`,
      });
    }
    if (item.levels && !item.words) {
      ctx.addIssue({ code: "custom", message: `transition ${item.id}: levels without words` });
    }
    if (item.levels?.number && item.type !== "numbered") {
      ctx.addIssue({
        code: "custom",
        message: `transition ${item.id}: a number level on a ${item.type} transition`,
      });
    }
  }
  refineBehind(edit, transcript, preset, limits, ctx);
}

// The behind track's own rules (length with the decide limit, one at a time,
// clear of hidden footage).
function refineBehind(
  edit: { duration: number; tracks: Tracks },
  transcript: Transcript,
  preset: Preset,
  limits: EditLimits,
  ctx: z.RefinementCtx,
): void {
  const words = new Map(transcript.words.map((word) => [word.id, word]));
  const spans = (edit.tracks.behind ?? []).map((item) => ({
    item,
    id: item.id,
    start: resolveAnchor(item.start, words, edit.duration),
    end: resolveAnchor(item.end, words, edit.duration),
  }));
  for (const span of limits.behindLengths ? spans : []) {
    const length = span.end - span.start;
    const [min, max] = behindLength(span.item, words, preset);
    if (length < min - SLACK || length > max + SLACK) {
      ctx.addIssue({
        code: "custom",
        message: `behind ${span.id}: lasts ${length.toFixed(3)} s, must be ${min} to ${Number(max.toFixed(3))} s`,
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

// The shortest and longest a new behind item may show, in seconds: a photo
// the behind lengths; a big word the accent's timing, at least its minimum
// and at most from the lead before its word to `afterSeconds` after it (a
// longer word holds longer; one cut short by the next extra stays above the
// minimum).
function behindLength(
  item: { kind: "photo" | "word"; start: Anchor },
  words: ReadonlyMap<string, Word>,
  preset: Preset,
): [number, number] {
  if (item.kind === "photo") return [preset.behind.minSeconds, preset.behind.maxSeconds];
  const { minSeconds, afterSeconds, leadSeconds } = preset.accent;
  const said = "word" in item.start ? words.get(item.start.word) : undefined;
  const longest = said ? leadSeconds + (said.end - said.start) + afterSeconds : minSeconds;
  return [minSeconds, Math.max(minSeconds, longest)];
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
export type TransitionLevels = NonNullable<TransitionItem["levels"]>;
export type TransitionLevel = TransitionLevels["key"];
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
