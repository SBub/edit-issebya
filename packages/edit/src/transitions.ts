import type { TextBox } from "./engine-space.ts";
import type { Measurer } from "./measure.ts";
import { type FontKey, type Preset, type PresetTransition, SHOWN_FLOOR_SECONDS } from "./preset.ts";
import type { Anchor, Edit, TransitionLevel } from "./schema.ts";
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
  // Made longer (or started earlier) to last the shown floor.
  lengthened: boolean;
  startAnchor: Anchor;
  endAnchor: Anchor;
}

// A LIST's layer shows exactly while its phrase is spoken, like a caption: in
// as the phrase's first word starts (its entrance `kind.seconds` long), gone at
// the phrase's last word's end. No minimum and no hold. Only a phrase with no
// length at all is lengthened, to the shown floor (earlier where the reel
// ends); a reel under the floor gives null.
export function transitionTiming(
  choice: { from: string; to: string },
  words: readonly Word[],
  duration: number,
  preset: Preset,
  kind: PresetTransition,
): TransitionTiming | null {
  const floor = SHOWN_FLOOR_SECONDS;
  const first = words.find((word) => word.id === choice.from)!;
  const last = words.find((word) => word.id === choice.to)!;
  const seconds = kind.seconds;
  const reelEnd = ms(duration);
  let start = ms(first.start);
  let end = ms(Math.min(last.end, reelEnd));
  let lengthened = false;
  if (end - start <= SLACK) {
    lengthened = true;
    end = ms(Math.min(reelEnd, start + floor));
    if (end - start < floor - SLACK) {
      start = ms(Math.max(0, end - floor));
    }
    if (end - start < floor - SLACK) return null;
  }
  const startAnchor: Anchor =
    start === 0
      ? { reel: "start" }
      : Math.abs(start - first.start) < 0.0005
        ? { word: first.id }
        : anchorAt(start, words);
  const endAnchor: Anchor =
    end === reelEnd
      ? { reel: "end" }
      : Math.abs(end - last.end) < 0.0005
        ? { word: last.id, edge: "end" }
        : anchorAt(end, words);
  return { start, end, seconds, lengthened, startAnchor, endAnchor };
}

// The captions never shown in their own place: those shown only through a
// transition's levels (their first word is in the phrase of a transition
// carrying levels) and those whose words an accent or a big word shows
// (`hidden_by`).
export function hiddenCaptionIds(edit: Edit): Set<string> {
  const words = new Set(
    edit.tracks.transitions.flatMap((item) => (item.levels ? (item.words ?? []) : [])),
  );
  return new Set(
    edit.tracks.captions
      .filter((caption) => caption.hidden_by !== undefined || words.has(caption.words[0]!))
      .map((c) => c.id),
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
