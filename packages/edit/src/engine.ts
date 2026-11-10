import { clicksFor } from "./clicks.ts";
import {
  type AccentChoice,
  type BigWordChoice,
  type EngineInput,
  type HookChoice,
  QUESTION_PREFIX,
  type TransitionChoice,
  type VisualChoice,
} from "./engine-input.ts";
import {
  type EngineComponent,
  type EngineElement,
  type EngineNote,
  type RecordNote,
  toEngineRecord,
} from "./engine-note.ts";
import {
  type Extra,
  HOOK_ID,
  HOOK_REF,
  type Pass,
  type TransitionPlan,
  type Words,
  accentNoun,
  accentText,
  bigWordText,
  describe,
  placeCaptions,
  placeExtra,
  placeStack,
} from "./engine-elements.ts";
import { type HeadTrack } from "./head-track.ts";
import { wordsText } from "./glossary.ts";
import type { Measurer } from "./measure.ts";
import { type PickedVariants, boxVariantOf, textVariantOf } from "./variant-picker.ts";
import { VISUAL_STAND_INS, timingOf } from "./variants.ts";
import { type Preset, SHOWN_FLOOR_SECONDS } from "./preset.ts";
import {
  type Anchor,
  type BehindItem,
  type CaptionItem,
  type Edit,
  type OverlayItem,
  type TransitionItem,
} from "./schema.ts";
import { anchorAt, resolveAnchor, resolveTimeline } from "./timeline.ts";
import { transitionTiming } from "./transitions.ts";
import { type SentenceSpan, type Transcript, type Word, sentenceSpans } from "./transcript.ts";
import {
  type CaptionBlock,
  SLACK,
  ms,
  at,
  quote,
  during,
  captionGroups,
  floorSpan,
  ownSpan,
  visibleSpan,
  sameTextPass,
  type TextPick,
} from "./engine-timing.ts";
import { type Shown, sceneOf } from "./engine-scene.ts";

// THE LAYOUT ENGINE, the loop. Claude's answer says what and on which words;
// this code decides every time, position, size and line break, with no
// randomness and no I/O (`specs/layout-engine.md`):
//
// 1. Each pick's entry (`variant-picker.ts`) says how it may look and where;
//    the timing options (`engine-timing.ts`) give its span from its words.
//    Same-text picks are trimmed or dropped, captions are split in time
//    (`hidden_by`), and a pick over hidden footage moves to the next visible
//    moment.
// 2. The scene (`engine-scene.ts`): the reel cut at every element edge, each
//    moment with its robust face.
// 3. The placement: components in order of their start time (ties by the
//    answer's order), each through the placer (`engine-place.ts`) over the
//    texts placed before it on screen; then the captions as sentence blocks,
//    last. The element writers (`engine-elements.ts`) write the tracks and the
//    notes. A component with no legal spot is left out (`no-spot`); a pick that
//    trims or drops another, or a left-out one, places the answer again.
// 4. Output: the edit's tracks and the engine record (`engine-note.ts`).
//
// Every decision is written to the record; `placeEdit` is the one entry point.

export type PlacedTracks = Edit["tracks"];

export interface Placement {
  tracks: PlacedTracks;
  record: EngineNote[];
}

