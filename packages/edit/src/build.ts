import { ms } from "./anchors.ts";
import { type CheckResult, runChecks } from "./checks.ts";
import { type LayoutEntry, type ResolvedItem, hideAt, layoutText } from "./layout.ts";
import type { Measurer } from "./measure.ts";
import type { Preset } from "./preset.ts";
import { compareIds, resolveAll } from "./resolve.ts";
import { type Item, editSchema } from "./schema.ts";
import { hitsOf } from "./sounds.ts";
import type { HeadTrack, Transcript } from "./transcript.ts";

// A file the page references, by its path relative to the page. The caller
// maps each to a URL (the studio) or a file (the worker); nothing is fetched
// here.
export interface BuildAsset {
  role: "footage" | "cutout" | "font" | "sound";
  path: string;
  // The producing step's fingerprint, for footage and the cut-out.
  fingerprint?: string;
}

export interface BuildInput {
  edit: unknown;
  transcript: Transcript;
  headTrack: HeadTrack;
  preset: Preset;
  measurer: Measurer;
}

export interface BuildResult {
  html: string;
  assets: BuildAsset[];
  checks: CheckResult;
  layout: LayoutEntry[];
}

const FOOTAGE = "footage.mp4";
const CUTOUT = "subject.webm";
// Track indexes: one lane per layer, sounds from 60.
const TRACK_INDEX = { footage: 1, cutout: 30, words: 40, transitions: 41, sounds: 60 };
const PANEL_TOP = 1150;

