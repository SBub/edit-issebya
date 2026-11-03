import { spotFaceShare } from "./behind.ts";
import { type HeadTrack, faceBox } from "./head-track.ts";
import { wordsText } from "./layout.ts";
import {
  BEHIND_SPOTS,
  type BehindSpot,
  type Preset,
  type TransitionType,
  cleanWord,
} from "./preset.ts";
import type { Anchor, BehindItem, Edit } from "./schema.ts";
import { resolveTimeline } from "./timeline.ts";
import { type Transcript, type Word, sentenceSpans } from "./transcript.ts";

// THE LAYOUT ENGINE'S INPUT. Claude (the decide step) answers in meaning only:
// which words are accents, which word is the big word behind, which library
// photo belongs to which words, which phrase a transition carries, which
// misheard words to fix. Everything refers to the transcript by word id; there
// are no times, positions, sizes or spots. A `wish` is a placement word the
// owner used in a request, forwarded from this fixed list; never invented.
//
// `placeDirect` below is a stand-in placement: the simplest direct mapping of
// this input onto the existing edit format and layout code, so the studio
// keeps producing versions until the layout engine replaces it. It solves no
// free space and handles no overlap; the checks still refuse what does not fit.

export const WISHES = [
  "top",
  "bottom",
  "left",
  "right",
  "behind",
  "beside_head",
  "big",
  "small",
] as const;
export type Wish = (typeof WISHES)[number];

export interface AccentChoice {
  from: string;
  to: string;
  title: boolean;
  wish?: Wish;
}

export interface BigWordChoice {
  word: string;
  wish?: Wish;
}

export interface PhotoChoice {
  photo_id: string;
  from: string;
  to: string;
  wish?: Wish;
}

export interface TransitionChoice {
  kind: TransitionType;
  from: string;
  to: string;
  wish?: Wish;
}

// The caption showing `word` shows `text` instead (a misheard word fixed).
export interface WordFix {
  word: string;
  text: string;
}

export interface EngineInput {
  accents: AccentChoice[];
  big_word: BigWordChoice | null;
  photos: PhotoChoice[];
  transitions: TransitionChoice[];
  word_fixes: WordFix[];
}

type PlacedTracks = Omit<Edit["tracks"], "cutout">;

