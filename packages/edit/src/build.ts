import {
  type BigWordBox,
  bigWordLayout,
  maskSpans,
  needsCutout,
  photoBox,
  placedBigWord,
} from "./behind.ts";
import { type Check, runChecks } from "./checks.ts";
import { isLightText } from "./contrast.ts";
import type { HeadTrack } from "./head-track.ts";
import { attrs, escapeHtml, px, sec, selector, volume } from "./html.ts";
import { type TextBox, layoutText } from "./layout.ts";
import type { Measurer } from "./measure.ts";
import { FONT_KEYS, type Preset } from "./preset.ts";
import type { BehindItem, Edit, EditMask, EditRef } from "./schema.ts";
import { resolveSpans, resolveTimeline } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";
import {
  hiddenCaptionIds,
  levelBoxes,
  motionSeconds,
  transitionBackground,
} from "./transitions.ts";

export type AssetRole = "footage" | "font" | "sound" | "mask" | "photo";

// A file the page references: the footage and the masks are stored outputs
// (by producer), a photo is a library photo (by id), fonts and sounds are
// packages/edit's assets. A stored version naming the old whole-clip cut-out
// builds without it: no cut-out video, no cut-out asset.
export interface BuildAsset {
  path: string;
  role: AssetRole;
  ref: EditRef | null;
  photoId?: string;
}

// Where the page looks for a mask and a photo, inside the project.
export function maskPath(mask: Pick<EditMask, "fingerprint">): string {
  return `masks/${mask.fingerprint}.mp4`;
}

export function photoPath(photoId: string): string {
  return `photos/${photoId}.jpg`;
}

// A library photo's rule: behind the speaker or in front of them.
const PHOTO_STYLE = "      .photo { position: absolute; object-fit: cover; }";
// A VISUAL: an empty white stroke frame (transparent inside), a corner card of
// the preset's stroke width.
const visualStyle = (stroke: number) =>
  `      .visual { position: absolute; box-sizing: border-box; border: ${stroke}px solid #ffffff; background: transparent; }`;

// The extra rules a page with behind items needs: the composite's groups and
// blends, the photo and the big word.
const BEHIND_STYLE = [
  "      .cutout { position: absolute; inset: 0; isolation: isolate; }",
  "      .cutout-front { position: absolute; inset: 0; isolation: isolate; mix-blend-mode: plus-lighter; }",
  "      .mask-under { filter: invert(1); mix-blend-mode: multiply; }",
  "      .mask-front { mix-blend-mode: multiply; }",
  PHOTO_STYLE,
  "      .word { position: absolute; line-height: 1; white-space: nowrap; }",
];

export interface BuildResult {
  html: string;
  assets: BuildAsset[];
  checks: Check[];
}

// The GSAP build the reference reel was made with, pinned: HyperFrames drives
// its paused timeline.
const GSAP = "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js";

function num(n: number): string {
  return String(Math.round(n * 1000) / 1000 || 0);
}

