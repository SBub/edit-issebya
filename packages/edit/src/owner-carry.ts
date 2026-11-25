import { build } from "./build.ts";
import { type CaptionBlock, captionBlocks } from "./caption-blocks.ts";
import type { PlacedComponent } from "./components.ts";
import { componentOfOverlay } from "./component-defs/index.ts";
import type { EngineComponent, EngineNote } from "./engine-note.ts";
import type { HeadTrack } from "./head-track.ts";
import type { Measurer } from "./measure.ts";
import {
  type OwnerMove,
  applyOwnerMoves,
  breaksFor,
  settleOwnerMove,
  withoutBreaks,
  wrapToWidth,
} from "./owner-edit.ts";
import { levelMark } from "./owner-marks.ts";
import { applyOwnerTexts } from "./owner-text.ts";
import type { Preset } from "./preset.ts";
import { isQuestion } from "./question.ts";
import type { Edit } from "./schema.ts";
import type { Transcript } from "./transcript.ts";
import { STYLES } from "./variants.ts";

// CARRYING THE OWNER'S WORK (app_docs/owner-edits.md, "What later steps do
// with an owner's version"): a font pair change places the version's AI
// answer again, and must not lose what the owner did by hand. The version the
// owner worked on names it (`edit.owner`, `owner-marks.ts`): the texts the
// owner wrote and the items the owner placed. Each is carried onto the new
// placement, found by its id (the same answer gives the same item ids):
// - a text of an accent, a question, a big word, a list or the hook: written
//   on the element again and wrapped inside its box in the new font;
// - a place: the owner's box keeps its top and its centre line (a question
//   its left edge) and its text size, its lines set again to the owner's box
//   width in the new font; a box that no longer fits the safe zone is moved in
//   or made smaller the least it must, and noted, never dropped. A caption
//   block is found by its sentence (the block showing most of the same
//   spoken words).
// A caption's text is not carried from the version: it is a transcript
// correction of the reel (`owner-corrections.ts`), which the placement
// already holds, marks included. A Start over carries none of this: the AI
// answers afresh, and only the corrections and the cards the owner added go
// with it.

// The record's rule and entry name of a carry note.
export const OWNER_CARRY_RULE = "owner-edit";
const OWNER_CARRY_VARIANT = "owner/carried";

export interface OwnerCarry {
  edit: Edit;
  // One note per edit that was not kept, or was kept but moved in or made
  // smaller to fit: for the version's engine record.
  notes: EngineNote[];
  kept: number;
  dropped: number;
}

interface Context {
  transcript: Transcript;
  headTrack: HeadTrack;
  preset: Preset;
  // The pair the owner's version is set in, and the new placement's.
  fromMeasurer: Measurer;
  measurer: Measurer;
}

const quote = (text: string): string => `"${text.length > 40 ? `${text.slice(0, 39)}…` : text}"`;

type Overlay = Edit["tracks"]["overlays"][number];
type Behind = NonNullable<Edit["tracks"]["behind"]>[number];
type Transition = Edit["tracks"]["transitions"][number];

// The element of the new placement that stands for one of the owner's
// version: the same id and kind (the hook: the hook).
function overlayIn(to: Edit, item: Overlay): Overlay | undefined {
  return to.tracks.overlays.find(
    (entry) =>
      entry.kind === item.kind &&
      isQuestion(entry) === isQuestion(item) &&
      (item.kind === "hook" || entry.id === item.id),
  );
}

function behindIn(to: Edit, item: Behind): Behind | undefined {
  return (to.tracks.behind ?? []).find((entry) => entry.kind === item.kind && entry.id === item.id);
}

function listIn(to: Edit, item: Transition): Transition | undefined {
  return to.tracks.transitions.find((entry) => entry.id === item.id);
}

// The spoken words a caption block shows, in order.
function blockWords(edit: Edit, block: CaptionBlock): string[] {
  const byId = new Map(edit.tracks.captions.map((item) => [item.id, item]));
  return block.groups.flatMap((group) => group.captions.flatMap((id) => byId.get(id)!.words));
}