// Seconds with three decimals, pixels with two: the same text in every
// JavaScript engine.
const s3 = (value: number) => value.toFixed(3);
const px2 = (value: number) => value.toFixed(2);

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Inside a double-quoted attribute a single quote is harmless.
function escapeAttribute(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function duration(resolved: ResolvedItem[], transcript: Transcript, preset: Preset): number {
  const footage = resolved.find((entry) => entry.track === "footage");
  if (footage) return footage.end;
  const last = transcript.words.at(-1);
  return ms((last?.end ?? 0) + preset.tail);
}

function styleOf(
  entry: LayoutEntry,
  custom: string | undefined,
  preset: Preset,
  top: number,
): string {
  const font = preset.fonts[entry.font]!;
  const declarations = [
    `left:${px2(entry.x)}px`,
    `top:${px2(top)}px`,
    `font-size:${px2(entry.size)}px`,
    `font-family:'${font.family}'`,
    `font-weight:${font.weight}`,
    `color:${entry.color}`,
  ];
  const generated = `${declarations.join(";")};`;
  return custom ? `${generated}${custom}` : generated;
}

function span(entry: LayoutEntry, item: Item, preset: Preset, top = entry.y): string {
  return `<span id="${entry.id}" class="tx" style="${escapeAttribute(styleOf(entry, item.custom, preset, top))}">${escapeHtml(entry.text)}</span>`;
}

// One edit, one transcript, one head track and one preset make one
// HyperFrames composition: the same bytes in Node and in Chromium. The edit
// is checked against the transcript and the preset first (an invalid edit
// throws). Nothing is stored.
export function build({
  edit: input,
  transcript,
  headTrack,
  preset,
  measurer,
}: BuildInput): BuildResult {
  const edit = editSchema({ transcript, preset }).parse(input);
  const resolved = resolveAll(edit, transcript);
  const total = duration(resolved, transcript, preset);
  const layout = layoutText({ resolved, headTrack, preset, measurer });
  const checks = runChecks(layout, resolved, headTrack, preset);
  const placed = new Map(layout.map((entry) => [entry.id, entry]));
  const { caption } = preset;

  const assets: BuildAsset[] = [];
  const body: string[] = [];
  const js: string[] = [];
  const hasFootage = edit.tracks.footage.length > 0;
  const hasCutout = edit.tracks.cutout.length > 0;

  if (hasFootage) {
    assets.push({ role: "footage", path: FOOTAGE, fingerprint: edit.inputs.footage });
    body.push(
      `<video id="footage" class="clip full" src="${FOOTAGE}" playsinline data-start="0" data-duration="${s3(total)}" data-track-index="${TRACK_INDEX.footage}" data-has-audio="true"></video>`,
    );
  }
  if (hasCutout) {
    assets.push({ role: "cutout", path: CUTOUT, fingerprint: edit.inputs.cutout });
    body.push(
      `<video id="cutout" class="clip full" src="${CUTOUT}" muted playsinline data-start="0" data-duration="${s3(total)}" data-track-index="${TRACK_INDEX.cutout}"></video>`,
    );
  }

  const words: string[] = [];
  for (const entry of resolved) {
    if (entry.track !== "captions" && entry.track !== "overlays") continue;
    const box = placed.get(entry.id)!;
    words.push(span(box, entry.item, preset));
    const out = hideAt(entry.start, entry.end, preset);
    js.push(
      `tl.fromTo("#${entry.id}", {opacity: 0, y: ${caption.rise}}, {opacity: 1, y: 0, duration: ${s3(caption.appear)}, ease: "power2.out"}, ${s3(entry.start)});`,
    );
    js.push(`tl.to("#${entry.id}", {opacity: 0, duration: ${s3(caption.fade)}}, ${s3(out)});`);
  }
  body.push(
    `<div id="words" class="clip" data-start="0" data-duration="${s3(total)}" data-track-index="${TRACK_INDEX.words}">${words.join("")}</div>`,
  );

  let lane = TRACK_INDEX.transitions;
  for (const entry of resolved) {
    if (entry.track !== "transitions" || !("type" in entry.item)) continue;
    const { id, start, end } = entry;
    const type = entry.item.type;
    const box = placed.get(id);
    const top = box ? (type === "panel" ? box.y - PANEL_TOP : box.y) : 0;
    const inner = box ? span(box, entry.item, preset, top) : "";
    const custom = entry.item.custom ? ` style="${escapeAttribute(entry.item.custom)}"` : "";
    body.push(
      `<div id="${id}" class="clip t-${type}"${custom} data-start="${s3(start)}" data-duration="${s3(end - start)}" data-track-index="${lane}">${inner}</div>`,
    );
    lane += 1;
    if (type === "dim") {
      js.push(
        `tl.fromTo("#${id}", {opacity: 0}, {opacity: 1, duration: 0.300}, ${s3(Math.max(0, start - 0.05))});`,
      );
      js.push(`tl.to("#${id}", {opacity: 0, duration: 0.300}, ${s3(Math.max(start, end - 0.3))});`);
    } else if (type === "panel") {
      if (hasCutout) js.push(`tl.to("#cutout", {opacity: 0, duration: 0.300}, ${s3(start)});`);
      if (hasFootage) {
        js.push(
          `tl.to("#footage", {clipPath: "inset(0px 0px 770px 0px)", duration: 0.500, ease: "power3.inOut"}, ${s3(start)});`,
        );
      }
      js.push(
        `tl.fromTo("#${id}", {yPercent: 100}, {yPercent: 0, duration: 0.500, ease: "power3.inOut"}, ${s3(start)});`,
      );
      js.push(
        `tl.to("#${id}", {yPercent: 100, duration: 0.500, ease: "power3.inOut"}, ${s3(end)});`,
      );
      if (hasFootage) {
        js.push(
          `tl.to("#footage", {clipPath: "inset(0px 0px 0px 0px)", duration: 0.500, ease: "power3.inOut"}, ${s3(end)});`,
        );
      }
      if (hasCutout) js.push(`tl.to("#cutout", {opacity: 1, duration: 0.300}, ${s3(end + 0.3)});`);
    } else {
      js.push(`tl.fromTo("#${id}", {opacity: 0}, {opacity: 1, duration: 0.250}, ${s3(start)});`);
      if (end < total)
        js.push(
          `tl.to("#${id}", {opacity: 0, duration: 0.250}, ${s3(Math.max(start, end - 0.25))});`,
        );
    }
  }

  lane = TRACK_INDEX.sounds;
  const sounds = new Set<string>();
  for (const hit of hitsOf(resolved, preset)) {
    if (!sounds.has(hit.path)) {
      sounds.add(hit.path);
      assets.push({ role: "sound", path: hit.path });
    }
    body.push(
      `<audio id="${hit.id}" class="clip" src="${hit.path}" data-start="${s3(hit.at)}" data-duration="${s3(hit.duration)}" data-track-index="${lane}" data-volume="${hit.gain.toFixed(3)}"></audio>`,
    );
    lane += 1;
  }

  const fontKeys = Object.keys(preset.fonts).sort();
  const faces = fontKeys.map((key) => {
    const font = preset.fonts[key]!;
    assets.push({ role: "font", path: `assets/${font.file}` });
    return `@font-face { font-family: "${font.family}"; src: url("assets/${font.file}") format("truetype"); font-weight: ${font.weight}; }`;
  });
  assets.sort((a, b) => compareIds(a.path, b.path));

  const { width, height } = preset.frame;
  const shadow = preset.shadow ? " text-shadow: 0 2px 12px rgba(0, 0, 0, 0.5);" : "";
  const html = `<!doctype html>
<html lang="en" data-resolution="portrait">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${width}, height=${height}" />
    <script src="${preset.gsap}"></script>
    <style>
      ${faces.join("\n      ")}
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #000; }
      .full { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      #words { position: absolute; inset: 0; }
      .tx { position: absolute; line-height: 1; white-space: nowrap;${shadow} }
      #words .tx { opacity: 0; }
      .t-dim { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.62); opacity: 0; }
      .t-panel { position: absolute; left: 0; top: ${PANEL_TOP}px; width: ${width}px; height: ${height - PANEL_TOP}px; background: #121212; }
      .t-card { position: absolute; inset: 0; background: rgba(8, 8, 8, 0.9); opacity: 0; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${s3(total)}" data-width="${width}" data-height="${height}">
${body.map((line) => `      ${line}`).join("\n")}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
${js.map((line) => `      ${line}`).join("\n")}
      window.__timelines = window.__timelines || {};
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
  return { html, assets, checks, layout };
}
