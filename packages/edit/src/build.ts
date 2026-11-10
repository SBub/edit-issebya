import { type BigWordBox, maskSpans, placedBigWord, visualBox } from "./behind.ts";
import { type Check, runChecks } from "./checks.ts";
import type { EngineNote } from "./engine-note.ts";
import { type TextBox } from "./engine-space.ts";
import type { HeadTrack } from "./head-track.ts";
import { attrs, escapeHtml, px, sec, selector, volume } from "./html.ts";
import { wordsText } from "./glossary.ts";
import type { Measurer } from "./measure.ts";
import { textLines } from "./lines.ts";
import { FONT_KEYS, type Preset } from "./preset.ts";
import { STYLES, VARIANTS } from "./variants.ts";
import type { BehindItem, Edit, EditMask, EditRef } from "./schema.ts";
import { resolveSpans, resolveTimeline } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";
import { hiddenCaptionIds, levelBoxes } from "./transitions.ts";

export type AssetRole = "footage" | "font" | "sound" | "mask" | "visual";

// A file the page references: the footage and the masks are stored outputs
// (by producer), fonts, sounds and the stand-in pictures are packages/edit's assets.
export interface BuildAsset {
  path: string;
  role: AssetRole;
  ref: EditRef | null;
}

// Where the page looks for a mask, inside the project.
export function maskPath(mask: Pick<EditMask, "fingerprint">): string {
  return `masks/${mask.fingerprint}.mp4`;
}

// A VISUAL: an empty white stroke frame (transparent inside), a corner card of
// the preset's stroke width.
const visualStyle = (stroke: number) =>
  `      .visual { position: absolute; box-sizing: border-box; border: ${stroke}px solid #ffffff; background: transparent; }`;

// A VISUAL with its stand-in picture: the picture fills the card's box exactly
// (the box has the picture's aspect, so nothing is cropped), and the stroke is
// drawn over it as the card's own frame.
const visualPictureStyle = (stroke: number) => [
  "      .visual-picture { position: absolute; box-sizing: border-box; }",
  "      .visual-picture img { position: absolute; left: 0; top: 0; width: 100%; height: 100%; display: block; }",
  `      .visual-picture::after { content: ""; position: absolute; inset: 0; border: ${stroke}px solid #ffffff; box-sizing: border-box; }`,
];

// The extra rules a page with a cut-out needs: the composite's groups and
// blends.
const BEHIND_STYLE = [
  "      .cutout { position: absolute; inset: 0; isolation: isolate; }",
  "      .cutout-front { position: absolute; inset: 0; isolation: isolate; mix-blend-mode: plus-lighter; }",
  "      .mask-under { filter: invert(1); mix-blend-mode: multiply; }",
  "      .mask-front { mix-blend-mode: multiply; }",
];

// A big word's class, on any page with one.
const WORD_STYLE = "      .word { position: absolute; line-height: 1; white-space: nowrap; }";

export interface BuildResult {
  html: string;
  assets: BuildAsset[];
  checks: Check[];
}