// One version as a HyperFrames composition: anchors resolved through the
// transcript, unset properties filled from the preset, every text measured
// by HarfBuzz, the layout checked. No clock, no randomness, no I/O: the same
// inputs give the same bytes in the browser and in Node.
export function build(
  edit: Edit,
  transcript: Transcript,
  headTrack: HeadTrack,
  preset: Preset,
  measurer: Measurer,
): BuildResult {
  const resolved = resolveTimeline(edit, transcript);
  // A transition's own captions show only as its levels, never in their place.
  const hidden = hiddenCaptionIds(edit);
  const shownEdit =
    hidden.size === 0
      ? edit
      : {
          ...edit,
          tracks: {
            ...edit.tracks,
            captions: edit.tracks.captions.filter((caption) => !hidden.has(caption.id)),
          },
        };
  const boxes = layoutText(shownEdit, resolved, transcript, headTrack, preset, measurer);
  const levels = levelBoxes(
    edit,
    resolved,
    new Map(transcript.words.map((word) => [word.id, word])),
    preset,
    measurer,
  );
  const behindItems = edit.tracks.behind ?? [];
  const bigWords = new Map<string, BigWordBox>();
  for (const item of behindItems) {
    if (item.kind !== "word") continue;
    bigWords.set(
      item.id,
      item.position && item.size
        ? placedBigWord(item, item.position, item.size, preset, measurer)
        : bigWordLayout(item, resolved.get(item.id)!, headTrack, preset, measurer),
    );
  }
  const checks = runChecks(
    edit,
    boxes,
    resolved,
    transcript,
    headTrack,
    preset,
    [...bigWords.values()],
    levels,
  );
  const spans = maskSpans(edit, transcript, preset);
  const masks = spans.map((maskSpan) => {
    const mask = (edit.inputs.masks ?? []).find(
      (entry) =>
        Math.abs(entry.start - maskSpan.start) < 0.0005 &&
        Math.abs(entry.end - maskSpan.end) < 0.0005,
    );
    if (!mask) throw new Error(`build: behind item ${maskSpan.items[0]} has no cut-out`);
    return mask;
  });
  const span = (id: string) => resolved.get(id)!;
  // Photos in front of the speaker: over the footage, no cut-out.
  const frontPhotos = behindItems.filter((item) => !needsCutout(item));
  const duration = sec(edit.duration);
  const { tracks } = edit;
  const js: string[] = [];

  const style = [
    ...FONT_KEYS.map((key) => {
      const font = preset.fonts[key];
      return `      @font-face { font-family: "${font.family}"; src: url("${font.file}") format("truetype"); font-weight: ${font.weight}; }`;
    }),
    "      * { margin: 0; padding: 0; box-sizing: border-box; }",
    `      html, body { width: ${preset.frame.width}px; height: ${preset.frame.height}px; overflow: hidden; background: #000; }`,
    "      .full { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }",
    "      .layer { position: absolute; }",
    "      #text { position: absolute; inset: 0; }",
    "      .text { position: absolute; line-height: 1; white-space: nowrap; opacity: 0; }",
    ...FONT_KEYS.map((key) => {
      const font = preset.fonts[key];
      return `      .f-${key} { font-family: "${font.family}", sans-serif; font-weight: ${font.weight}; }`;
    }),
    ...(spans.length > 0 ? BEHIND_STYLE : frontPhotos.length > 0 ? [PHOTO_STYLE] : []),
    // A visual's frame: only on a page that has one (older pages are unchanged).
    ...(behindItems.some((item) => item.kind === "visual")
      ? [visualStyle(preset.behind.card.stroke)]
      : []),
    ...(levels.length > 0
      ? ["      .level { position: absolute; line-height: 1; white-space: nowrap; opacity: 0; }"]
      : []),
    // The written hook's own class (its lines centred); only on a page with one.
    ...(boxes.some((box) => box.kind === "hook") ? ["      .hook { text-align: center; }"] : []),
  ];

  const body: string[] = [];
  const clip = (item: Edit["tracks"]["footage"][number], track: number) => {
    const { start, end } = span(item.id);
    const src = edit.inputs.footage.file;
    body.push(
      `      <video${attrs([
        ["id", item.id],
        ["class", "clip full"],
        ["src", src],
        ["playsinline", null],
        ["data-start", sec(start)],
        ["data-duration", sec(end - start)],
        ["data-track-index", String(track)],
        ["data-has-audio", "true"],
        ...(item.style ? ([["style", inlineStyle(item.style)]] as const) : []),
      ])}></video>`,
    );
    for (const hidden of resolveSpans(item.hidden, edit, transcript)) {
      js.push(`tl.set(${selector(item.id)}, { opacity: 0 }, ${num(hidden.start)});`);
      js.push(`tl.set(${selector(item.id)}, { opacity: 1 }, ${num(hidden.end)});`);
    }
  };
  for (const item of tracks.footage) clip(item, 1);

  // Behind the speaker, one composite per mask span, above the footage and
  // under transitions and text. Inside an isolated group: a footage copy, the
  // span's behind items on it, the inverted mask multiplied (keeps the
  // picture where the person is not), and an isolated sub-group adding the
  // footage times the mask (the person back in front). Every layer is a plain
  // timed element, so the player and the render's frame injector (which
  // copies `filter` and `mix-blend-mode` onto its frames) show the same
  // pixels; the groups themselves are untimed (HyperFrames times the video or
  // its wrapper, never both).
  for (const [index, maskSpan] of spans.entries()) {
    const id = `cut_${index + 1}`;
    const mask = masks[index]!;
    const timing = [
      ["data-start", sec(maskSpan.start)],
      ["data-duration", sec(maskSpan.end - maskSpan.start)],
    ] as const;
    const footageCopy = (copy: string, track: number) =>
      `<video${attrs([
        ["id", `${id}_${copy}`],
        ["class", "clip full"],
        ["src", edit.inputs.footage.file],
        ["muted", null],
        ["playsinline", null],
        ...timing,
        ["data-media-start", sec(maskSpan.start)],
        ["data-track-index", String(track)],
      ])}></video>`;
    const maskVideo = (copy: string, className: string, track: number) =>
      `<video${attrs([
        ["id", `${id}_${copy}`],
        ["class", `clip full ${className}`],
        ["src", maskPath(mask)],
        ["muted", null],
        ["playsinline", null],
        ...timing,
        ["data-track-index", String(track)],
      ])}></video>`;
    body.push(
      `      <div${attrs([
        ["id", id],
        ["class", "cutout"],
      ])}>`,
    );
    body.push(`        ${footageCopy("footage", 20)}`);
    for (const item of behindItems) {
      if (!maskSpan.items.includes(item.id)) continue;
      body.push(`        ${behindElement(item, span(item.id), bigWords.get(item.id), preset)}`);
    }
    body.push(`        ${maskVideo("under", "mask-under", 22)}`);
    body.push(`        <div${attrs([["class", "cutout-front"]])}>`);
    body.push(`          ${footageCopy("person", 23)}`);
    body.push(`          ${maskVideo("mask", "mask-front", 24)}`);
    body.push("        </div>");
    body.push("      </div>");
  }
  // In front of the speaker: above the footage and the composites, under
  // transitions and text, each with its own hard cut in and out.
  for (const item of frontPhotos) {
    body.push(`      ${behindElement(item, span(item.id), undefined, preset, "30")}`);
  }

  const { caption } = preset;
  // Each transition is a layer of the background role; its text levels are
  // children of the layer (so they come and go with it), each revealed on
  // its own word with the caption's rise.
  for (const [index, item] of tracks.transitions.entries()) {
    const kind = preset.transitions[item.type];
    const seconds = motionSeconds(item, preset);
    const { start, end } = span(item.id);
    const height = kind.layer.bottom - kind.layer.top;
    const hidden = kind.motion === "fade" ? "opacity: 0" : `transform: translateY(${height}px)`;
    const css = [
      `left: ${px(kind.layer.left)}px`,
      `top: ${px(kind.layer.top)}px`,
      `width: ${px(kind.layer.right - kind.layer.left)}px`,
      `height: ${px(height)}px`,
      `background: ${transitionBackground(kind, preset, item.color)}`,
      hidden,
      ...(item.style ? [inlineStyle(item.style)] : []),
    ].join("; ");
    const own = levels.filter((level) => level.transitionId === item.id);
    const open = `      <div${attrs([
      ["id", item.id],
      ["class", "clip layer"],
      ["data-start", sec(start)],
      ["data-duration", sec(end - start)],
      ["data-track-index", String(40 + index)],
      ["style", css],
    ])}>`;
    if (own.length === 0) {
      body.push(`${open}</div>`);
    } else {
      body.push(open);
      for (const level of own) {
        const levelCss = [
          `left: ${px(level.x - kind.layer.left)}px`,
          `top: ${px(level.y - kind.layer.top)}px`,
          `font-size: ${px(level.size)}px`,
          `color: ${level.color}`,
          ...(level.lines.length > 1 ? ["text-align: center"] : []),
        ].join("; ");
        body.push(
          `        <div${attrs([
            ["id", level.itemId],
            ["class", `level f-${level.font}`],
            ["style", levelCss],
          ])}>${level.lines.map(escapeHtml).join("<br />")}</div>`,
        );
        js.push(
          `tl.fromTo(${selector(level.itemId)}, { opacity: 0, y: ${caption.rise} }, { opacity: 1, y: 0, duration: ${num(caption.inSeconds)}, ease: "${caption.inEase}" }, ${num(level.start)});`,
        );
      }
      body.push("      </div>");
    }
    const out = Math.max(end - seconds, start);
    const id = selector(item.id);
    if (kind.motion === "fade") {
      js.push(
        `tl.fromTo(${id}, { opacity: 0 }, { opacity: 1, duration: ${num(seconds)}, ease: "${kind.ease}" }, ${num(start)});`,
        `tl.to(${id}, { opacity: 0, duration: ${num(seconds)}, ease: "${kind.ease}" }, ${num(out)});`,
      );
    } else {
      js.push(
        `tl.fromTo(${id}, { y: ${height} }, { y: 0, duration: ${num(seconds)}, ease: "${kind.ease}" }, ${num(start)});`,
        `tl.to(${id}, { y: ${height}, duration: ${num(seconds)}, ease: "${kind.ease}" }, ${num(out)});`,
      );
    }
  }

  const byId = new Map(boxes.map((box) => [box.itemId, box]));
  const texts = [...tracks.captions, ...tracks.overlays]
    .map((item) => byId.get(item.id))
    .filter((box): box is TextBox => box !== undefined);
  body.push(
    `      <div${attrs([
      ["id", "text"],
      ["class", "clip"],
      ["data-start", "0.000"],
      ["data-duration", duration],
      ["data-track-index", "50"],
    ])}>`,
  );
  for (const box of texts) {
    const css = [
      `left: ${px(box.x)}px`,
      `top: ${px(box.y)}px`,
      `font-size: ${px(box.size)}px`,
      `color: ${box.color}`,
      ...(box.lines.length > 1 && box.kind !== "hook" ? ["text-align: center"] : []),
      ...(box.shadow ? [`text-shadow: ${textShadow(box.color, box.shadow, preset)}`] : []),
      ...(box.style ? [inlineStyle(box.style)] : []),
    ].join("; ");
    body.push(
      `        <span${attrs([
        ["id", box.itemId],
        ["class", box.kind === "hook" ? `text hook f-${box.font}` : `text f-${box.font}`],
        ["style", css],
      ])}>${box.lines.map(escapeHtml).join("<br />")}</span>`,
    );
    const id = selector(box.itemId);
    js.push(
      `tl.fromTo(${id}, { opacity: 0, y: ${caption.rise} }, { opacity: 1, y: 0, duration: ${num(caption.inSeconds)}, ease: "${caption.inEase}" }, ${num(box.start)});`,
      `tl.to(${id}, { opacity: 0, duration: ${num(caption.outSeconds)} }, ${num(Math.max(box.end - caption.outSeconds, box.start + caption.minSeconds))});`,
    );
  }
  body.push("      </div>");

  for (const item of tracks.sounds) {
    const sound = preset.sounds[item.sound];
    const { start } = span(item.id);
    const length = Math.min(sound.durationSeconds, Math.max(edit.duration - start, 0));
    body.push(
      `      <audio${attrs([
        ["id", item.id],
        ["class", "clip"],
        ["src", sound.file],
        ["data-start", sec(start)],
        ["data-duration", sec(length)],
        ["data-track-index", "60"],
        ["data-volume", volume(item.gain_db ?? sound.gainDb)],
      ])}></audio>`,
    );
  }

  const html = [
    "<!doctype html>",
    '<html lang="en" data-resolution="portrait">',
    "  <head>",
    '    <meta charset="UTF-8" />',
    `    <meta name="viewport" content="width=${preset.frame.width}, height=${preset.frame.height}" />`,
    `    <script src="${GSAP}"></script>`,
    "    <style>",
    ...style,
    "    </style>",
    "  </head>",
    "  <body>",
    `    <div${attrs([
      ["id", "root"],
      ["data-composition-id", "main"],
      ["data-start", "0"],
      ["data-duration", duration],
      ["data-width", String(preset.frame.width)],
      ["data-height", String(preset.frame.height)],
    ])}>`,
    ...body,
    "    </div>",
    "    <script>",
    "      const tl = gsap.timeline({ paused: true });",
    ...js.map((line) => `      ${line}`),
    "      window.__timelines = window.__timelines || {};",
    '      window.__timelines["main"] = tl;',
    "    </script>",
    "  </body>",
    "</html>",
    "",
  ].join("\n");

  return { html, assets: assetsOf(edit, preset, masks), checks };
}