export function carryOwnerEdits(from: Edit, placed: Edit, context: Context): OwnerCarry {
  const { transcript, headTrack, preset, measurer, fromMeasurer } = context;
  const marks = from.owner;
  // The new placement holds only the marks of the corrections it was placed
  // with; each carried edit marks it again.
  let edit = placed;
  if (!marks || marks.placed.length + marks.texts.length === 0) {
    return { edit, notes: [], kept: 0, dropped: 0 };
  }
  const to = { transcript, headTrack, preset, measurer };
  const components = (of: Edit, by: Measurer): PlacedComponent[] =>
    build(of, transcript, headTrack, preset, by, { layer: "front" }).components;
  const fromComponents = components(from, fromMeasurer);
  const fromBox = (id: string) => fromComponents.find((component) => component.id === id);
  const notes: EngineNote[] = [];
  let kept = 0;
  let dropped = 0;
  const note = (
    item: string,
    component: EngineComponent,
    outcome: "dropped" | "moved" | "shrunk",
    reason: string,
    span?: { start: number; end: number },
  ) => {
    notes.push({
      item,
      component,
      variant: OWNER_CARRY_VARIANT,
      start: span?.start ?? 0,
      end: span?.end ?? 0,
      rule: OWNER_CARRY_RULE,
      outcome,
      blockers: [],
      reason,
    });
  };
  const drop = (
    item: string,
    component: EngineComponent,
    what: string,
    why: string,
    span?: { start: number; end: number },
  ) => {
    dropped += 1;
    note(item, component, "dropped", `your ${what} could not be kept: ${why}`, span);
  };
  const kindOf = (item: Overlay): EngineComponent => componentOfOverlay(item);

  // 1. The texts the owner wrote.
  const text = (
    id: string,
    part: string | undefined,
    value: string,
    component: EngineComponent,
    fromId: string,
  ) => {
    const applied = applyOwnerTexts(
      edit,
      [part === undefined ? { id, text: value } : { id, part, text: value }],
      { ...to, carried: true },
    );
    if (applied.ok) {
      edit = applied.edit;
      kept += 1;
    } else {
      drop(fromId, component, `text ${quote(value)}`, applied.reasons.join("; "), fromBox(fromId));
    }
  };
  const fromCaptions = new Map(from.tracks.captions.map((item) => [item.id, item]));
  for (const mark of marks.texts) {
    // A caption's text is the reel's correction, already on the placement.
    if (fromCaptions.has(mark)) continue;
    const overlay = from.tracks.overlays.find((item) => item.id === mark);
    if (overlay) {
      if (overlay.text === undefined) continue;
      const now = overlayIn(edit, overlay);
      // The same text already (a hook the new answer wrote the same): nothing to carry.
      if (now && now.text === overlay.text) continue;
      if (now) text(now.id, undefined, overlay.text, kindOf(overlay), overlay.id);
      else {
        drop(
          overlay.id,
          kindOf(overlay),
          `text ${quote(overlay.text)}`,
          `the new version has no ${kindOf(overlay).toLowerCase()} on the same words`,
          fromBox(overlay.id),
        );
      }
      continue;
    }
    const word = (from.tracks.behind ?? []).find((item) => item.id === mark);
    if (word?.kind === "word") {
      const now = behindIn(edit, word);
      if (now) text(now.id, undefined, word.text, "BIGWORD", word.id);
      else {
        drop(
          word.id,
          "BIGWORD",
          `text ${quote(word.text)}`,
          "the new version has no big word on the same words",
          fromBox(word.id),
        );
      }
      continue;
    }
    for (const role of ["lead", "key"] as const) {
      const list = from.tracks.transitions.find((item) => levelMark(item.id, role) === mark);
      const level = list?.levels?.[role];
      if (!list || !level) continue;
      const now = listIn(edit, list);
      if (now?.levels?.[role]) text(now.id, role, level.text, "LIST", list.id);
      else {
        drop(
          list.id,
          "LIST",
          `text ${quote(level.text)}`,
          "the new version has no list item on the same words",
          fromBox(list.id),
        );
      }
    }
  }
  // 2. The places: each box where the owner put it, at the owner's size.
  const place = (
    id: string,
    fromId: string,
    component: EngineComponent,
    options: { wrap: boolean; left: boolean },
  ) => {
    const was = fromBox(fromId);
    if (!was || was.size === null) return;
    // The owner's box width sets the lines again only when it gives the
    // owner's own lines back in the owner's font (a list or a caption block
    // can hold a level or a group on more lines than its width needs: the
    // engine's choice, which the new placement makes again).
    const again = options.wrap
      ? applyOwnerMoves(
          from,
          [{ id: fromId, x: was.x, y: was.y, size: was.size, width: was.width + 0.5 }],
          { transcript, preset, measurer: fromMeasurer },
        )
      : null;
    const back = again?.ok
      ? components(again.edit, fromMeasurer).find((entry) => entry.id === fromId)
      : undefined;
    const wrap =
      back !== undefined &&
      Math.abs(back.width - was.width) < 0.5 &&
      Math.abs(back.height - was.height) < 0.5;
    const asked = (x: number): OwnerMove =>
      wrap
        ? { id, x, y: was.y, size: was.size!, width: was.width + 0.5 }
        : { id, x, y: was.y, size: was.size! };
    // The box the owner's size and width give in the new font, then its
    // centre line put back where the owner had it.
    const first = applyOwnerMoves(edit, [asked(was.x)], to);
    const now = first.ok
      ? components(first.edit, measurer).find((entry) => entry.id === id)
      : undefined;
    const x = !now || options.left ? was.x : was.x + was.width / 2 - now.width / 2;
    const settled = settleOwnerMove(edit, asked(x), to);
    if (!settled.ok) {
      drop(
        fromId,
        component,
        "placement",
        `it no longer fits the safe zone, so it stays where the layout put it (${settled.reasons.join("; ")})`,
        was,
      );
      return;
    }
    edit = settled.edit;
    kept += 1;
    const move = settled.move;
    if (move.kind === "box") return;
    const shrunk = move.size < was.size;
    if (shrunk || Math.abs(move.x - x) >= 1 || Math.abs(move.y - was.y) >= 1) {
      note(
        id,
        component,
        shrunk ? "shrunk" : "moved",
        shrunk
          ? `your placement no longer fits the safe zone in this font at ${was.size} px: kept at ${move.size} px, inside the safe zone`
          : "your placement runs past the safe zone in this font: moved inside it by the least it must",
        was,
      );
    }
  };
  const placedCaptions = new Set(marks.placed.filter((id) => fromCaptions.has(id)));
  for (const mark of marks.placed) {
    if (fromCaptions.has(mark)) continue;
    const overlay = from.tracks.overlays.find((item) => item.id === mark);
    if (overlay) {
      const now = overlayIn(edit, overlay);
      if (now) {
        place(now.id, overlay.id, kindOf(overlay), { wrap: true, left: isQuestion(overlay) });
      } else {
        drop(
          overlay.id,
          kindOf(overlay),
          "placement",
          `the new version has no ${kindOf(overlay).toLowerCase()} on the same words`,
          fromBox(overlay.id),
        );
      }
      continue;
    }
    const list = from.tracks.transitions.find((item) => item.id === mark);
    if (list) {
      const now = listIn(edit, list);
      if (now?.levels) place(now.id, list.id, "LIST", { wrap: true, left: false });
      else {
        drop(
          list.id,
          "LIST",
          "placement",
          "the new version has no list item on the same words",
          fromBox(list.id),
        );
      }
      continue;
    }
    const behind = (from.tracks.behind ?? []).find((item) => item.id === mark);
    if (!behind) continue;
    const now = behindIn(edit, behind);
    if (!now) {
      drop(
        behind.id,
        behind.kind === "word" ? "BIGWORD" : "VISUAL",
        "placement",
        `the new version has no ${behind.kind === "word" ? "big word" : "visual"} on the same words`,
        fromBox(behind.id),
      );
      continue;
    }
    if (behind.kind === "word" && now.kind === "word") {
      // The owner's lines: the text set again to the owner's box width.
      const was = fromBox(behind.id);
      if (was && was.size !== null && now.text.includes(" ")) {
        const lines = wrapToWidth(
          now.text,
          STYLES.bigWord.font,
          was.size,
          was.width + 0.5,
          measurer,
        );
        edit = {
          ...edit,
          tracks: {
            ...edit.tracks,
            behind: edit.tracks.behind!.map((item) =>
              item.id === now.id && item.kind === "word"
                ? { ...withoutBreaks(item), ...breaksFor(lines) }
                : item,
            ),
          },
        };
      }
      place(now.id, behind.id, "BIGWORD", { wrap: false, left: false });
      continue;
    }
    if (behind.kind === "visual" && now.kind === "visual") {
      // A card does not depend on the font: its box and its turn as they were.
      const settled = settleOwnerMove(
        edit,
        {
          id: now.id,
          kind: "box",
          x: behind.box.x,
          y: behind.box.y,
          width: behind.box.width,
          rotation: behind.rotation ?? 0,
        },
        to,
      );
      if (settled.ok) {
        edit = settled.edit;
        kept += 1;
      } else {
        drop(behind.id, "VISUAL", "placement", settled.reasons.join("; "), fromBox(behind.id));
      }
    }
  }
  // A caption block the owner placed: found by its spoken words.
  if (placedCaptions.size > 0) {
    for (const block of captionBlocks(from, transcript)) {
      if (!block.groups.some((group) => group.captions.some((id) => placedCaptions.has(id)))) {
        continue;
      }
      // The sentence's block in the new placement: the one showing most of
      // the same spoken words (another answer can show more or fewer of a
      // sentence's words as captions).
      const words = new Set(blockWords(from, block));
      const shared = (entry: CaptionBlock) =>
        blockWords(edit, entry).filter((word) => words.has(word)).length;
      const now = captionBlocks(edit, transcript)
        .filter((entry) => shared(entry) > 0)
        .sort((a, b) => shared(b) - shared(a))[0];
      if (now) place(now.id, block.id, "CAPTION", { wrap: true, left: false });
      else {
        drop(
          block.id,
          "CAPTION",
          "caption placement",
          "the new version shows no captions of the same sentence",
          fromBox(block.id),
        );
      }
    }
  }
  return { edit, notes, kept, dropped };
}