export interface BuildOptions {
  // The engine's record of the placement: its kept overlaps are the only
  // text overlaps the checks excuse.
  engineRecord?: readonly EngineNote[];
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
  options: BuildOptions = {},
): BuildResult {
  const resolved = resolveTimeline(edit, transcript);
  // A caption a text shows is left out only while that text is on screen.
  const hidden = hiddenCaptionIds(edit, resolved);
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
  const boxes = placedText(shownEdit, resolved, transcript, preset, measurer);
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
    if (!item.position || !item.size) {
      throw new Error(`build: big word ${item.id} has no position; place the edit first`);
    }
    bigWords.set(item.id, placedBigWord(item, item.position, item.size, measurer));
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
    options.engineRecord,
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
  // VISUALs, and the big words the head cannot reach: in front of the speaker,
  // over the footage, no cut-out.
  const overFootage = behindItems.filter(
    (item) => item.kind === "visual" || (item.kind === "word" && item.cutout === false),
  );
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
    ...(spans.length > 0 ? BEHIND_STYLE : []),
    ...(behindItems.some((item) => item.kind === "word") ? [WORD_STYLE] : []),
    // A visual's frame: only on a page that has one, and its picture's only on a
    // page with a picture.
    ...(behindItems.some((item) => item.kind === "visual")
      ? [visualStyle(VARIANTS["visual/card"].style.stroke.px)]
      : []),
    ...(behindItems.some((item) => item.kind === "visual" && item.image !== undefined)
      ? visualPictureStyle(VARIANTS["visual/card"].style.stroke.px)
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
  // Above the footage and the composites, under transitions and text, each
  // with its own hard cut in and out. A VISUAL's card is track 30; a big word
  // with no cut-out is front text, drawn above the cards (track 31, decision 24).
  for (const item of overFootage) {
    const track = item.kind === "word" ? "31" : "30";
    body.push(`      ${behindElement(item, span(item.id), bigWords.get(item.id), preset, track)}`);
  }

  const { caption } = preset;
  // Each transition is a layer of the background role; its text levels are
  // children of the layer (so they come and go with it), each revealed on
  // its own word with the caption's rise.
  for (const [index, item] of tracks.transitions.entries()) {
    const kind = preset.transitions[item.type];
    const seconds = kind.seconds;
    const { start, end } = span(item.id);
    const height = kind.layer.bottom - kind.layer.top;
    const hidden = kind.motion === "fade" ? "opacity: 0" : `transform: translateY(${height}px)`;
    const css = [
      `left: ${px(kind.layer.left)}px`,
      `top: ${px(kind.layer.top)}px`,
      `width: ${px(kind.layer.right - kind.layer.left)}px`,
      `height: ${px(height)}px`,
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
          `tl.fromTo(${selector(level.itemId)}, { opacity: 0, y: ${caption.rise} }, { opacity: 1, y: 0, duration: ${num(level.reveal)}, ease: "${caption.inEase}" }, ${num(level.start)});`,
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

// One behind-track item as its element: a VISUAL exactly covering its box, or
// the big word at its measured size. Its own start and duration are the hard
// cut in and out; nothing animates it.
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
    const box = visualBox(item);
    const css = [
      `left: ${px(box.left)}px`,
      `top: ${px(box.top)}px`,
      `width: ${px(box.right - box.left)}px`,
      `height: ${px(box.bottom - box.top)}px`,
      ...extra,
    ].join("; ");
    if (item.image !== undefined) {
      // The stand-in picture, filling the box; the stroke is its frame.
      return [
        `<div${attrs([
          ["id", item.id],
          ["class", "clip visual-picture"],
          ...timing,
          ["style", css],
        ])}>`,
        `  <img${attrs([
          ["src", item.image],
          ["alt", ""],
        ])}>`,
        "</div>",
      ].join("\n");
    }
    // An empty white stroke frame: no picture, no text, no fill.
    return `<div${attrs([
      ["id", item.id],
      ["class", "clip visual"],
      ["alt", ""],
      ...timing,
      ["style", css],
    ])}></div>`;
  }
  const box = word!;
  const css = [
    `left: ${px(box.x)}px`,
    `top: ${px(box.y)}px`,
    `font-size: ${px(box.size)}px`,
    `color: ${box.color}`,
    ...extra,
  ].join("; ");
  return `<div${attrs([
    ["id", item.id],
    ["class", `clip word f-${box.font}`],
    ...timing,
    ["style", css],
  ])}>${escapeHtml(box.text)}</div>`;
}

// The text the page shows in its own place, each at the position the layout
// engine set: every caption shown there and every overlay (an accent or the
// hook). Its width is HarfBuzz's. A shown text with no position is an error.
function placedText(
  edit: Edit,
  resolved: ReadonlyMap<string, { start: number; end: number }>,
  transcript: Transcript,
  preset: Preset,
  measurer: Measurer,
): TextBox[] {
  const items = [
    ...edit.tracks.captions.map((item) => ({ item, kind: "caption" as const })),
    ...edit.tracks.overlays.map((item) => ({ item, kind: item.kind })),
  ];
  return items.map(({ item, kind }): TextBox => {
    if (!item.position)
      throw new Error(`build: ${kind} ${item.id} has no position; place the edit first`);
    const font = item.font ?? (kind === "caption" ? STYLES.caption.font : STYLES.accent.font);
    // An item with no size takes its font's style base.
    const size = item.size ?? (font === "primary" ? STYLES.accent.base : STYLES.caption.base);
    const text = item.text ?? wordsText(item.words ?? [], transcript, preset);
    const lines = textLines(text, item.breaks);
    const width = Math.max(...lines.map((line) => measurer.width(font, size, line)));
    const { x, y, align } = item.position;
    const left = align === "left" ? x : align === "right" ? x - width : x - width / 2;
    const span = resolved.get(item.id)!;
    return {
      itemId: item.id,
      kind,
      text,
      lines,
      font,
      size,
      color: item.color ?? (kind === "caption" ? STYLES.caption.color : STYLES.accent.color),
      style: item.style,
      start: span.start,
      end: span.end,
      x: left,
      y,
      width,
      height: size * lines.length,
    };
  });
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
  // Each stand-in picture a visual shows, once.
  const pictures = new Set(
    (edit.tracks.behind ?? []).flatMap((item) =>
      item.kind === "visual" && item.image !== undefined ? [item.image] : [],
    ),
  );
  for (const file of pictures) {
    assets.push({ path: file, role: "visual", ref: null });
  }
  return assets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
