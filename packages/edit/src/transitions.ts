import type { TextBox } from "./engine-space.ts";
import type { Measurer } from "./measure.ts";
import { textLines } from "./lines.ts";
import { type FontKey, type Preset, type PresetTransition, SHOWN_FLOOR_SECONDS } from "./preset.ts";
import type { Anchor, Edit } from "./schema.ts";
import { type ResolvedItem, anchorAt, resolveAnchor } from "./timeline.ts";
import type { Word } from "./transcript.ts";
import { STYLES } from "./variants.ts";

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

// A LIST's layer comes in as its phrase's first word starts: it starts
// `kind.seconds` (its entrance) before that word, so the entrance is finished
// as the word is spoken, never before 0. Its out-fade runs over the
// `kind.seconds` after the phrase's last word's end (the span ends one fade
// past the last word), so the phrase is at full opacity for all of its spoken
// time; no hold and no minimum, and no other text moves or cuts it. Only a
// phrase with no length at all is lengthened, to the shown floor from its
// first word (earlier where the reel ends); a reel under the floor gives null.
// The out-fade is clipped where the reel ends.
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
  let start = ms(Math.max(0, first.start - seconds));
  const spokenEnd = ms(Math.min(last.end, reelEnd));
  let end = ms(Math.min(spokenEnd + seconds, reelEnd));
  let lengthened = false;
  if (spokenEnd - ms(first.start) <= SLACK) {
    lengthened = true;
    end = ms(Math.min(reelEnd, first.start + floor));
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
      : !lengthened && Math.abs(end - (spokenEnd + seconds)) < 0.0005
        ? { word: last.id, edge: "end", offset: seconds }
        : anchorAt(end, words);
  return { start, end, seconds, lengthened, startAnchor, endAnchor };
}

// The captions a text component's layer or overlay hides: a caption is left
// out only while the component is on screen. A caption whose words a transition
// with levels shows (`hidden_by`, set by the engine per stretch of its own
// words) is left out, and so is a stored caption in a list's phrase with no
// `hidden_by` whose start falls inside the layer (a version made before
// `hidden_by` named the list). Captions hidden by an accent or a big word
// carry `hidden_by` too.
export function hiddenCaptionIds(
  edit: Edit,
  resolved: ReadonlyMap<string, ResolvedItem>,
): Set<string> {
  const layers = edit.tracks.transitions.flatMap((item) => {
    const span = resolved.get(item.id);
    return item.levels && span ? [{ words: new Set(item.words ?? []), span }] : [];
  });
  return new Set(
    edit.tracks.captions
      .filter((caption) => {
        if (caption.hidden_by !== undefined) return true;
        const span = resolved.get(caption.id);
        return (
          span !== undefined &&
          layers.some(
            (layer) =>
              layer.words.has(caption.words[0]!) &&
              span.start >= layer.span.start - SLACK &&
              span.start < layer.span.end - SLACK,
          )
        );
      })
      .map((caption) => caption.id),
  );
}

export type LevelRole = "number" | "lead" | "key";
const LEVEL_ROLES = ["number", "lead", "key"] as const satisfies readonly LevelRole[];

// A level's font and colour, from the style roles: the lead-in is caption
// text, the key phrase and the number accent text. The sizes are the engine's
// (the stack's entry in `variants.ts`: the styles' bases and the number's
// ratio to the key), written on each level.
export function levelStyle(role: LevelRole): { font: FontKey; color: string } {
  const style = role === "lead" ? STYLES.caption : STYLES.accent;
  return { font: style.font, color: style.color };
}

// Every transition's levels as text boxes, in frame pixels, each shown from
// its own start until its layer leaves. Ids are `<transition>-<role>`.
export function levelBoxes(
  edit: Edit,
  resolved: ReadonlyMap<string, ResolvedItem>,
  words: ReadonlyMap<string, Word>,
  preset: Preset,
  measurer: Measurer,
): (TextBox & { transitionId: string; role: LevelRole; reveal: number })[] {
  const out: (TextBox & { transitionId: string; role: LevelRole; reveal: number })[] = [];
  for (const item of edit.tracks.transitions) {
    if (!item.levels) continue;
    const span = resolved.get(item.id)!;
    for (const role of LEVEL_ROLES) {
      const level = item.levels[role];
      if (!level) continue;
      const { font, color } = levelStyle(role);
      const lines = textLines(level.text, level.breaks);
      const width = Math.max(...lines.map((line) => measurer.width(font, level.size, line)));
      const { x, y, align } = level.position;
      const left = align === "left" ? x : align === "right" ? x - width : x - width / 2;
      const start = Math.min(
        span.end,
        Math.max(span.start, resolveAnchor(level.start, words, edit.duration)),
      );
      // The level's spoken end: the key phrase's to its last word's end, the
      // lead-in's to the key phrase's first word. Its reveal finishes by then,
      // so a short phrase is at full opacity while it is spoken.
      const lastWord = words.get(item.words!.at(-1)!)!;
      const keyStart = item.levels?.key
        ? resolveAnchor(item.levels.key.start, words, edit.duration)
        : undefined;
      const spokenEnd = role === "lead" && keyStart !== undefined ? keyStart : lastWord.end;
      const reveal = Math.max(0, Math.min(preset.caption.inSeconds, spokenEnd - start));
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
        reveal,
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
