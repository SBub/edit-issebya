import { z } from "zod";
import type { Box } from "./head-track.ts";
import {
  SHOWN_FLOOR_SECONDS,
  BEHIND_SPOTS,
  FONT_KEYS,
  type Preset,
  SOUND_KEYS,
  TRANSITION_KINDS,
} from "./preset.ts";
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
  head_track: refSchema,
  // The masks of the behind items' padded spans, filled by the worker before
  // the version is saved.
  masks: z.array(maskRefSchema).optional(),
});

// The overlay kinds: `accent` (words spoken), `hook` (the one written line at
// the start of the reel, the only text on screen nobody says).
const OVERLAY_KINDS = ["accent", "hook"] as const;

// A VISUAL's description, as stored: plain text, at most this many characters
// (the answer's own limit, in words, is stricter; see `decide.ts`).
const VISUAL_DESCRIPTION_MAX = 120;

// The smallest size any text overlay, caption, transition level or big word
// is set at. The schema refuses a smaller one, so the layout engine never
// places text below it.
export const MIN_TEXT_SIZE = 8;

// A big word behind the speaker: one word, nothing that could leave its tag.
export const BEHIND_WORD = /^[^\s<>&]{1,24}$/;

// A big word as stored: one or two such words joined by one space.
function isBehindText(text: string): boolean {
  const parts = text.split(" ");
  return parts.length <= 2 && parts.every((part) => BEHIND_WORD.test(part));
}

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
export interface EditLimits {
  duration?: number;
  bounds?: Box;
  // The decide limit: a VISUAL lasts the shown floor to `behind.maxSeconds`, a
  // big word from the shown floor to the accent's timing at most (from the
  // lead before its word to `afterSeconds` after it). Stored versions parse
  // without it, so a version saved under older lengths still renders.
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
  // Where a text sits: the layout engine sets it on every caption, accent, hook
  // and big word of a placed version (the engine's input may have none).
  const position = z.object({
    x: z.number().min(bounds.left).max(bounds.right),
    y: z.number().min(bounds.top).max(bounds.bottom),
    align: z.enum(["left", "right", "center"]),
  });
  const textProps = {
    text: z.string().min(1).max(200).optional(),
    font: z.enum(FONT_KEYS).optional(),
    size: z.number().int().min(MIN_TEXT_SIZE).max(400).optional(),
    color: z.string().regex(COLOR).optional(),
    position: position.optional(),
    // Set in two lines: this many words of the text on the first.
    break_after: z.number().int().min(1).max(60).optional(),
  };
  const clip = z.object({
    ...base,
    hidden: z.array(z.object({ start: anchor, end: anchor })).optional(),
  });
  const caption = z.object({
    ...base,
    words: z.array(wordId).min(1),
    ...textProps,
    // The accent, big word or list (its id) showing this caption's words while
    // it is on screen: the layout engine leaves the caption out then, so no word
    // is on screen twice.
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
    position,
    size: z.number().int().min(MIN_TEXT_SIZE).max(400),
    break_after: textProps.break_after,
  });
  const transition = z.object({
    ...base,
    type: z.enum(TRANSITION_KINDS),
    // Written by the layout engine. The phrase it carries (word ids), its key
    // phrase's first word, its number in a list.
    words: z.array(wordId).min(1),
    key: wordId.optional(),
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
  // A placed VISUAL's box: where the layout engine set it (its top left
  // corner, width and height in the frame). A VISUAL is always in front of the
  // speaker, over the footage.
  const visualBox = z.object({
    x: z.number().int().min(0).max(preset.frame.width),
    y: z.number().int().min(0).max(preset.frame.height),
    width: z.number().int().min(1).max(preset.frame.width),
    height: z.number().int().min(1).max(preset.frame.height),
  });
  const behind = z.discriminatedUnion("kind", [
    // A VISUAL: an empty white stroke frame over the footage, with no picture
    // behind it. `description` says what a visual would show; it is never
    // shown on screen.
    z.object({
      ...base,
      kind: z.literal("visual"),
      description: z.string().min(1).max(VISUAL_DESCRIPTION_MAX).optional(),
      spot: z.enum(BEHIND_SPOTS),
      box: visualBox,
    }),
    z.object({
      ...base,
      kind: z.literal("word"),
      text: z.string().refine(isBehindText, {
        message: "a big word is one or two plain words of at most 24 letters",
      }),
      // Where the layout engine set it (its top left corner in the frame) and
      // at what size.
      position: z
        .object({
          x: z.number().min(0).max(preset.frame.width),
          y: z.number().min(0).max(preset.frame.height),
        })
        .optional(),
      size: z.number().int().min(MIN_TEXT_SIZE).max(400).optional(),
      // The word ids it shows (one or two), written by the layout engine; the
      // same-text check reads them. Stored versions without it still parse.
      words: z.array(wordId).min(1).max(2).optional(),
    }),
  ]);
  return z.object({
    footage: z.array(clip),
    captions: z.array(caption),
    overlays: z.array(overlay),
    transitions: z.array(transition),
    sounds: z.array(sound),
    // VISUALs and big words behind the speaker; stored versions without it
    // parse, and the builder reads it as empty.
    behind: z.array(behind).optional(),
  });
}

type Tracks = z.infer<ReturnType<typeof tracksSchemaFor>>;

const SLACK = 1e-6;

// What the JSON Schema cannot say: every id once, no item ending before it
// starts, an overlay showing words or text, at most one hook, with its own
// text and no words, a caption hidden only by an accent, a big word or a list
// (never the hook, which nobody says), and a behind item never at the
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
    ...edit.tracks.transitions.flatMap((item) => (item.levels ? [item.id] : [])),
  ]);
  for (const item of edit.tracks.captions) {
    if (item.hidden_by !== undefined && !showers.has(item.hidden_by)) {
      ctx.addIssue({
        code: "custom",
        message: `caption ${item.id}: hidden by ${item.hidden_by}, which is no accent, big word or list`,
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
  }
  refineBehind(edit, transcript, preset, limits, ctx);
}

// The behind track's own rules (length with the decide limit, clear of hidden
// footage).
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
    const [min, max] = behindLength(span.item, transcript.words, preset);
    if (length < min - SLACK || length > max + SLACK) {
      ctx.addIssue({
        code: "custom",
        message: `behind ${span.id}: lasts ${length.toFixed(3)} s, must be ${min} to ${Number(max.toFixed(3))} s`,
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

// The shortest and longest a new behind item may show, in seconds: a VISUAL
// the behind lengths; a big word the accent's timing, at least its minimum
// and at most from the lead before its first word to `afterSeconds` after its
// last (a longer word holds longer; one cut short by the next extra stays
// above the minimum).
function behindLength(
  item: { kind: "visual" | "word"; start: Anchor; text?: string },
  ordered: readonly Word[],
  preset: Preset,
): [number, number] {
  // A pick may be shorter than its kind's minimum, down to the shown floor,
  // where the reel ends or a cut leaves less room.
  if (item.kind === "visual") return [SHOWN_FLOOR_SECONDS, preset.behind.maxSeconds];
  const { minSeconds, afterSeconds, leadSeconds } = preset.accent;
  const first = "word" in item.start ? item.start.word : undefined;
  const at = ordered.findIndex((word) => word.id === first);
  const said = at >= 0 ? ordered[at] : undefined;
  // A two-word big word runs to its last word: the one after its first.
  const count = item.text?.split(" ").length ?? 1;
  const last = said ? (ordered[at + count - 1] ?? said) : undefined;
  const longest = said && last ? leadSeconds + (last.end - said.start) + afterSeconds : minSeconds;
  return [SHOWN_FLOOR_SECONDS, Math.max(minSeconds, longest)];
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
export type BehindVisualItem = Extract<BehindItem, { kind: "visual" }>;
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
