import { z } from "zod";
import type { ComponentName } from "./component-defs/names.ts";
import type { AnswerContext } from "./component-defs/answer.ts";
import { COMPONENT_LIST } from "./component-defs/index.ts";
import type { EngineNote } from "./engine-note.ts";
import { placeEdit } from "./engine.ts";
import { pickVariants } from "./variant-picker.ts";
import type { EngineInput, WordFix } from "./engine-input.ts";
import { QUESTION_PREFIX } from "./question.ts";
import { SAFE_ZONE } from "./engine-zones.ts";
import type { HeadTrack } from "./head-track.ts";
import type { Measurer } from "./measure.ts";
import { type EditPhoto, photoIdsOf } from "./photos.ts";
import { type Preset, wordsText } from "./preset.ts";
import { type Edit, issueReasons, parseEdit } from "./schema.ts";
import type { Transcript } from "./transcript.ts";

// The hook's own call answer lives with its component (`component-defs/hook.ts`).
export {
  hookAnswerSchemaFor,
  hookJsonSchema,
  parseHookAnswer,
  stripHookStop,
} from "./component-defs/hook.ts";

// No count cap on any list here: how many of each the editor picks is its
// choice. A limit is added only when a real case shows the need, derived from
// that case.

// The order the components' rules run in (null: none), so the reasons come back in the order they
// always have (the retry message sends them to the AI): accents, questions, visuals, lists, big
// words. A component with no rank does not compile.
const VALIDATION_RANK = {
  HOOK: null,
  ACCENT: 0,
  QUESTION: 1,
  VISUAL: 2,
  LIST: 3,
  BIGWORD: 4,
  CAPTION: null,
} satisfies Record<ComponentName, number | null>;

// The decide step's answer, meaning only ("B strict"): Claude names words by
// their transcript ids, never a time, a position, a size or a spot. It is the
// layout engine's input (`EngineInput`): one list per component that has an
// `answer` (`component-defs/`: `accents`, `questions`, `big_words`, `visuals`,
// `lists`, in the order of `COMPONENTS`), then `word_fixes`. Each component
// brings its own schema and its own extra rules (`validate`); the answer's
// refinement (dropped from the JSON Schema) runs them in order and then
// refuses a word fixed twice. The written hook is not in it: its own call
// answers it (`hookAnswerSchemaFor`), and the decide step puts the text beside
// these components when it places them. Built per reel from its transcript.
export function decideAnswerSchemaFor(
  preset: Preset,
  transcript: Transcript,
): z.ZodType<DecideAnswer> {
  const ids = transcript.words.map((word) => word.id);
  const context: AnswerContext = {
    preset,
    ids,
    order: new Map(ids.map((id, index) => [id, index])),
    words: new Map(transcript.words.map((word) => [word.id, word])),
    wordId: ids.length > 0 ? z.enum(ids as [string, ...string[]]) : z.never(),
  };
  const shape: Record<string, z.ZodType> = {};
  for (const component of COMPONENT_LIST) {
    if (component.answer) shape[component.answer.field] = component.answer.schema(context);
  }
  shape.word_fixes = z.array(
    z.strictObject({ word: context.wordId, text: z.string().min(1).max(60) }),
  );
  return z.strictObject(shape).superRefine((answer, ctx) => {
    const ranked = COMPONENT_LIST.filter((component) => VALIDATION_RANK[component.name] !== null);
    ranked.sort((a, b) => VALIDATION_RANK[a.name]! - VALIDATION_RANK[b.name]!);
    for (const component of ranked) {
      if (!component.answer) continue;
      for (const problem of component.validate(
        answer[component.answer.field] as unknown[],
        context,
      )) {
        ctx.addIssue({ code: "custom", ...problem });
      }
    }
    const fixed = new Set<string>();
    for (const fix of answer.word_fixes as WordFix[]) {
      if (fixed.has(fix.word)) {
        ctx.addIssue({
          code: "custom",
          path: ["word_fixes"],
          message: `${fix.word} is fixed twice`,
        });
      }
      fixed.add(fix.word);
    }
    // The cast: the shape is built from the components' fields at run time, so its type is a plain
    // record; each field's own type is checked in its class (`AnswerField`), not here.
  }) as unknown as z.ZodType<DecideAnswer>;
}

// The components' answer (no hook: see `hookAnswerSchemaFor`).
export type DecideAnswer = Omit<EngineInput, "hook">;

// The answer's JSON Schema, the structured output the worker's AI runner asks
// for: real `enum` lists, every object closed (`additionalProperties: false`),
// refs inlined. Draft-07 (kept from the Claude Code CLI, whose validator
// rejected draft 2020-12; the runner leaves the `$schema` line and the length
// bounds out of what it sends, and Zod checks them). The worker doctor's
// `ai structured call` sends this schema in one real call.
export function decideJsonSchema(preset: Preset, transcript: Transcript): Record<string, unknown> {
  return z.toJSONSchema(decideAnswerSchemaFor(preset, transcript), {
    target: "draft-07",
    io: "output",
    reused: "inline",
  }) as Record<string, unknown>;
}