// One behind-track item as its element: a photo exactly covering its box
// (its spot in a version saved before the engine set one), or the big word at
// its measured size. Its own start and duration are the hard cut in and out;
// nothing animates it.
function behindElement(
  item: BehindItem,
  { start, end }: { start: number; end: number },
  word: BigWordBox | undefined,
  preset: Preset,
  track = "21",
): string {
  const timing = [
    ["data-start", sec(start)],
    ["data-duration", sec(end - start)],
    ["data-track-index", track],
  ] as const;
  const extra = item.style ? [inlineStyle(item.style)] : [];
  if (item.kind === "visual") {
    // An empty white stroke frame: no picture, no text, no fill.
    const box = photoBox(item, preset);
    const css = [
      `left: ${px(box.left)}px`,
      `top: ${px(box.top)}px`,
      `width: ${px(box.right - box.left)}px`,
      `height: ${px(box.bottom - box.top)}px`,
      ...extra,
    ].join("; ");
    return `<div${attrs([
      ["id", item.id],
      ["class", "clip visual"],
      ["alt", ""],
      ...timing,
      ["style", css],
    ])}></div>`;
  }
  if (item.kind === "photo") {
    const box = photoBox(item, preset);
    const css = [
      `left: ${px(box.left)}px`,
      `top: ${px(box.top)}px`,
      `width: ${px(box.right - box.left)}px`,
      `height: ${px(box.bottom - box.top)}px`,
      ...extra,
    ].join("; ");
    return `<img${attrs([
      ["id", item.id],
      ["class", "clip photo"],
      ["src", photoPath(item.photo_id)],
      ["alt", ""],
      ...timing,
      ["style", css],
    ])} />`;
  }
  const box = word!;
  const css = [
    `left: ${px(box.x)}px`,
    `top: ${px(box.y)}px`,
    `font-size: ${px(box.size)}px`,
    `color: ${box.color}`,
    ...(item.shadow ? [`text-shadow: ${textShadow(box.color, item.shadow, preset)}`] : []),
    ...extra,
  ].join("; ");
  return `<div${attrs([
    ["id", item.id],
    ["class", `clip word f-${box.font}`],
    ...timing,
    ["style", css],
  ])}>${escapeHtml(box.text)}</div>`;
}

