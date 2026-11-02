import { type Check, runChecks } from "./checks.ts";
import type { HeadTrack } from "./head-track.ts";
import { attrs, escapeHtml, px, sec, selector, volume } from "./html.ts";
import { type TextBox, layoutText } from "./layout.ts";
import type { Measurer } from "./measure.ts";
import { FONT_KEYS, type Preset } from "./preset.ts";
import type { Edit, EditRef } from "./schema.ts";
import { resolveSpans, resolveTimeline } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";

export type AssetRole = "footage" | "cutout" | "font" | "sound";

// A file the page references: footage and cut-out are pipeline outputs (by
// producer), fonts and sounds are packages/edit's assets.
export interface BuildAsset {
  path: string;
  role: AssetRole;
  ref: EditRef | null;
}

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
  const boxes = layoutText(edit, resolved, transcript, headTrack, preset, measurer);
  const checks = runChecks(edit, boxes, resolved, transcript, headTrack, preset);
  const span = (id: string) => resolved.get(id)!;
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
  ];

  const body: string[] = [];
  const clip = (
    kind: "footage" | "cutout",
    item: Edit["tracks"]["footage"][number],
    track: number,
  ) => {
    const { start, end } = span(item.id);
    const src = edit.inputs[kind].file;
    body.push(
      `      <video${attrs([
        ["id", item.id],
        ["class", "clip full"],
        ["src", src],
        ...(kind === "cutout" ? ([["muted", null]] as const) : []),
        ["playsinline", null],
        ["data-start", sec(start)],
        ["data-duration", sec(end - start)],
        ["data-track-index", String(track)],
        ...(kind === "footage" ? ([["data-has-audio", "true"]] as const) : []),
        ...(item.style ? ([["style", inlineStyle(item.style)]] as const) : []),
      ])}></video>`,
    );
    for (const hidden of resolveSpans(item.hidden, edit, transcript)) {
      js.push(`tl.set(${selector(item.id)}, { opacity: 0 }, ${num(hidden.start)});`);
      js.push(`tl.set(${selector(item.id)}, { opacity: 1 }, ${num(hidden.end)});`);
    }
  };
  for (const item of tracks.footage) clip("footage", item, 1);
  for (const item of tracks.cutout) clip("cutout", item, 30);

  for (const [index, item] of tracks.transitions.entries()) {
    const kind = preset.transitions[item.type];
    const { start, end } = span(item.id);
    const height = kind.layer.bottom - kind.layer.top;
    const hidden = kind.motion === "fade" ? "opacity: 0" : `transform: translateY(${height}px)`;
    const css = [
      `left: ${px(kind.layer.left)}px`,
      `top: ${px(kind.layer.top)}px`,
      `width: ${px(kind.layer.right - kind.layer.left)}px`,
      `height: ${px(height)}px`,
      `background: ${item.color ?? kind.background}`,
      hidden,
      ...(item.style ? [inlineStyle(item.style)] : []),
    ].join("; ");
    body.push(
      `      <div${attrs([
        ["id", item.id],
        ["class", "clip layer"],
        ["data-start", sec(start)],
        ["data-duration", sec(end - start)],
        ["data-track-index", String(40 + index)],
        ["style", css],
      ])}></div>`,
    );
    const out = Math.max(end - kind.seconds, start);
    const id = selector(item.id);
    if (kind.motion === "fade") {
      js.push(
        `tl.fromTo(${id}, { opacity: 0 }, { opacity: 1, duration: ${num(kind.seconds)}, ease: "${kind.ease}" }, ${num(start)});`,
        `tl.to(${id}, { opacity: 0, duration: ${num(kind.seconds)}, ease: "${kind.ease}" }, ${num(out)});`,
      );
    } else {
      js.push(
        `tl.fromTo(${id}, { y: ${height} }, { y: 0, duration: ${num(kind.seconds)}, ease: "${kind.ease}" }, ${num(start)});`,
        `tl.to(${id}, { y: ${height}, duration: ${num(kind.seconds)}, ease: "${kind.ease}" }, ${num(out)});`,
      );
    }
    if (kind.hidesCutout) {
      for (const cutout of tracks.cutout) {
        js.push(
          `tl.to(${selector(cutout.id)}, { opacity: 0, duration: ${num(kind.seconds)} }, ${num(start)});`,
          `tl.to(${selector(cutout.id)}, { opacity: 1, duration: ${num(kind.seconds)} }, ${num(out)});`,
        );
      }
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
  const { caption } = preset;
  for (const box of texts) {
    const css = [
      `left: ${px(box.x)}px`,
      `top: ${px(box.y)}px`,
      `font-size: ${px(box.size)}px`,
      `color: ${box.color}`,
      ...(box.style ? [inlineStyle(box.style)] : []),
    ].join("; ");
    body.push(
      `        <span${attrs([
        ["id", box.itemId],
        ["class", `text f-${box.font}`],
        ["style", css],
      ])}>${escapeHtml(box.text)}</span>`,
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

  return { html, assets: assetsOf(edit, preset), checks };
}

function inlineStyle(style: Record<string, string>): string {
  return Object.keys(style)
    .sort()
    .map((key) => `${key}: ${style[key]}`)
    .join("; ");
}

function assetsOf(edit: Edit, preset: Preset): BuildAsset[] {
  const assets: BuildAsset[] = [];
  if (edit.tracks.footage.length > 0) {
    assets.push({ path: edit.inputs.footage.file, role: "footage", ref: edit.inputs.footage });
  }
  if (edit.tracks.cutout.length > 0) {
    assets.push({ path: edit.inputs.cutout.file, role: "cutout", ref: edit.inputs.cutout });
  }
  for (const key of FONT_KEYS)
    assets.push({ path: preset.fonts[key].file, role: "font", ref: null });
  for (const key of new Set(edit.tracks.sounds.map((item) => item.sound))) {
    assets.push({ path: preset.sounds[key].file, role: "sound", ref: null });
  }
  return assets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
