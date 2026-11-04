import { wordsText } from "./layout.ts";
import { type Preset, type TransitionKind, cleanWord } from "./preset.ts";
import type { Anchor, Edit } from "./schema.ts";
import { resolveTimeline } from "./timeline.ts";
import type { Transcript } from "./transcript.ts";

// THE LAYOUT ENGINE'S INPUT. Claude (the decide step) answers in meaning only:
// which words are accents, which word is the big word behind, which library
// photo belongs to which words, which phrase a transition carries, which
// misheard words to fix. Everything refers to the transcript by word id; there
// are no times, positions, sizes or spots. A `wish` is a placement word the
// owner used in a request, forwarded from this fixed list; never invented.
// The layout engine (`engine.ts`, `placeEdit`) turns it into placed tracks.

export const WISHES = [
  "top",
  "bottom",
  "left",
  "right",
  "behind",
  "beside_head",
  "big",
  "small",
  // Transitions only (the engine records `wish-not-kept` on another kind):
  // the motion slower, the layer staying longer after its phrase.
  "slow",
  "long",
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

// A transition carries the phrase `from` to `to`; its key phrase (in accent
// text) starts on `key_from`, the words before it are the lead-in.
export interface TransitionChoice {
  kind: TransitionKind;
  from: string;
  to: string;
  key_from: string;
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

// The ids from `from` to `to`, in transcript order.
function range(from: string, to: string, transcript: Transcript): string[] {
  const ids = transcript.words.map((word) => word.id);
  return ids.slice(ids.indexOf(from), ids.indexOf(to) + 1);
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
    // A stored `card` reads back as a `dim`, the library's nearest kind.
    const kind = transition.type === "card" ? "dim" : transition.type;
    if (transition.words) {
      const wish =
        transition.pace === "slow" ? "slow" : transition.hold === "long" ? "long" : undefined;
      transitions.push({
        kind,
        ...ends(transition.words),
        key_from: transition.key ?? transition.words[0]!,
        ...(wish ? { wish } : {}),
      });
      continue;
    }
    const ids = under(transition);
    if (ids.length > 0) transitions.push({ kind, ...ends(ids), key_from: ids[0]! });
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