// The answer checked again by Zod, with readable reasons.
export function parseDecideAnswer(
  json: unknown,
  preset: Preset,
  transcript: Transcript,
): { ok: true; answer: DecideAnswer } | { ok: false; reasons: string[] } {
  const result = decideAnswerSchemaFor(preset, transcript).safeParse(json);
  if (!result.success) return { ok: false, reasons: issueReasons(json, result.error.issues) };
  return { ok: true, answer: result.data };
}

// The answer placed over the current version by the layout engine
// (`placeEdit`) as a full edit, parsed with the decide limits and the
// refinement (ids used once, nothing ending before it starts, the behind
// lengths), with the engine's record of what it moved, shrank, wrapped,
// retimed or dropped. Also returned: the answer's extras left out and the
// sentences with room for their kind (the engine's own report, for the trace
// and tests; the worker no longer asks for a second answer on them). The
// current version's masks are not carried over: the worker's cut-out step
// names them again for the new `behind` track. Nor are its library photos:
// `inputs.photos` is written from the placed tracks, so it names exactly the
// photos the new VISUALs show (none for a new answer). `pictures` are the
// photos the owner chose, by VISUAL id, for an answer placed again (a
// relayout): the engine places each such card at its photo's aspect. A parse
// failure here is an engine bug, never the answer's.
export function editFromAnswer(
  current: Edit,
  answer: EngineInput,
  preset: Preset,
  transcript: Transcript,
  headTrack: HeadTrack,
  measurer: Measurer,
  pictures?: ReadonlyMap<string, EditPhoto>,
): { ok: true; edit: Edit; record: EngineNote[] } | { ok: false; reasons: string[] } {
  const inputs = { ...current.inputs };
  delete inputs.masks;
  delete inputs.photos;
  const { tracks, record } = placeEdit(
    current,
    answer,
    pickVariants(answer),
    transcript,
    headTrack,
    preset,
    measurer,
    pictures,
  );
  if (measurer.pair.id !== current.font_pair) {
    throw new Error(
      `editFromAnswer: the edit is set in ${current.font_pair}, measured in ${measurer.pair.id}`,
    );
  }
  const shown = photoIdsOf({ tracks });
  const json = {
    format: 1,
    preset: preset.id,
    font_pair: current.font_pair,
    duration: current.duration,
    inputs: shown.length > 0 ? { ...inputs, photos: shown } : inputs,
    tracks,
  };
  const parsed = parseEdit(json, preset, transcript, {
    duration: current.duration,
    bounds: SAFE_ZONE.box,
    behindLengths: true,
  });
  return parsed.ok ? { ok: true, edit: parsed.edit, record } : parsed;
}

export interface DecideCounts {
  accents: number;
  questions: number;
  transitions: number;
  hook: boolean;
  wordsFixed: number;
  behindVisuals: number;
  behindWords: number;
}

// What the step line names: accent overlays, transitions, whether there is a
// hook, the captions whose text differs from their words, and the behind items.
export function decideCounts(edit: Edit, transcript: Transcript, preset: Preset): DecideCounts {
  const { overlays, transitions, captions } = edit.tracks;
  const behind = edit.tracks.behind ?? [];
  return {
    behindVisuals: behind.filter((item) => item.kind === "visual").length,
    behindWords: behind.filter((item) => item.kind === "word").length,
    accents: overlays.filter(
      (item) => item.kind === "accent" && !item.id.startsWith(QUESTION_PREFIX),
    ).length,
    questions: overlays.filter((item) => item.id.startsWith(QUESTION_PREFIX)).length,
    transitions: transitions.length,
    hook: overlays.some((item) => item.kind === "hook"),
    // The curator's word fixes: a caption text the owner wrote by hand or a
    // transcript correction of hers (both marked in `edit.owner`) is not one.
    wordsFixed: captions.filter(
      (item) =>
        item.text !== undefined &&
        item.text !== wordsText(item.words, transcript, preset) &&
        !(edit.owner?.texts ?? []).includes(item.id),
    ).length,
  };
}

// Whether any item, on any track, sets the free custom-style field.
export function usedFreeField(edit: Edit): boolean {
  const { tracks } = edit;
  return [
    ...tracks.footage,
    ...tracks.captions,
    ...tracks.overlays,
    ...tracks.transitions,
    ...tracks.sounds,
    ...(tracks.behind ?? []),
  ].some((item) => item.style !== undefined && Object.keys(item.style).length > 0);
}