// Legacy, for versions saved before 2026-11-04 only (the engine never writes
// `shadow` now): the preset's soft shadow at a stored level, dark under a
// light text, light under a dark one, so old versions render unchanged.
function textShadow(color: string, level: 1 | 2, preset: Preset): string {
  const { shadows } = preset.readability;
  const [soft, strong] = isLightText(color) ? shadows.dark : shadows.light;
  return level === 1 ? soft : strong;
}

function inlineStyle(style: Record<string, string>): string {
  return Object.keys(style)
    .sort()
    .map((key) => `${key}: ${style[key]}`)
    .join("; ");
}

function assetsOf(edit: Edit, preset: Preset, masks: readonly EditMask[]): BuildAsset[] {
  const assets: BuildAsset[] = [];
  for (const mask of new Map(masks.map((entry) => [entry.fingerprint, entry])).values()) {
    const { step, fingerprint, file } = mask;
    assets.push({ path: maskPath(mask), role: "mask", ref: { step, fingerprint, file } });
  }
  const photoIds = new Set<string>();
  for (const item of edit.tracks.behind ?? []) {
    if (item.kind === "photo") photoIds.add(item.photo_id);
  }
  for (const photoId of photoIds) {
    assets.push({ path: photoPath(photoId), role: "photo", ref: null, photoId });
  }
  if (edit.tracks.footage.length > 0) {
    assets.push({ path: edit.inputs.footage.file, role: "footage", ref: edit.inputs.footage });
  }
  // Each font file once, even when both roles use it.
  for (const file of new Set(FONT_KEYS.map((key) => preset.fonts[key].file))) {
    assets.push({ path: file, role: "font", ref: null });
  }
  for (const key of new Set(edit.tracks.sounds.map((item) => item.sound))) {
    assets.push({ path: preset.sounds[key].file, role: "sound", ref: null });
  }
  return assets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