function ms(seconds: number): number {
  const rounded = Math.round(seconds * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
}

// The ids from `from` to `to`, in transcript order.
function range(from: string, to: string, transcript: Transcript): string[] {
  const ids = transcript.words.map((word) => word.id);
  return ids.slice(ids.indexOf(from), ids.indexOf(to) + 1);
}

// An anchor at `t`: the nearest word end within a second (with the offset),
// else the time itself.
function anchorAt(t: number, words: readonly Word[]): Anchor {
  let best: Word | null = null;
  for (const word of words) {
    if (Math.abs(t - word.end) > 1) continue;
    if (!best || Math.abs(t - word.end) < Math.abs(t - best.end)) best = word;
  }
  if (!best) return { time: ms(t) };
  const offset = ms(t - best.end);
  return offset === 0 ? { word: best.id, edge: "end" } : { word: best.id, edge: "end", offset };
}

// A behind item from its first word to `wanted` (the end of its words or its
// sentence), held to the preset's 2 to 4 seconds and the reel.
function behindSpan(
  first: Word,
  wanted: number,
  transcript: Transcript,
  preset: Preset,
  duration: number,
): { start: Anchor; end: Anchor; startTime: number; endTime: number } {
  const { minSeconds, maxSeconds } = preset.behind;
  const end = Math.min(
    duration,
    Math.max(first.start + minSeconds, Math.min(first.start + maxSeconds, wanted)),
  );
  const after = transcript.words.filter((word) => word.start >= first.start);
  return {
    start: { word: first.id },
    end: anchorAt(end, after),
    startTime: first.start,
    endTime: end,
  };
}

// The edit's tracks for an engine input, over the current version: footage
// and sounds kept, captions kept with the fixes applied, every other item made
// from its words. A photo takes its wished spot, else the spot it had, else
// the first spot, when the face over its span leaves that spot clear.
export function placeDirect(
  current: Edit,
  input: EngineInput,
  transcript: Transcript,
  headTrack: HeadTrack,
  preset: Preset,
): PlacedTracks {
  const byId = new Map(transcript.words.map((word) => [word.id, word]));
  const word = (id: string) => byId.get(id)!;
  const fixes = new Map(input.word_fixes.map((fix) => [fix.word, fix.text]));

  const captions = current.tracks.captions.map((caption) => {
    const rest = { ...caption };
    delete rest.text;
    const fixed = caption.words.filter((id) => fixes.has(id)).map((id) => fixes.get(id)!);
    return fixed.length > 0 ? { ...rest, text: fixed.join(" ") } : rest;
  });

  let accentCount = 0;
  const overlays = input.accents.map((accent) => ({
    id: accent.title ? "title" : `accent-${++accentCount}`,
    kind: "accent" as const,
    start: { word: accent.from },
    end: { word: accent.to, edge: "end" as const },
    words: range(accent.from, accent.to, transcript),
  }));

  const transitions = input.transitions.map((transition, index) => ({
    id: `transition-${index + 1}`,
    type: transition.kind,
    start: { word: transition.from },
    end: { word: transition.to, edge: "end" as const },
  }));

  const currentSpots = new Map(
    (current.tracks.behind ?? [])
      .filter((item) => item.kind === "photo")
      .map((item) => [`${item.photo_id} ${JSON.stringify(item.start)}`, item.spot]),
  );
  const behind: BehindItem[] = input.photos.map((photo, index) => {
    const span = behindSpan(
      word(photo.from),
      word(photo.to).end,
      transcript,
      preset,
      current.duration,
    );
    const face = faceBox(headTrack, span.startTime, span.endTime, { left: 0, right: 0 });
    const wished = BEHIND_SPOTS.find((spot) => spot === photo.wish);
    const kept = currentSpots.get(`${photo.photo_id} ${JSON.stringify(span.start)}`);
    const order: BehindSpot[] = [
      ...new Set([...(wished ? [wished] : []), ...(kept ? [kept] : []), ...BEHIND_SPOTS]),
    ];
    const clear = order.find(
      (spot) => spotFaceShare(spot, face, preset) <= preset.behind.maxFaceShare,
    );
    return {
      id: `photo-${index + 1}`,
      kind: "photo",
      photo_id: photo.photo_id,
      spot: clear ?? order[0]!,
      start: span.start,
      end: span.end,
    };
  });
  if (input.big_word) {
    const first = word(input.big_word.word);
    const sentence = sentenceSpans(transcript).find(
      (s) => first.start >= s.start && first.end <= s.end,
    );
    const span = behindSpan(
      first,
      sentence?.end ?? first.end,
      transcript,
      preset,
      current.duration,
    );
    behind.push({
      id: "big-word",
      kind: "word",
      text: cleanWord(first.text, preset),
      start: span.start,
      end: span.end,
    });
  }

  return {
    footage: current.tracks.footage,
    captions,
    overlays,
    transitions,
    sounds: current.tracks.sounds,
    ...(behind.length > 0 ? { behind } : {}),
  };
}

// The current version's choices in the engine input's terms (what Claude is
// shown and starts from): each item by the words under it. An accent without
// words (an older version's written title) becomes the words spoken while it
// shows; an item no word is spoken under is left out.
export function choicesOf(edit: Edit, transcript: Transcript, preset: Preset): EngineInput {
  const resolved = resolveTimeline(edit, transcript);
  // The words under an item: from its start word to its end word when it is
  // anchored on words, else the words spoken while it shows.
  const under = (item: { id: string; start: Anchor; end: Anchor }): string[] => {
    const span = resolved.get(item.id)!;
    const spoken = transcript.words
      .filter((word) => word.start < span.end && word.end > span.start)
      .map((word) => word.id);
    const from = "word" in item.start ? item.start.word : spoken[0];
    const to = "word" in item.end ? item.end.word : spoken.at(-1);
    return from === undefined || to === undefined ? [] : range(from, to, transcript);
  };
  const ends = (ids: readonly string[]) => ({ from: ids[0]!, to: ids.at(-1)! });

  const accents: AccentChoice[] = [];
  for (const overlay of edit.tracks.overlays) {
    const ids = overlay.words ?? under(overlay);
    if (ids.length > 0) accents.push({ ...ends(ids), title: overlay.id === "title" });
  }
  const transitions: TransitionChoice[] = [];
  for (const transition of edit.tracks.transitions) {
    const ids = under(transition);
    if (ids.length > 0) transitions.push({ kind: transition.type, ...ends(ids) });
  }
  const photos: PhotoChoice[] = [];
  let bigWord: BigWordChoice | null = null;
  const byId = new Map(transcript.words.map((word) => [word.id, word]));
  for (const item of edit.tracks.behind ?? []) {
    const ids = under(item);
    if (ids.length === 0) continue;
    if (item.kind === "photo") {
      photos.push({ photo_id: item.photo_id, ...ends(ids) });
    } else if (!bigWord) {
      const said = ids.find(
        (id) => cleanWord(byId.get(id)!.text, preset).toLowerCase() === item.text.toLowerCase(),
      );
      bigWord = { word: said ?? ids[0]! };
    }
  }
  const word_fixes: WordFix[] = [];
  for (const caption of edit.tracks.captions) {
    if (
      caption.text !== undefined &&
      caption.text !== wordsText(caption.words, transcript, preset)
    ) {
      word_fixes.push({ word: caption.words[0]!, text: caption.text });
    }
  }
  return { accents, big_word: bigWord, photos, transitions, word_fixes };
}