// Places every item of an answer over the current version: footage kept,
// captions from the current version's words (each fix as the text of the
// caption showing that word), every other item from its words, and a click
// as each visual and big word comes in. Every pick is placed, an overlap is
// kept and noted, and a text pick whose words another text pick shows is
// trimmed or dropped (`same-text`), the only drop there is.
export function placeEdit(
  current: Edit,
  input: EngineInput,
  // The entry each component's pick was given (`variant-picker.ts`): the placer
  // reads an accent's or a question's; the record names every component's.
  picked: PickedVariants,
  transcript: Transcript,
  headTrack: HeadTrack,
  preset: Preset,
  measurer: Measurer,
): Placement {
  // Each pass places the answer as it stands; a pass that leaves a pick out
  // (no legal spot) or trims or drops one (same-text) is placed again, so the
  // rules hold on the placed times. Every pass removes at least one word from a
  // pick or a pick from the answer, so this ends.
  let answer = input;
  const skip = new Set<string>();
  const notes: RecordNote[] = [];
  // Every pick of any pass by id: a pick the same-text rule drops is in no
  // track, but its note still names its span and component.
  const picks = new Map<string, TextPick>();
  for (;;) {
    const placed = placeOnce(
      current,
      answer,
      picked,
      transcript,
      headTrack,
      preset,
      measurer,
      skip,
    );
    for (const pick of placed.picks) picks.set(pick.id, pick);
    if (placed.noSpot.length > 0) {
      // No legal spot (the spec's "No legal spot"): the element is left out of
      // this version, the answer placed again without it so its words show as
      // captions (rule 3); its `no-spot` note is the one kept from this pass.
      for (const ref of placed.noSpot) skip.add(ref);
      notes.push(
        ...placed.record.filter((note) => "outcome" in note && note.outcome === "no-spot"),
      );
      continue;
    }
    const pass = sameTextPass(placed.picks, answer, transcript, preset);
    if (!pass) {
      const all = [...notes, ...placed.record];
      return {
        tracks: placed.tracks,
        record: engineRecord(current, placed.tracks, all, picks, transcript, picked),
      };
    }
    answer = pass.answer;
    for (const ref of pass.dropped) skip.add(ref);
    notes.push(...pass.notes);
  }
}

// The engine record of a placement: each shown element's span from its track
// (resolved through the transcript), the dropped picks' from their last pass.
function engineRecord(
  current: Edit,
  tracks: PlacedTracks,
  notes: readonly RecordNote[],
  picks: ReadonlyMap<string, TextPick>,
  transcript: Transcript,
  picked: PickedVariants,
): EngineNote[] {
  const timeline = resolveTimeline({ ...current, tracks }, transcript);
  const elements = new Map<string, EngineElement>();
  for (const pick of picks.values()) {
    elements.set(pick.id, { component: pick.component, start: pick.start, end: pick.end });
  }
  const shown: string[] = [];
  const show = (id: string, component: EngineComponent) => {
    const at = timeline.get(id);
    if (!at) throw new Error(`engine record: ${id} has no span`);
    elements.set(id, { component, start: at.start, end: at.end });
    shown.push(id);
  };
  for (const item of tracks.overlays) {
    if (item.id === HOOK_ID) {
      show(item.id, "HOOK");
      continue;
    }
    const pick = picks.get(item.id);
    if (!pick) throw new Error(`engine record: overlay ${item.id} is no pick`);
    show(item.id, pick.component);
  }
  for (const item of tracks.transitions) show(item.id, "LIST");
  for (const item of tracks.behind ?? []) {
    show(item.id, item.kind === "word" ? "BIGWORD" : "VISUAL");
  }
  // A caption a component shows is no element on screen (no `placed` note),
  // but its notes (a retime made before it was hidden) still name its span.
  for (const caption of tracks.captions) {
    const at = timeline.get(caption.id);
    if (!at) throw new Error(`engine record: caption ${caption.id} has no span`);
    elements.set(caption.id, { component: "CAPTION", start: at.start, end: at.end });
    if (caption.hidden_by === undefined) shown.push(caption.id);
  }
  return toEngineRecord(notes, elements, shown, picked);
}

