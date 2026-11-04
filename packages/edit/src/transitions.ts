import type { TextBox } from "./layout.ts";
import type { Measurer } from "./measure.ts";
import type { FontKey, Preset, PresetTransition } from "./preset.ts";
import type { Anchor, Edit, TransitionItem, TransitionLevel } from "./schema.ts";
import { type ResolvedItem, anchorAt, resolveAnchor } from "./timeline.ts";
import type { Word } from "./transcript.ts";

// TRANSITIONS tied to a phrase: their timing from the words, the captions
// they show as their own text levels, the levels' style and the layer's
// background from the style roles. Pure helpers shared by the layout engine
// and the builder.

function ms(seconds: number): number {
  const rounded = Math.round(seconds * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
}

const SLACK = 1e-6;

export interface TransitionTiming {
  // The layer's span: in from `start`, gone at `end`.
  start: number;
  end: number;
  // How long the layer takes to come in and to go out.
  seconds: number;
  // Made longer (or started earlier) to last the preset's minimum.
  lengthened: boolean;
  startAnchor: Anchor;
  endAnchor: Anchor;
}

// The layer's entrance finishes as the phrase's first word starts; it has
// left when the word after the phrase starts, holding at most `holdSeconds`
// (`longHoldSeconds` with the wish `long`) after the phrase's last word. Under
// `minSeconds` it leaves later (within the reel), then comes in earlier (from
// the reel's start); still under, it is too short: null.
export function transitionTiming(
  choice: { from: string; to: string; wish?: string },
  words: readonly Word[],
  duration: number,
  preset: Preset,
  kind: PresetTransition,
): TransitionTiming | null {
  const { transition } = preset;
  const index = new Map(words.map((word, at) => [word.id, at]));
  const first = words[index.get(choice.from)!]!;
  const lastAt = index.get(choice.to)!;
  const last = words[lastAt]!;
  const next = words[lastAt + 1];
  const seconds = ms(kind.seconds * (choice.wish === "slow" ? transition.slowFactor : 1));
  const hold = choice.wish === "long" ? transition.longHoldSeconds : transition.holdSeconds;
  const reelEnd = ms(duration);
  let start = ms(Math.max(0, first.start - seconds));
  let end = ms(Math.min(next?.start ?? reelEnd, last.end + hold, reelEnd));
  let lengthened = false;
  if (end - start < transition.minSeconds - SLACK) {
    lengthened = true;
    end = ms(Math.min(reelEnd, start + transition.minSeconds));
    if (end - start < transition.minSeconds - SLACK) {
      start = ms(Math.max(0, end - transition.minSeconds));
    }
    if (end - start < transition.minSeconds - SLACK) return null;
  }
  const startAnchor: Anchor =
    start === 0
      ? { reel: "start" }
      : Math.abs(start - (first.start - seconds)) < 0.0005
        ? { word: first.id, offset: -seconds }
        : anchorAt(start, words);
  const endAnchor: Anchor =
    end === reelEnd
      ? { reel: "end" }
      : next && Math.abs(end - next.start) < 0.0005
        ? { word: next.id }
        : anchorAt(end, words);
  return { start, end, seconds, lengthened, startAnchor, endAnchor };
}

// How long a transition item's layer takes to come in and go out.
export function motionSeconds(item: TransitionItem, preset: Preset): number {
  const { seconds } = preset.transitions[item.type];
  return item.pace === "slow" ? ms(seconds * preset.transition.slowFactor) : seconds;
}

// The captions shown only through a transition's levels: those whose first
// word is in the phrase of a transition carrying levels.
export function hiddenCaptionIds(edit: Edit): Set<string> {
  const words = new Set(
    edit.tracks.transitions.flatMap((item) => (item.levels ? (item.words ?? []) : [])),
  );
  return new Set(
    edit.tracks.captions.filter((caption) => words.has(caption.words[0]!)).map((c) => c.id),
  );
}

export type LevelRole = "number" | "lead" | "key";
const LEVEL_ROLES = ["number", "lead", "key"] as const satisfies readonly LevelRole[];

// A level's font, full size and colour, from the style roles: the lead-in is
// caption text, the key phrase and the number accent text.
export function levelStyle(
  role: LevelRole,
  preset: Preset,
): { font: FontKey; size: number; color: string } {
  if (role === "lead") {
    const font = preset.caption.font;
    return { font, size: preset.fonts[font].size, color: preset.caption.color };
  }
  const font = preset.accent.font;
  const size =
    role === "number"
      ? (preset.transitions.numbered.numberSize ?? preset.fonts[font].size)
      : preset.fonts[font].size;
  return { font, size, color: preset.accent.color };
}

// The layer's background: the item's own colour, else the background role at
// the kind's shade (the role itself when the shade is 1).
export function transitionBackground(
  kind: PresetTransition,
  preset: Preset,
  color?: string,
): string {
  if (color) return color;
  if (kind.shade >= 1) return preset.background;
  const hex = preset.background.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${kind.shade})`;
}

// A level's lines: split after `break_after` words when set.
function levelLines(level: Pick<TransitionLevel, "text" | "break_after">): string[] {
  const words = level.text.split(" ");
  const cut = level.break_after;
  if (cut === undefined || cut >= words.length) return [level.text];
  return [words.slice(0, cut).join(" "), words.slice(cut).join(" ")];
}

// Every transition's levels as text boxes, in frame pixels, each shown from
// its own start until its layer leaves. Ids are `<transition>-<role>`.
export function levelBoxes(
  edit: Edit,
  resolved: ReadonlyMap<string, ResolvedItem>,
  words: ReadonlyMap<string, Word>,
  preset: Preset,
  measurer: Measurer,
): (TextBox & { transitionId: string; role: LevelRole })[] {
  const out: (TextBox & { transitionId: string; role: LevelRole })[] = [];
  for (const item of edit.tracks.transitions) {
    if (!item.levels) continue;
    const span = resolved.get(item.id)!;
    for (const role of LEVEL_ROLES) {
      const level = item.levels[role];
      if (!level) continue;
      const { font, color } = levelStyle(role, preset);
      const lines = levelLines(level);
      const width = Math.max(...lines.map((line) => measurer.width(font, level.size, line)));
      const { x, y, align } = level.position;
      const left = align === "left" ? x : align === "right" ? x - width : x - width / 2;
      const start = Math.min(
        span.end,
        Math.max(span.start, resolveAnchor(level.start, words, edit.duration)),
      );
      out.push({
        itemId: `${item.id}-${role}`,
        transitionId: item.id,
        role,
        kind: "level",
        text: level.text,
        lines,
        font,
        size: level.size,
        color,
        shadow: undefined,
        style: undefined,
        start,
        end: span.end,
        x: left,
        y,
        width,
        height: level.size * lines.length,
      });
    }
  }
  return out;
}