function placeOnce(
  current: Edit,
  input: EngineInput,
  picked: PickedVariants,
  transcript: Transcript,
  headTrack: HeadTrack,
  preset: Preset,
  measurer: Measurer,
  // The refs of picks dropped by the same-text rule or left out for no legal
  // spot: placed as nothing.
  skip: ReadonlySet<string>,
): { tracks: PlacedTracks; record: RecordNote[]; picks: TextPick[]; noSpot: string[] } {
  const record: RecordNote[] = [];
  // The refs of the picks this pass found no legal spot for.
  const noSpot: string[] = [];
  const duration = current.duration;
  const byId = new Map(transcript.words.map((word) => [word.id, word]));
  const word = (id: string) => byId.get(id)!;
  const order = new Map(transcript.words.map((w, index) => [w.id, index]));
  const range = (from: string, to: string) =>
    transcript.words.slice(order.get(from)!, order.get(to)! + 1).map((w) => w.id);
  const sentences = sentenceSpans(transcript);
  const sentenceOf = (id: string): SentenceSpan | undefined => {
    const index = order.get(id)!;
    return sentences.find((s) => order.get(s.from)! <= index && index <= order.get(s.to)!);
  };
  // The words the element writers read (`engine-elements.ts`).
  const words: Words = { transcript, preset, word, range, sentenceOf, order };
  const hidden = current.tracks.footage.flatMap((clip) =>
    (clip.hidden ?? []).map((span) => ({
      start: resolveAnchor(span.start, byId, duration),
      end: resolveAnchor(span.end, byId, duration),
    })),
  );

  // The written hook's window, fixed by the pace (from `fromSeconds` to
  // `untilSeconds`, inside the reel). Nothing said in it cuts it; a hook the
  // placer found no spot for is skipped.
  const hook = skip.has(HOOK_REF) ? null : hookExtra(input.hook ?? null);

  function hookExtra(choice: HookChoice | null): Extra | null {
    if (!choice) return null;
    const spec = preset.pace.hook;
    const text = hookText(choice);
    let start = ms(Math.min(spec.fromSeconds, duration));
    const end = ms(Math.min(duration, spec.untilSeconds));
    // The reel ends too soon after the hook's start, so it shows from earlier,
    // to the reel's end.
    if (end - start < SHOWN_FLOOR_SECONDS - SLACK) {
      start = ms(Math.max(0, end - SHOWN_FLOOR_SECONDS));
      record.push({
        item: HOOK_ID,
        action: "clamped-to-end",
        rule: "hook-time",
        reason: `the hook ${quote(text)} shows from ${at(start)} to ${at(end)}: the reel is too short to start it at ${at(spec.fromSeconds)}`,
      });
    }
    return {
      ref: HOOK_REF,
      kind: "hook",
      id: HOOK_ID,
      start,
      end,
      index: 0,
      hook: { text },
    };
  }

  function transitionText(choice: TransitionChoice): string {
    return wordsText(range(choice.from, choice.to), transcript, preset);
  }

  function timeTransitions(): TransitionPlan[] {
    const kept: TransitionPlan[] = [];
    let index = 0;
    input.lists.forEach((list, listIndex) =>
      list.items.forEach((choice, position) => {
        const flat = index++;
        const ref = `lists[${listIndex}].items[${position}]`;
        if (skip.has(ref)) return;
        const id = `transition-${flat + 1}`;
        const label = `list ${listIndex + 1} item ${position + 1} on ${quote(transitionText(choice))}`;
        const kind = preset.transitions.numbered;
        const timing = transitionTiming(
          { from: choice.from, to: choice.to },
          transcript.words,
          duration,
          preset,
          kind,
        );
        // The layer comes in as its first word starts, its entrance before it,
        // whatever else is on screen then.
        let start = timing?.start ?? 0;
        let end = timing?.end ?? ms(duration);
        const startAnchor: Anchor = timing?.startAnchor ?? { reel: "start" };
        const endAnchor: Anchor = timing?.endAnchor ?? { reel: "end" };
        if (!timing) {
          // The reel is shorter than the shown floor, so the layer covers all of it.
          start = 0;
          end = ms(duration);
          record.push({
            item: id,
            action: "clamped-to-end",
            rule: "transition-time",
            reason: `${label} shows from 0 s to ${at(duration)}: the reel is too short for it to show ${SHOWN_FLOOR_SECONDS} s`,
          });
        } else if (timing.lengthened) {
          record.push({
            item: id,
            action: "retimed",
            rule: "transition-min",
            reason: `${label} shows from ${at(start)} to ${at(end)}, at least ${SHOWN_FLOOR_SECONDS} s`,
          });
        }
        kept.push({
          ref,
          index: flat,
          list: listIndex + 1,
          id,
          label,
          choice,
          start,
          end,
          startAnchor,
          endAnchor,
        });
      }),
    );
    // A list's kept items number 1, 2, ... in reel order (as the speaker goes
    // through them); a list left with one kept item shows no number.
    const itemsOf = new Map<number, TransitionPlan[]>();
    for (const plan of [...kept].sort((a, b) => a.start - b.start)) {
      itemsOf.set(plan.list, [...(itemsOf.get(plan.list) ?? []), plan]);
    }
    const numberOf = new Map<string, number>();
    for (const items of itemsOf.values()) {
      if (items.length > 1) items.forEach((plan, position) => numberOf.set(plan.id, position + 1));
    }
    return kept
      .map((plan) => ({ ...plan, number: numberOf.get(plan.id) }))
      .sort((a, b) => a.start - b.start);
  }

  // The extras' own times. A pick's span is its own: from its start to its
  // last word's end (a big word and a visual from the lead before it, below).
  // A big word comes in the preset's lead before its word, so its entrance has
  // finished as the word is heard; never before the reel.
  const leadStart = (wordStart: number, lead: number) => ms(Math.max(0, wordStart - lead));
  // The start anchor of an item coming in at `at`: its word, plus the offset
  // from the word's start (none for an accent or a question).
  const crossesHidden = (span: { start: number; end: number }) =>
    hidden.some((range) => during(span, range));

  // An ACCENT (`accents[i]`) or a QUESTION (`questions[i]`, `ref`): the same
  // placement, timing and look.
  function accentExtra(
    accent: AccentChoice,
    index: number,
    id: string,
    ref = `accents[${index}]`,
  ): Extra {
    // Exactly while its words are spoken, like a caption: from the first
    // word's start to the last word's end.
    const own = ownSpan(word(accent.from).start, word(accent.to).end, 0, Infinity, duration);
    const span = floorSpan(own.start, own.end, duration);
    if (span.start !== own.start || span.end !== own.end) {
      record.push({
        item: id,
        action: "clamped-to-end",
        rule: "accent-time",
        reason: `${accentNoun(accent)} ${quote(accentText(words, accent))} shows from ${at(span.start)} to ${at(span.end)}: its words take no time, so it shows the shown floor`,
      });
    }
    return { ref, kind: "accent", id, start: span.start, end: span.end, index, accent };
  }

  // A big word: from the lead before its first word to its last word's end, at
  // least the accent's minimum (the spec's `words` with `lead` and `minimum`).
  // Its time comes from its words alone: no other text moves or cuts it.
  function bigWordExtra(choice: BigWordChoice, index: number, id: string): Extra {
    const ref = `big_words[${index}]`;
    // Its entry's timing: the lead before its first word, at least the minimum.
    const { lead, minimum } = timingOf(textVariantOf(picked, "BIGWORD"), "words-lead");
    // Timed from its first word to its last (the same word for one word).
    const first = word(choice.from);
    const last = word(choice.to);
    const own = ownSpan(leadStart(first.start, lead), last.end, minimum, Infinity, duration);
    let start = own.start;
    let end = own.end;
    const text = bigWordText(words, choice.from, choice.to);
    if (end - start < SHOWN_FLOOR_SECONDS - SLACK) {
      // Too close to the reel's end, so it shows from earlier.
      start = ms(Math.max(0, end - SHOWN_FLOOR_SECONDS));
      record.push({
        item: id,
        action: "clamped-to-end",
        rule: "big-word-time",
        reason: `the big word ${quote(text)} shows from ${at(start)} to ${at(end)}: the reel ends too soon to start it at its word`,
      });
    }
    if (crossesHidden({ start, end })) {
      const moved = visibleSpan({ start, end }, hidden, duration);
      if (moved) {
        record.push({
          item: id,
          action: "moved-off-cut",
          rule: "hidden-footage",
          reason: `the big word ${quote(text)} would show while the footage is hidden: it shows from ${at(moved.start)} to ${at(moved.end)}, the next visible moment`,
        });
        ({ start, end } = moved);
      }
    }
    return {
      ref,
      kind: "big_word",
      id,
      start,
      end,
      index,
      word: first.id,
      wordTo: last.id,
    };
  }

  function visualExtra(visual: VisualChoice, index: number, id: string): Extra {
    const { minimum: minSeconds, maximum: maxSeconds } = timingOf(
      boxVariantOf(picked),
      "words-min-max",
    );
    const ref = `visuals[${index}]`;
    const sentence = sentenceOf(visual.from)!;
    // From the visual's first word, so it shows over its own words.
    const first = word(visual.from);
    let { start, end } = ownSpan(
      first.start,
      word(visual.to).end,
      minSeconds,
      maxSeconds,
      duration,
    );
    start = ms(start);
    end = ms(end);
    if (end - start < SHOWN_FLOOR_SECONDS - SLACK) {
      // Too close to the reel's end, so it shows from earlier.
      start = ms(Math.max(0, end - SHOWN_FLOOR_SECONDS));
      record.push({
        item: id,
        action: "clamped-to-end",
        rule: "visual-time",
        reason: `visual ${index + 1} shows from ${at(start)} to ${at(end)}: the reel ends too soon to start it at its sentence`,
      });
    }
    if (crossesHidden({ start, end })) {
      const moved = visibleSpan({ start, end }, hidden, duration);
      if (moved) {
        record.push({
          item: id,
          action: "moved-off-cut",
          rule: "hidden-footage",
          reason: `visual ${index + 1} would show while the footage is hidden: it shows from ${at(moved.start)} to ${at(moved.end)}, the next visible moment`,
        });
        ({ start, end } = moved);
      }
    }
    if (start < Math.min(sentence.start, first.start) - SLACK) {
      record.push({
        item: id,
        action: "retimed",
        rule: "visual-time",
        reason: `visual ${index + 1} starts at ${at(start)}, before its short sentence, to show ${minSeconds} s`,
      });
    }
    return { ref, kind: "visual", id, start, end, index, visual };
  }

  const extras: Extra[] = hook ? [hook] : [];
  // Ids follow the answer's positions, so a pick the same-text rule drops
  // leaves the others' ids as they are.
  input.accents.forEach((accent, index) => {
    if (skip.has(`accents[${index}]`)) return;
    extras.push(accentExtra(accent, index, `accent-${index + 1}`));
  });
  // A QUESTION: an accent placed the same way, under its own id (`question-N`).
  const { questions } = input;
  questions.forEach((question, index) => {
    if (skip.has(`questions[${index}]`)) return;
    const accent = { ...question, question: true };
    extras.push(
      accentExtra(accent, index, `${QUESTION_PREFIX}${index + 1}`, `questions[${index}]`),
    );
  });
  input.big_words.forEach((choice, index) => {
    if (skip.has(`big_words[${index}]`)) return;
    extras.push(bigWordExtra(choice, index, bigWordId(index)));
  });
  // The VISUALs' stand-in pictures: the Nth in start-time order (ties by the
  // answer's order) shows image N mod 3 (`VISUAL_STAND_INS`), so a reel's
  // pictures follow its speech.
  const visualExtras = input.visuals.map((visual, index) =>
    visualExtra(visual, index, `visual-${index + 1}`),
  );
  [...visualExtras]
    .sort((a, b) => a.start - b.start || a.index - b.index)
    .forEach((extra, rank) => {
      extra.image = VISUAL_STAND_INS[rank % VISUAL_STAND_INS.length];
    });
  extras.push(...visualExtras);

  // Transitions, timed from their words (their entrance before the first word).
  const transitionPlans = timeTransitions();

  // A component's place in the answer order, the tie-break when two start at
  // the same moment: the hook, then the accents, the questions, the big words,
  // the visuals, the lists (spec decision 8).
  const rankOf = (extra: Extra) =>
    extra.kind === "hook"
      ? 0
      : extra.kind === "accent"
        ? extra.accent!.question
          ? 2
          : 1
        : extra.kind === "big_word"
          ? 3
          : 4;
  const LIST_RANK = 5;

  // The captions: the current version's, split in time where a text on screen
  // shows their words. A caption's words that a text shows (an accent, a big
  // word, a list's phrase) are left out only while that text is on screen: a
  // run of words that all are is one caption `hidden_by` that text, and the
  // other runs stay captions of their own (a cut list's later words show as
  // captions). A split caption's pieces get the caption's id, then `-2`, `-3`.
  const fixes = new Map(input.word_fixes.map((fix) => [fix.word, fix.text]));
  const onScreen = [
    ...extras.flatMap((extra) =>
      extra.kind === "accent" || extra.kind === "big_word"
        ? [
            {
              id: extra.id,
              start: extra.start,
              end: extra.end,
              words: new Set(
                extra.kind === "accent"
                  ? range(extra.accent!.from, extra.accent!.to)
                  : range(extra.word!, extra.wordTo!),
              ),
            },
          ]
        : [],
    ),
    ...transitionPlans.map((plan) => ({
      id: plan.id,
      start: plan.start,
      end: plan.end,
      words: new Set(range(plan.choice.from, plan.choice.to)),
    })),
  ];
  // The text on screen over a word in its own time, if any.
  const coveredBy = (id: string): string | undefined => {
    const spoken = byId.get(id)!;
    return onScreen.find((text) => text.words.has(id) && during(text, spoken))?.id;
  };
  function splitCaption(caption: CaptionItem): CaptionItem[] {
    const runs: { by: string | undefined; words: string[] }[] = [];
    for (const id of caption.words) {
      const by = coveredBy(id);
      const last = runs.at(-1);
      if (last && last.by === by) last.words.push(id);
      else runs.push({ by, words: [id] });
    }
    return runs.map((run, index) => ({
      ...caption,
      ...(index === 0 ? {} : { id: `${caption.id}-${index + 1}` }),
      words: run.words,
      ...(index === 0 ? {} : { start: { word: run.words[0]!, edge: "start" as const } }),
      ...(index === runs.length - 1
        ? {}
        : { end: { word: run.words.at(-1)!, edge: "end" as const } }),
      ...(run.by !== undefined ? { hidden_by: run.by } : {}),
    }));
  }
  const captions = current.tracks.captions
    .flatMap((caption) => {
      const rest: CaptionItem = { ...caption };
      delete rest.text;
      delete rest.position;
      delete rest.size;
      delete rest.breaks;
      delete rest.hidden_by;
      return splitCaption(rest);
    })
    .map((caption) => {
      const fixed = caption.words.filter((id) => fixes.has(id)).map((id) => fixes.get(id)!);
      return fixed.length > 0 ? { ...caption, text: fixed.join(" ") } : caption;
    });
  const texts = captions.map(
    (caption) => caption.text ?? wordsText(caption.words, transcript, preset),
  );
  const { groups, ends } = captionGroups(captions, texts, transcript, duration, preset, record);
  const unitEnd = new Map<number, number>();
  const unitEndWord = new Map<number, Word>();
  groups.forEach((group, index) => {
    for (const unit of group) {
      unitEnd.set(unit.index, ends[index]!);
      unitEndWord.set(unit.index, group.at(-1)!.lastWord);
    }
  });

  // The scene: every edge of every item.
  const scene = sceneOf(
    [
      ...captions.map((_, index) => unitStart(index)),
      ...ends,
      ...transitionPlans.flatMap((plan) => [plan.start, plan.end]),
      ...extras.flatMap((extra) => [extra.start, extra.end]),
    ],
    duration,
    headTrack,
  );
  function unitStart(index: number): number {
    return resolveAnchor(captions[index]!.start, byId, duration);
  }
  const shown: Shown[] = [];
  const transitionItems = new Map<string, { index: number; item: TransitionItem }>();

  // Captions: blocks in time order, each a sentence's groups (one spot for the
  // whole sentence); a transition's own captions show only as its levels.
  const blocks: CaptionBlock[] = [];
  const sentenceBlocks = new Map<SentenceSpan | undefined, CaptionBlock>();
  groups.forEach((group, index) => {
    const end = ends[index]!;
    // A caption a text shows while it is on screen (`hidden_by`) has no place
    // of its own: the captions left in a group are placed, and only they take
    // room in the block.
    const outside = group.filter((unit) => unit.caption.hidden_by === undefined);
    if (outside.length === 0) return;
    const sentence = sentenceOf(outside[0]!.caption.words[0]!);
    let block = sentenceBlocks.get(sentence);
    if (!block) {
      block = { groups: [], start: outside[0]!.start, end };
      sentenceBlocks.set(sentence, block);
      blocks.push(block);
    }
    block.groups.push(outside);
    block.end = Math.max(block.end, end);
  });
  blocks.sort((a, b) => a.start - b.start);

  const placedCaptions = new Map<number, { x: number; y: number; size: number }>();

  const overlays = new Map<string, OverlayItem>();
  const behind = new Map<string, BehindItem>();

  // The components in order of their start time, ties by the answer's order
  // (`rankOf`, the lists last), each avoiding the ones placed before it that
  // share a moment with it. The captions come last, in the space the
  // components leave.
  // What the element writers read and write (`engine-elements.ts`).
  const pass: Pass = {
    ...words,
    picked,
    measurer,
    headTrack,
    duration,
    record,
    shown,
    scene,
    overlays,
    behind,
    transitionItems,
    placedCaptions,
    captions,
    texts,
    fixes,
    unitEnd,
  };
  const components = [
    ...extras.map((extra) => ({
      start: extra.start,
      rank: rankOf(extra) * 1000 + extra.index,
      place: () => {
        if (!placeExtra(pass, extra)) noSpot.push(extra.ref);
      },
    })),
    ...transitionPlans.map((plan) => ({
      start: plan.start,
      rank: LIST_RANK * 1000 + plan.index,
      place: () => {
        if (!placeStack(pass, plan)) noSpot.push(plan.ref);
      },
    })),
  ].sort((a, b) => a.start - b.start || a.rank - b.rank);
  for (const component of components) component.place();
  for (const block of blocks) placeCaptions(pass, block);

  // The tracks, in the current version's caption order and the answer's order.
  // A caption a text shows while it is on screen has no place of its own.
  const outCaptions: CaptionItem[] = captions.map((caption, index) => {
    const lastWord = unitEndWord.get(index)!;
    const end = unitEnd.get(index)!;
    const offset = ms(end - lastWord.end);
    const endAnchor: Anchor =
      offset === 0
        ? { word: lastWord.id, edge: "end" }
        : { word: lastWord.id, edge: "end", offset };
    const place = placedCaptions.get(index);
    if (caption.hidden_by !== undefined) return { ...caption, end: endAnchor };
    if (!place) return { ...caption, end: endAnchor };
    return {
      ...caption,
      end: endAnchor,
      position: { x: place.x, y: place.y, align: "left" },
      size: place.size,
    };
  });
  const outOverlays: OverlayItem[] = [];
  const hookItem = overlays.get(HOOK_ID);
  if (hookItem) outOverlays.push(hookItem);
  for (const extra of extras) {
    if (extra.kind !== "accent") continue;
    const item = overlays.get(extra.id);
    if (!item) continue;
    const from = byId.get((item.start as { word: string }).word)!;
    outOverlays.push({
      ...item,
      end: anchorAt(
        extra.end,
        transcript.words.filter((w) => w.start >= from.start),
      ),
    });
  }
  const outBehind: BehindItem[] = [];
  for (const extra of extras) {
    if (extra.kind === "accent" || extra.kind === "hook") continue;
    const item = behind.get(extra.id);
    if (!item) continue;
    const start = resolveAnchor(item.start, byId, duration);
    outBehind.push({
      ...item,
      end: anchorAt(
        extra.end,
        transcript.words.filter((w) => w.start >= start),
      ),
    });
  }
  // Pictures before the big words, each kind as the answer lists them.
  outBehind.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "word" ? 1 : -1));

  // The sounds: a click as each placed visual and big word comes in
  // (`clicks.ts`); the current version's sounds are never kept.
  const outSounds = clicksFor(
    outBehind,
    (item) => resolveAnchor(item.start, byId, duration),
    preset,
  );

  const picks: TextPick[] = [
    ...extras.flatMap((extra) =>
      extra.kind === "accent" || extra.kind === "big_word"
        ? [
            {
              id: extra.id,
              ref: extra.ref,
              name: describe(words, extra),
              component:
                extra.kind === "big_word"
                  ? ("BIGWORD" as const)
                  : extra.accent!.question
                    ? ("QUESTION" as const)
                    : ("ACCENT" as const),
              start: extra.start,
              end: extra.end,
              rank: rankOf(extra) * 1000 + extra.index,
              big: extra.kind === "big_word",
              words:
                extra.kind === "accent"
                  ? range(extra.accent!.from, extra.accent!.to)
                  : range(extra.word!, extra.wordTo!),
            },
          ]
        : [],
    ),
    ...transitionPlans.map((plan) => ({
      id: plan.id,
      ref: plan.ref,
      name: plan.label,
      component: "LIST" as const,
      start: plan.start,
      end: plan.end,
      rank: 4000 + plan.index,
      big: false,
      words: range(plan.choice.from, plan.choice.to),
    })),
  ];

  return {
    picks,
    noSpot,
    tracks: {
      footage: current.tracks.footage,
      captions: outCaptions,
      overlays: outOverlays,
      transitions: [...transitionItems.values()]
        .sort((a, b) => a.index - b.index)
        .map(({ item }) => item),
      sounds: outSounds,
      ...(outBehind.length > 0 ? { behind: outBehind } : {}),
    },
    record,
  };
}

// The hook's text as shown: one space between words.
function hookText(choice: HookChoice): string {
  return choice.text.trim().split(/\s+/).join(" ");
}

// A big word's item id by its place in the answer: `big-word-1`, ...
function bigWordId(index: number): string {
  return `big-word-${index + 1}`;
}
